import type { InputMessage } from "../rtc/messages";

// Captures pointer, touch and keyboard input over the remote-screen element and forwards it as
// InputMessages. Coordinates are always normalized to 0..1 against the element's rendered box —
// the host maps that back onto its own real resolution, so nothing here depends on knowing what
// the remote screen's size is, and nothing breaks when it changes mid-session.
//
// Touch is not "mouse events that happen to come from a finger". A finger has no hover, no
// buttons, no scroll wheel, and covers roughly 40 pixels of whatever it's pointing at. So touch
// gets its own gesture layer on top:
//
//   tap                 left click
//   long press (500ms)  right click
//   double-tap + drag   click and drag (hold left button through the drag)
//   two-finger drag     scroll
//
// and a choice of two pointer modes, because neither one is right for everything:
//
//   direct     your finger is the cursor. Fast for tapping big targets, hopeless for small ones,
//              since your fingertip hides what you're aiming at.
//   trackpad   the screen is a trackpad and the cursor moves relative to your drag, like a
//              laptop. Slower, but it's the only way to hit a 12-pixel close button on a phone.

export type PointerMode = "direct" | "trackpad";

const LONG_PRESS_MS = 500;
const TAP_SLOP_PX = 10;
const DOUBLE_TAP_MS = 300;
/** Multiplier on finger travel in trackpad mode. Above 1 so the cursor can cross a 1080p desktop
 *  without three swipes, but low enough to still land on small targets. */
const TRACKPAD_SENSITIVITY = 1.6;
/** A two-finger drag of this many CSS pixels equals one wheel notch. Tuned against the host's
 *  120-units-per-notch conversion so a flick scrolls about a screenful. */
const TOUCH_SCROLL_DIVISOR = 2;

interface TouchPoint {
  x: number;
  y: number;
  startX: number;
  startY: number;
  startedAt: number;
  moved: boolean;
}

export class InputCapture {
  private target: HTMLElement;
  private send: (msg: InputMessage) => void;

  private keyboardActive = false;
  private mouseActive = false;
  private keyboardLocked = false;
  private pointerMode: PointerMode = "direct";
  /** Game mode: cursor position stops meaning anything and every pointermove instead reports a
   *  raw movement delta via the Pointer Lock API, which is what most games actually read for
   *  camera/aim look — the regular absolute mousemove above is invisible to that input path
   *  regardless of how correct the coordinates are, since games bypass cursor position entirely. */
  private relativeMouseMode = false;

  /** Where the host's cursor is, as far as this client knows: 0..1, both axes. Only meaningful in
   *  trackpad mode, where there's no finger position to read it off. */
  private cursor = { x: 0.5, y: 0.5 };
  private touches = new Map<number, TouchPoint>();
  private longPressTimer: number | null = null;
  private lastTapAt = 0;
  private dragHeld = false;
  private twoFingerLast: { x: number; y: number } | null = null;

  /** Tracks which keys are currently down so a lost keyup can be cleaned up instead of leaving a
   *  key stuck held on the host forever. */
  private heldKeys = new Set<string>();

  /** Fired whenever the virtual cursor moves, so the UI can draw it in trackpad mode — otherwise
   *  you'd be dragging an invisible pointer around and guessing. */
  onCursorMove: ((x: number, y: number) => void) | null = null;
  /** Fired when relative/game mode actually turns on or off — including when the browser force-
   *  exits pointer lock on its own (Escape, losing focus, an OS-level dialog), which the UI needs
   *  to know about since nothing else would tell it game mode silently stopped. */
  onRelativeModeChange: ((active: boolean) => void) | null = null;
  /** Fired for the toolbar/sideboard toggle hotkey (see onKeyDown) — checked and consumed before
   *  the key would otherwise be forwarded as game input, since with keyboard capture active there
   *  is no other way to reach the UI once a game has captured the pointer via game mode. */
  onToggleOverlay: (() => void) | null = null;

  constructor(target: HTMLElement, send: (msg: InputMessage) => void) {
    this.target = target;
    this.send = send;
  }

  start(): void {
    this.setMouseCapture(true);
  }

  stop(): void {
    this.setMouseCapture(false);
    this.setKeyboardCapture(false);
    this.clearLongPress();
    this.touches.clear();
  }

  setPointerMode(mode: PointerMode): void {
    this.pointerMode = mode;
  }

  getPointerMode(): PointerMode {
    return this.pointerMode;
  }

  isRelativeMouseMode(): boolean {
    return this.relativeMouseMode;
  }

  /** Requests (or exits) Pointer Lock on the target element. This must be called from directly
   *  inside a user gesture (a click handler) — browsers refuse requestPointerLock() otherwise —
   *  so the sideboard's "Game mode" toggle button satisfies that just by being a button. */
  async setRelativeMouseMode(enabled: boolean): Promise<void> {
    if (enabled === this.relativeMouseMode) return;
    if (enabled) {
      try {
        await this.target.requestPointerLock();
        // onPointerLockChange (below) flips relativeMouseMode + fires onRelativeModeChange once
        // the browser actually grants it — not here, since a request can be silently refused.
      } catch {
        // Refused (no gesture, disallowed in this context, etc.) — stay in absolute mode.
      }
    } else if (document.pointerLockElement === this.target) {
      document.exitPointerLock();
    }
  }

  private onPointerLockChange = () => {
    const active = document.pointerLockElement === this.target;
    if (active === this.relativeMouseMode) return;
    this.relativeMouseMode = active;
    this.onRelativeModeChange?.(active);
  };

  getCursor(): { x: number; y: number } {
    return { ...this.cursor };
  }

  // -------------------------------------------------------------------------------------------
  // Mouse / pointer
  // -------------------------------------------------------------------------------------------

  /** Lets "view only" mode keep rendering the remote screen without forwarding input — toggled
   *  independently of stop() so it can be flipped mid-session without recreating this object. */
  setMouseCapture(active: boolean): void {
    if (active === this.mouseActive) return;
    this.mouseActive = active;
    if (active) {
      this.target.addEventListener("pointermove", this.onPointerMove);
      this.target.addEventListener("pointerdown", this.onPointerDown);
      this.target.addEventListener("pointerup", this.onPointerUp);
      this.target.addEventListener("pointercancel", this.onPointerCancel);
      this.target.addEventListener("wheel", this.onWheel, { passive: false });
      this.target.addEventListener("contextmenu", this.onContextMenu);
      document.addEventListener("pointerlockchange", this.onPointerLockChange);
    } else {
      this.target.removeEventListener("pointermove", this.onPointerMove);
      this.target.removeEventListener("pointerdown", this.onPointerDown);
      this.target.removeEventListener("pointerup", this.onPointerUp);
      this.target.removeEventListener("pointercancel", this.onPointerCancel);
      this.target.removeEventListener("wheel", this.onWheel);
      this.target.removeEventListener("contextmenu", this.onContextMenu);
      document.removeEventListener("pointerlockchange", this.onPointerLockChange);
      if (document.pointerLockElement === this.target) document.exitPointerLock();
      this.releaseEverything();
    }
  }

  private normalize(clientX: number, clientY: number): { x: number; y: number } {
    const rect = this.target.getBoundingClientRect();
    return {
      x: clamp01((clientX - rect.left) / rect.width),
      y: clamp01((clientY - rect.top) / rect.height),
    };
  }

  private moveCursorTo(x: number, y: number): void {
    this.cursor = { x, y };
    this.send({ t: "mousemove", x, y });
    this.onCursorMove?.(x, y);
  }

  // The browser's own context menu would otherwise eat the long-press right-click on touch and
  // the right mouse button on desktop, neither of which should ever open a local menu over a
  // remote screen.
  private onContextMenu = (e: Event) => e.preventDefault();

  private onPointerMove = (e: PointerEvent) => {
    if (e.pointerType === "touch") {
      this.onTouchMove(e);
      return;
    }
    if (this.relativeMouseMode) {
      // movementX/Y are already relative to the last event under Pointer Lock, in CSS pixels of
      // this browser's own scale - the host's SendInput call for this path is genuinely relative
      // motion too, so no normalization against the element's size makes sense or is needed here.
      if (e.movementX !== 0 || e.movementY !== 0) {
        this.send({ t: "mousemovedelta", dx: e.movementX, dy: e.movementY });
      }
      return;
    }
    const { x, y } = this.normalize(e.clientX, e.clientY);
    this.cursor = { x, y };
    this.send({ t: "mousemove", x, y });
  };

  private onPointerDown = (e: PointerEvent) => {
    if (e.pointerType === "touch") {
      this.onTouchStart(e);
      return;
    }
    e.preventDefault();
    // Capture so a drag that leaves the video element still delivers its pointerup here —
    // otherwise releasing outside the frame strands the button held down on the host.
    try {
      this.target.setPointerCapture(e.pointerId);
    } catch {
      // Element already released or never captured — harmless.
    }
    // Under Pointer Lock, clientX/Y stay pinned to wherever the cursor was when it locked -
    // sending that as an absolute position on every click would be stale/meaningless, not just
    // redundant with the deltas onPointerMove already sent.
    if (!this.relativeMouseMode) {
      const { x, y } = this.normalize(e.clientX, e.clientY);
      this.cursor = { x, y };
      this.send({ t: "mousemove", x, y });
    }
    this.send({ t: "mousedown", button: e.button });
  };

  private onPointerUp = (e: PointerEvent) => {
    if (e.pointerType === "touch") {
      this.onTouchEnd(e);
      return;
    }
    e.preventDefault();
    this.send({ t: "mouseup", button: e.button });
  };

  private onPointerCancel = (e: PointerEvent) => {
    if (e.pointerType === "touch") this.onTouchEnd(e);
    else this.send({ t: "mouseup", button: e.button });
  };

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    this.send({ t: "wheel", dx: e.deltaX, dy: e.deltaY });
  };

  // -------------------------------------------------------------------------------------------
  // Touch gestures
  // -------------------------------------------------------------------------------------------

  private onTouchStart(e: PointerEvent): void {
    e.preventDefault();
    const point: TouchPoint = {
      x: e.clientX,
      y: e.clientY,
      startX: e.clientX,
      startY: e.clientY,
      startedAt: performance.now(),
      moved: false,
    };
    this.touches.set(e.pointerId, point);

    if (this.touches.size === 2) {
      // A second finger cancels whatever the first was starting — this is a scroll, not a tap.
      this.clearLongPress();
      const [a, b] = [...this.touches.values()];
      this.twoFingerLast = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      return;
    }

    if (this.touches.size > 1) return;

    if (this.pointerMode === "direct") {
      const { x, y } = this.normalize(e.clientX, e.clientY);
      this.moveCursorTo(x, y);
    }

    // A tap that lands within the double-tap window starts a drag instead of a click: press the
    // button now and hold it until the finger lifts. This is how you drag a window or select text
    // on a touchscreen without a second button to hold.
    if (performance.now() - this.lastTapAt < DOUBLE_TAP_MS) {
      this.dragHeld = true;
      this.send({ t: "mousedown", button: 0 });
      return;
    }

    this.longPressTimer = window.setTimeout(() => {
      this.longPressTimer = null;
      const current = this.touches.get(e.pointerId);
      if (!current || current.moved) return;
      this.send({ t: "mousedown", button: 2 });
      this.send({ t: "mouseup", button: 2 });
      // Mark it consumed so the finger lifting doesn't also fire a left click on top.
      current.moved = true;
      navigator.vibrate?.(12);
    }, LONG_PRESS_MS);
  }

  private onTouchMove(e: PointerEvent): void {
    const point = this.touches.get(e.pointerId);
    if (!point) return;

    const dx = e.clientX - point.x;
    const dy = e.clientY - point.y;
    point.x = e.clientX;
    point.y = e.clientY;

    if (Math.abs(e.clientX - point.startX) > TAP_SLOP_PX || Math.abs(e.clientY - point.startY) > TAP_SLOP_PX) {
      if (!point.moved) this.clearLongPress();
      point.moved = true;
    }

    if (this.touches.size >= 2) {
      const [a, b] = [...this.touches.values()];
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      if (this.twoFingerLast) {
        this.send({
          t: "wheel",
          dx: (this.twoFingerLast.x - mid.x) / TOUCH_SCROLL_DIVISOR,
          dy: (this.twoFingerLast.y - mid.y) / TOUCH_SCROLL_DIVISOR,
        });
      }
      this.twoFingerLast = mid;
      return;
    }

    if (this.pointerMode === "direct") {
      const { x, y } = this.normalize(e.clientX, e.clientY);
      this.moveCursorTo(x, y);
    } else {
      const rect = this.target.getBoundingClientRect();
      this.moveCursorTo(
        clamp01(this.cursor.x + (dx * TRACKPAD_SENSITIVITY) / rect.width),
        clamp01(this.cursor.y + (dy * TRACKPAD_SENSITIVITY) / rect.height),
      );
    }
  }

  private onTouchEnd(e: PointerEvent): void {
    const point = this.touches.get(e.pointerId);
    this.touches.delete(e.pointerId);
    if (this.touches.size < 2) this.twoFingerLast = null;
    if (!point) return;

    this.clearLongPress();

    if (this.dragHeld) {
      this.dragHeld = false;
      this.send({ t: "mouseup", button: 0 });
      return;
    }

    const quick = performance.now() - point.startedAt < LONG_PRESS_MS;
    if (!point.moved && quick) {
      this.send({ t: "mousedown", button: 0 });
      this.send({ t: "mouseup", button: 0 });
      this.lastTapAt = performance.now();
    }
  }

  private clearLongPress(): void {
    if (this.longPressTimer !== null) {
      window.clearTimeout(this.longPressTimer);
      this.longPressTimer = null;
    }
  }

  // -------------------------------------------------------------------------------------------
  // Keyboard
  // -------------------------------------------------------------------------------------------

  /** Keyboard capture is opt-in and window-scoped, since browsers don't route key events to
   *  arbitrary elements. Gate it behind an explicit UI action. */
  setKeyboardCapture(active: boolean): void {
    if (active === this.keyboardActive) return;
    this.keyboardActive = active;
    if (active) {
      window.addEventListener("keydown", this.onKeyDown);
      window.addEventListener("keyup", this.onKeyUp);
      window.addEventListener("blur", this.onWindowBlur);
    } else {
      window.removeEventListener("keydown", this.onKeyDown);
      window.removeEventListener("keyup", this.onKeyUp);
      window.removeEventListener("blur", this.onWindowBlur);
      this.onWindowBlur(); // release anything still held so turning capture off can't strand a key
      this.unlockKeyboard();
    }
  }

  isKeyboardCaptured(): boolean {
    return this.keyboardActive;
  }

  /** Ctrl+Alt+Shift+O toggles the sideboard/toolbar without going through the host at all — the
   *  only way to reach them once keyboard capture is on and (especially) once game mode has
   *  locked the pointer, since normal mouse movement no longer reveals anything and every other
   *  key is going straight to the remote game instead of the browser. Picked for being a 4-key
   *  chord essentially no game binds anything to, not any deeper significance to "O". */
  private onKeyDown = (e: KeyboardEvent) => {
    if (!this.keyboardActive) return;

    if (e.code === "KeyO" && e.ctrlKey && e.altKey && e.shiftKey) {
      e.preventDefault();
      this.onToggleOverlay?.();
      return;
    }

    e.preventDefault();
    this.heldKeys.add(e.code);
    this.send({ t: "keydown", code: e.code });
  };

  private onKeyUp = (e: KeyboardEvent) => {
    if (!this.keyboardActive) return;
    e.preventDefault();
    this.heldKeys.delete(e.code);
    this.send({ t: "keyup", code: e.code });
  };

  // Alt+Tab, switching windows, or the browser losing focus mid-keypress all skip the browser's
  // own keyup for whatever was held — without this, the host stays convinced that key is still
  // down (a permanently "held" Alt or Ctrl) until some unrelated key reuses the same code.
  private onWindowBlur = () => {
    for (const code of this.heldKeys) this.send({ t: "keyup", code });
    this.heldKeys.clear();
  };

  private releaseEverything(): void {
    this.onWindowBlur();
    if (this.dragHeld) {
      this.dragHeld = false;
      this.send({ t: "mouseup", button: 0 });
    }
  }

  /** Types a literal string on the host — what the on-screen keyboard path uses, since mobile IMEs
   *  report composed text rather than physical key positions. */
  sendText(text: string): void {
    if (text) this.send({ t: "text", text });
  }

  /** One-shot key press by code, for the sideboard's shortcut buttons. */
  tapKey(code: string, modifiers: string[] = []): void {
    for (const mod of modifiers) this.send({ t: "keydown", code: mod });
    this.send({ t: "keydown", code });
    this.send({ t: "keyup", code });
    for (const mod of [...modifiers].reverse()) this.send({ t: "keyup", code: mod });
  }

  /** Grabs system key combos (Ctrl+W, Alt+Tab, F11…) the browser would otherwise intercept before
   *  JS sees them — the Keyboard Lock API, Chromium-only, and only effective in fullscreen. A
   *  no-op everywhere else rather than an error. */
  async lockKeyboard(): Promise<void> {
    const keyboard = (navigator as Navigator & { keyboard?: { lock(): Promise<void> } }).keyboard;
    if (!keyboard || !document.fullscreenElement) return;
    try {
      await keyboard.lock();
      this.keyboardLocked = true;
    } catch {
      // Unsupported or refused — regular preventDefault capture still handles everything except
      // the handful of combos only Keyboard Lock can intercept.
    }
  }

  unlockKeyboard(): void {
    if (!this.keyboardLocked) return;
    this.keyboardLocked = false;
    (navigator as Navigator & { keyboard?: { unlock(): void } }).keyboard?.unlock();
  }
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}
