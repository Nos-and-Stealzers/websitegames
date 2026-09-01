import { useEffect, useRef } from "react";
import { Icon } from "../ui/Icon";

/** A phone's on-screen keyboard reports almost every physical key as the single code
 *  "Unidentified" — it's an IME, composing text, not a set of key positions — so there is no
 *  keydown/keyup stream worth forwarding from it. This captures the *composed text* instead
 *  (via a hidden, always-empty input so backspace and autocomplete both behave) and sends it as
 *  one `text` message per change, plus a handful of buttons for the keys that never produce text
 *  at all: Enter, Backspace, Tab, Escape, and the arrows. */
export function OnScreenKeyboard({
  onText,
  onSpecialKey,
  onClose,
}: {
  onText: (text: string) => void;
  onSpecialKey: (code: string) => void;
  onClose: () => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleInput = (e: React.FormEvent<HTMLInputElement>) => {
    const value = e.currentTarget.value;
    if (value) {
      onText(value);
      e.currentTarget.value = "";
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    // Real physical keyboards attached to a tablet/Chromebook fire genuine codes even inside this
    // input — pass those through as key events instead of swallowing them as "no text produced."
    if (e.key === "Enter") {
      onSpecialKey("Enter");
      e.preventDefault();
    } else if (e.key === "Backspace" && !e.currentTarget.value) {
      // Only when the field is already empty — otherwise this double-deletes a character the
      // input event above is about to report as the field's new (shorter) value.
      onSpecialKey("Backspace");
      e.preventDefault();
    } else if (e.key === "Tab") {
      onSpecialKey("Tab");
      e.preventDefault();
    }
  };

  return (
    <div className="osk">
      <input
        id="osk-input"
        name="oskInput"
        ref={inputRef}
        className="osk-sink"
        onInput={handleInput}
        onKeyDown={handleKeyDown}
        autoCapitalize="off"
        autoCorrect="off"
        autoComplete="off"
        spellCheck={false}
        aria-label="Type to send text to the host"
      />
      <div className="osk-row">
        <button className="osk-key osk-key-wide" onClick={() => onSpecialKey("Escape")}>
          Esc
        </button>
        <button className="osk-key osk-key-wide" onClick={() => onSpecialKey("Tab")}>
          Tab
        </button>
        <button className="osk-key" onClick={() => onSpecialKey("ArrowLeft")} aria-label="Left">
          ←
        </button>
        <button className="osk-key" onClick={() => onSpecialKey("ArrowUp")} aria-label="Up">
          ↑
        </button>
        <button className="osk-key" onClick={() => onSpecialKey("ArrowDown")} aria-label="Down">
          ↓
        </button>
        <button className="osk-key" onClick={() => onSpecialKey("ArrowRight")} aria-label="Right">
          →
        </button>
        <button className="osk-key osk-key-wide" onClick={() => onSpecialKey("Backspace")}>
          ⌫
        </button>
        <button className="osk-key osk-key-wide osk-key-accent" onClick={() => onSpecialKey("Enter")}>
          Enter
        </button>
        <button className="osk-key osk-key-close" onClick={onClose} aria-label="Close keyboard">
          <Icon name="x" size={15} />
        </button>
      </div>
    </div>
  );
}
