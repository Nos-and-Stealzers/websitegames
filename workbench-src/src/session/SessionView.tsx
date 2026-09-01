import { useCallback, useEffect, useRef, useState } from "react";
import { RemoteSession, type SessionState } from "./RemoteSession";
import { ClientPeerConnection, EMPTY_STATS, type SessionStats } from "../rtc/PeerConnection";
import { InputCapture, type PointerMode } from "../input/InputCapture";
import { getSessionSettings, saveSessionSettings, type SessionSettings } from "./sessionSettings";
import { Sideboard } from "./Sideboard";
import { OnScreenKeyboard } from "./OnScreenKeyboard";
import { WORKER_URL } from "../config";
import { Icon } from "../ui/Icon";
import { Spinner } from "../ui/Spinner";
import { useToast } from "../ui/Toasts";
import type { ControlMessage } from "../rtc/messages";

type HostInfo = Extract<ControlMessage, { t: "host-info" }>;
export type HostStats = Extract<ControlMessage, { t: "host-stats" }>;

const STATE_LABEL: Record<SessionState, string> = {
  connecting: "Connecting…",
  authorizing: "Signing you in…",
  "waiting-for-host": "Waiting for host…",
  negotiating: "Negotiating…",
  connected: "Connected",
  reconnecting: "Reconnecting…",
  disconnected: "Disconnected",
  denied: "Access denied",
  offline: "Computer offline",
  error: "Something went wrong",
};

const LOADING_STATES = new Set<SessionState>(["connecting", "authorizing", "waiting-for-host", "negotiating", "reconnecting"]);
const TERMINAL_STATES = new Set<SessionState>(["disconnected", "denied", "offline", "error"]);

export function SessionView({
  hostId,
  name,
  pin,
  onExit,
}: {
  hostId: string;
  name: string;
  pin?: string;
  onExit: () => void;
}) {
  const toast = useToast();

  const [state, setState] = useState<SessionState>("connecting");
  const [detail, setDetail] = useState<string | undefined>();
  const [settings, setSettings] = useState<SessionSettings | null>(null);
  const [hostInfo, setHostInfo] = useState<HostInfo | null>(null);
  const [hostStats, setHostStats] = useState<HostStats | null>(null);
  const [stats, setStats] = useState<SessionStats>(EMPTY_STATS);
  const [sideboardOpen, setSideboardOpen] = useState(false);
  const [keyboardActive, setKeyboardActive] = useState(false);
  const [oskOpen, setOskOpen] = useState(false);
  const [cursorPos, setCursorPos] = useState<{ x: number; y: number } | null>(null);
  const [toolbarVisible, setToolbarVisible] = useState(true);
  const [gameMode, setGameMode] = useState(false);

  const isConnected = state === "connected";

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const sessionRef = useRef<RemoteSession | null>(null);
  const inputCaptureRef = useRef<InputCapture | null>(null);
  const peerConnectionRef = useRef<ClientPeerConnection | null>(null);
  const settingsRef = useRef<SessionSettings | null>(null);
  const autoFullscreenDoneRef = useRef(false);
  const toolbarHideTimer = useRef<number | null>(null);
  // The <video> element only exists in the DOM once `isConnected` is true (see the render
  // below), but the remote track and the "ready" (input channel open) signal both fire earlier,
  // during "negotiating" — well before that element is mounted. Assigning straight to
  // videoRef.current at that point silently no-ops, and nothing ever retries once the real
  // element mounts, leaving the video permanently blank (despite the underlying receiver
  // decoding fine, which is why stats/fps still looked normal) and input capture never
  // initialized. These caches let the mount effect below finish the job once the ref exists.
  const pendingStreamRef = useRef<MediaStream | null>(null);
  const pendingPeerConnectionRef = useRef<ClientPeerConnection | null>(null);

  const attachInputCapture = useCallback((pc: ClientPeerConnection, video: HTMLVideoElement) => {
    if (inputCaptureRef.current) return;
    const capture = new InputCapture(video, (msg) => pc.sendInput(msg));
    capture.onCursorMove = (x, y) => setCursorPos({ x, y });
    capture.onRelativeModeChange = setGameMode;
    // The only way back to the UI once game mode has locked the pointer and every key is going
    // straight to the remote game instead of the browser — see InputCapture's onKeyDown.
    capture.onToggleOverlay = () => setSideboardOpen((v) => !v);
    capture.start();
    const viewOnly = settingsRef.current?.viewOnly ?? false;
    if (settingsRef.current) {
      capture.setPointerMode(settingsRef.current.pointerMode);
      if (viewOnly) capture.setMouseCapture(false);
    }
    // Keyboard capture used to require an explicit toolbar click before typing did anything —
    // matching mouse capture (already active as soon as the input channel opens) is what
    // people actually expect from "connected". Still gated behind view-only, same as mouse.
    if (!viewOnly) {
      capture.setKeyboardCapture(true);
      setKeyboardActive(true);
    }
    inputCaptureRef.current = capture;
  }, []);

  // Finishes attaching the stream/input-capture once the <video> element actually exists in the
  // DOM (it only mounts once `isConnected` is true) - covers the case where the stream or the
  // "ready" signal arrived earlier, during "negotiating", when videoRef.current was still null.
  useEffect(() => {
    if (!isConnected || !videoRef.current) return;
    if (pendingStreamRef.current && videoRef.current.srcObject !== pendingStreamRef.current) {
      videoRef.current.srcObject = pendingStreamRef.current;
    }
    if (pendingPeerConnectionRef.current) {
      attachInputCapture(pendingPeerConnectionRef.current, videoRef.current);
    }
  });

  // ---------------------------------------------------------------------------------------------
  // Session lifecycle
  // ---------------------------------------------------------------------------------------------

  useEffect(() => {
    let cancelled = false;

    getSessionSettings(hostId).then((loaded) => {
      if (cancelled) return;
      settingsRef.current = loaded;
      setSettings(loaded);
    });

    const session = new RemoteSession(WORKER_URL, hostId, pin);
    sessionRef.current = session;

    session.onStateChange = (s, d) => {
      if (cancelled) return;
      setState(s);
      setDetail(d);
    };
    session.onRemoteStream = (stream) => {
      pendingStreamRef.current = stream;
      if (videoRef.current) videoRef.current.srcObject = stream;
    };
    session.onReady = (pc) => {
      peerConnectionRef.current = pc;
      pendingPeerConnectionRef.current = pc;
      if (videoRef.current) attachInputCapture(pc, videoRef.current);
    };
    let lastClipboardText: string | null = null;
    session.onClipboardText = async (text) => {
      // The host already dedupes on its own clipboard content, but this guards the client side
      // too — otherwise any duplicate that slips through re-toasts the same "synced" message.
      if (text === lastClipboardText) return;
      lastClipboardText = text;
      try {
        await navigator.clipboard.writeText(text);
        toast("Clipboard synced from host", "good");
      } catch {
        toast("Host copied something, but this browser blocked auto-paste", "info");
      }
    };
    session.onControlMessage = (msg) => {
      // display-changed needs no handling here: the video element's own "resize" event (wired up
      // below) already recomputes the viewport's aspect ratio whenever the incoming frame size
      // changes, whatever caused that — a monitor switch, a host-side resolution change, or this.
      if (msg.t === "host-info") setHostInfo(msg);
      if (msg.t === "host-stats") setHostStats(msg);
    };
    session.onStats = (s) => setStats(s);

    session.start();

    return () => {
      cancelled = true;
      inputCaptureRef.current?.stop();
      inputCaptureRef.current = null;
      peerConnectionRef.current = null;
      pendingStreamRef.current = null;
      pendingPeerConnectionRef.current = null;
      session.close();
      sessionRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hostId]);

  // ---------------------------------------------------------------------------------------------
  // Settings
  // ---------------------------------------------------------------------------------------------

  const updateSetting = useCallback(
    <K extends keyof SessionSettings>(key: K, value: SessionSettings[K]) => {
      // Applying the new value synchronously (rather than waiting on the IndexedDB round trip
      // below) matters for anything that fires rapidly, like dragging a slider: each drag tick
      // used to kick off its own independent read-modify-write against IndexedDB, and since those
      // resolve in whatever order the browser gets around to them - not necessarily the order the
      // drags happened in - a stale one could land last and snap the displayed value backward,
      // making the slider look stuck. Updating in-memory state immediately and persisting in the
      // background removes that race entirely.
      if (!settingsRef.current) return;
      const next = { ...settingsRef.current, [key]: value };
      settingsRef.current = next;
      setSettings(next);
      void saveSessionSettings(hostId, { [key]: value } as Partial<SessionSettings>);
    },
    [hostId],
  );

  useEffect(() => {
    if (!settings) return;
    inputCaptureRef.current?.setMouseCapture(!settings.viewOnly);
    if (settings.viewOnly && keyboardActive) {
      inputCaptureRef.current?.setKeyboardCapture(false);
      setKeyboardActive(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings?.viewOnly]);

  useEffect(() => {
    if (settings) inputCaptureRef.current?.setPointerMode(settings.pointerMode);
  }, [settings?.pointerMode]);

  useEffect(() => {
    if (
      isConnected &&
      settings?.autoFullscreen &&
      !autoFullscreenDoneRef.current &&
      !document.fullscreenElement
    ) {
      autoFullscreenDoneRef.current = true;
      viewportRef.current?.requestFullscreen().catch(() => {});
    }
  }, [isConnected, settings?.autoFullscreen]);

  // ---------------------------------------------------------------------------------------------
  // Fullscreen / keyboard lock
  // ---------------------------------------------------------------------------------------------

  useEffect(() => {
    const onFullscreenChange = () => {
      const capture = inputCaptureRef.current;
      if (!capture) return;
      if (document.fullscreenElement) {
        capture.setKeyboardCapture(true);
        setKeyboardActive(true);
        void capture.lockKeyboard();
      } else {
        capture.unlockKeyboard();
      }
    };
    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", onFullscreenChange);
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const applyAspectRatio = () => {
      if (video.videoWidth > 0 && video.videoHeight > 0 && viewportRef.current) {
        viewportRef.current.style.aspectRatio = `${video.videoWidth} / ${video.videoHeight}`;
      }
    };
    video.addEventListener("loadedmetadata", applyAspectRatio);
    video.addEventListener("resize", applyAspectRatio);
    return () => {
      video.removeEventListener("loadedmetadata", applyAspectRatio);
      video.removeEventListener("resize", applyAspectRatio);
    };
  }, [state]);

  // Auto-hide the toolbar on touch devices after inactivity, so it doesn't permanently cover the
  // top of the remote screen — tapping anywhere brings it back.
  const nudgeToolbar = useCallback(() => {
    setToolbarVisible(true);
    if (toolbarHideTimer.current) window.clearTimeout(toolbarHideTimer.current);
    toolbarHideTimer.current = window.setTimeout(() => setToolbarVisible(false), 3500);
  }, []);

  useEffect(() => {
    if (!isConnected) return;
    nudgeToolbar();
    return () => {
      if (toolbarHideTimer.current) window.clearTimeout(toolbarHideTimer.current);
    };
  }, [isConnected, nudgeToolbar]);

  // ---------------------------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------------------------

  const toggleKeyboard = useCallback(() => {
    const next = !keyboardActive;
    setKeyboardActive(next);
    inputCaptureRef.current?.setKeyboardCapture(next);
  }, [keyboardActive]);

  const disconnect = useCallback(() => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    onExit();
  }, [onExit]);

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else viewportRef.current?.requestFullscreen().catch(() => {});
  }, []);

  const sendCtrlAltDel = useCallback(() => {
    peerConnectionRef.current?.sendInput({ t: "ctrl-alt-del" });
    toast("Sent Ctrl+Alt+Del — the host needs Software SAS enabled for this to register", "info");
  }, [toast]);

  const sendPrintScreen = useCallback(() => {
    peerConnectionRef.current?.sendInput({ t: "prtscr" });
    toast("Sent Print Screen", "good");
  }, [toast]);

  const sendClipboard = useCallback(async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        sessionRef.current?.sendClipboardText(text);
        toast("Clipboard sent to host", "good");
      }
    } catch {
      toast("Couldn't read your clipboard — check browser permissions", "bad");
    }
  }, [toast]);

  const handlePointerModeChange = useCallback(
    (mode: PointerMode) => {
      inputCaptureRef.current?.setPointerMode(mode);
      updateSetting("pointerMode", mode);
    },
    [updateSetting],
  );

  // Must run from inside the button's own click handler, not an effect — browsers refuse
  // requestPointerLock() outside a direct user-gesture call stack.
  const toggleGameMode = useCallback(() => {
    void inputCaptureRef.current?.setRelativeMouseMode(!gameMode);
  }, [gameMode]);

  const sendOskText = useCallback((text: string) => {
    peerConnectionRef.current?.sendInput({ t: "text", text });
  }, []);

  const sendOskKey = useCallback((code: string) => {
    inputCaptureRef.current?.tapKey(code);
  }, []);

  // ---------------------------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------------------------

  if (!isConnected) {
    return (
      <div className="session-status-screen">
        <button className="link-btn back-btn" onClick={onExit}>
          <Icon name="arrow-left" size={14} />
          Back to dashboard
        </button>

        <div className="session-status-card">
          {LOADING_STATES.has(state) ? (
            <>
              <Spinner size={28} />
              <h2>{STATE_LABEL[state]}</h2>
              <p>{name}</p>
            </>
          ) : (
            <>
              <div className={`session-status-icon ${TERMINAL_STATES.has(state) ? "session-status-icon-bad" : ""}`}>
                <Icon name={state === "offline" ? "power" : state === "denied" ? "lock" : "alert"} size={26} />
              </div>
              <h2>{STATE_LABEL[state]}</h2>
              <p>{detail ?? "The connection ended unexpectedly."}</p>
              <button className="btn btn-primary" onClick={onExit}>
                Back to dashboard
              </button>
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <div
      className="session-shell"
      onPointerDown={nudgeToolbar}
      onMouseMove={nudgeToolbar}
    >
      <div
        ref={viewportRef}
        className={`viewport viewport-mode-${settings?.viewMode ?? "fit"} ${
          settings?.smoothScaling === false ? "viewport-crisp" : ""
        } is-live`}
      >
        <video ref={videoRef} className="remote-video" autoPlay playsInline muted={settings?.audioMuted ?? false} />

        {settings?.pointerMode === "trackpad" && !settings.viewOnly && cursorPos && (
          <div
            className="virtual-cursor"
            style={{ left: `${cursorPos.x * 100}%`, top: `${cursorPos.y * 100}%` }}
            aria-hidden="true"
          />
        )}

        {settings?.viewOnly && (
          <div className="view-only-badge" title="Input isn't being sent to the host">
            View only
          </div>
        )}

        {settings?.showStats && (
          <div className="stats-overlay">
            {stats.fps} fps · {(stats.kbps / 1000).toFixed(1)} Mbps · {stats.rttMs ?? "—"} ms
          </div>
        )}

        <div className={`session-toolbar ${toolbarVisible ? "" : "session-toolbar-hidden"}`}>
          <span className="session-toolbar-name" title={name}>
            {name}
          </span>
          <span className="toolbar-divider" aria-hidden="true" />
          <button
            className={`toolbar-btn ${keyboardActive ? "toolbar-btn-active" : ""} toolbar-btn-desktop-only`}
            onClick={toggleKeyboard}
            disabled={settings?.viewOnly}
            title={settings?.viewOnly ? "Turn off view-only mode to send input" : "Toggle keyboard capture"}
          >
            <Icon name="keyboard" size={16} />
          </button>
          <button
            className="toolbar-btn toolbar-btn-mobile-only"
            onClick={() => setOskOpen((v) => !v)}
            disabled={settings?.viewOnly}
            title="On-screen keyboard"
          >
            <Icon name="keyboard" size={16} />
          </button>
          <button className="toolbar-btn" onClick={sendClipboard} title="Send your clipboard to the host">
            <Icon name="clipboard" size={16} />
          </button>
          <button className="toolbar-btn" onClick={toggleFullscreen} title="Toggle fullscreen">
            <Icon name={document.fullscreenElement ? "minimize" : "expand"} size={16} />
          </button>
          <button
            className={`toolbar-btn ${sideboardOpen ? "toolbar-btn-active" : ""}`}
            onClick={() => setSideboardOpen((v) => !v)}
            title="Session settings"
          >
            <Icon name="settings" size={16} />
          </button>
          <span className="toolbar-divider" aria-hidden="true" />
          <button className="toolbar-btn toolbar-btn-danger" onClick={disconnect} title="End this session">
            <Icon name="x" size={16} />
          </button>
        </div>

        {oskOpen && (
          <OnScreenKeyboard onText={sendOskText} onSpecialKey={sendOskKey} onClose={() => setOskOpen(false)} />
        )}
      </div>

      {sideboardOpen && settings && (
        <Sideboard
          settings={settings}
          onSettingsChange={updateSetting}
          hostInfo={hostInfo}
          hostStats={hostStats}
          stats={stats}
          pointerMode={settings.pointerMode}
          onPointerModeChange={handlePointerModeChange}
          onSendControl={(msg) => sessionRef.current?.sendControl(msg)}
          onCtrlAltDel={sendCtrlAltDel}
          onPrintScreen={sendPrintScreen}
          onSendClipboard={sendClipboard}
          keyboardActive={keyboardActive}
          onToggleKeyboard={toggleKeyboard}
          onOpenTextInput={() => setOskOpen(true)}
          gameMode={gameMode}
          onToggleGameMode={toggleGameMode}
          onClose={() => setSideboardOpen(false)}
        />
      )}
    </div>
  );
}
