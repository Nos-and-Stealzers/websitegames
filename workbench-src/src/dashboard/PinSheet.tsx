import { useState } from "react";
import { setComputerPin } from "../data/computers";
import type { ComputerEntry } from "../data/computers";
import { Sheet } from "../ui/Sheet";
import { Icon } from "../ui/Icon";
import { Spinner } from "../ui/Spinner";
import { useToast } from "../ui/Toasts";

const MIN_PIN_LENGTH = 6;

/** Owner-only: set, change, or clear a connect PIN — a second, independent way for someone to
 *  reach this computer via Connect by Host ID, without needing an explicit @username share first
 *  (see 0003_pin_access.sql and signaling/src/HostSession.ts's handleAccountAuth). Nothing here
 *  ever reads back the actual PIN — only its hash is ever stored, so "is one set" is all this
 *  page can show once it's saved. */
export function PinSheet({
  entry,
  onClose,
  onUpdated,
}: {
  entry: ComputerEntry;
  onClose: () => void;
  onUpdated: () => Promise<void> | void;
}) {
  const toast = useToast();
  const hasPin = entry.computer.pin_hash !== null;

  const [pin, setPin] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);

  const ready = pin.length >= MIN_PIN_LENGTH && pin === confirm;

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    try {
      await setComputerPin(entry.computer.id, pin);
      await onUpdated();
      toast(hasPin ? "Connect PIN changed." : "Connect PIN set.", "good");
      onClose();
    } catch {
      toast("Couldn't save the PIN — try again.", "bad");
    } finally {
      setBusy(false);
    }
  };

  const clear = async () => {
    setBusy(true);
    try {
      await setComputerPin(entry.computer.id, null);
      await onUpdated();
      toast("Connect PIN removed.", "good");
      onClose();
    } catch {
      toast("Couldn't remove the PIN — try again.", "bad");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet title={`Connect PIN for "${entry.computer.name}"`} icon="lock" onClose={onClose}>
      <p className="sheet-lede">
        Anyone signed in who has this computer's Host ID and this PIN can connect straight away —
        no invite, and they won't show up on your dashboard's share list. Every attempt is logged,
        and five wrong guesses locks out further attempts for a few minutes. Leave it unset to
        require an explicit share instead.
      </p>

      {hasPin && (
        <p className="alert alert-info">
          <Icon name="info" size={14} />A PIN is currently set. Saving a new one below replaces it.
        </p>
      )}

      <form style={{ display: "flex", flexDirection: "column", gap: "0.9rem" }} onSubmit={save}>
        <div className="field-block">
          <span className="field-label">New PIN</span>
          <input
            id="connect-pin"
            name="connectPin"
            className="field"
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\s/g, ""))}
            placeholder={`At least ${MIN_PIN_LENGTH} characters`}
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <div className="field-block">
          <span className="field-label">Confirm PIN</span>
          <input
            id="confirm-connect-pin"
            name="confirmConnectPin"
            className="field"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value.replace(/\s/g, ""))}
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <button className="btn btn-primary btn-block" type="submit" disabled={!ready || busy}>
          {busy ? <Spinner size={14} /> : <Icon name="lock" size={15} />}
          {hasPin ? "Change PIN" : "Set PIN"}
        </button>
        {hasPin && (
          <button className="btn btn-secondary btn-block" type="button" onClick={() => void clear()} disabled={busy}>
            Remove PIN
          </button>
        )}
      </form>
    </Sheet>
  );
}
