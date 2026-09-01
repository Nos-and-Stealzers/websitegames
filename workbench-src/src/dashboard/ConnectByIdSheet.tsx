import { useState } from "react";
import { Sheet } from "../ui/Sheet";
import { Icon } from "../ui/Icon";

/** For a computer someone already shared with your account but that hasn't shown up on your
 *  dashboard yet — connecting once is enough to pull it in (see App.tsx's post-connect refresh).
 *  This is a fallback, not the primary path: the primary path is showing up in the grid on its
 *  own once access is granted.
 *
 *  The PIN field is a second, independent way in: a computer whose owner has set a connect PIN
 *  (see PinSheet.tsx) can be reached with just the Host ID and that PIN, no share/invite needed
 *  first. Left blank, this behaves exactly as before — the ID alone only works if you already
 *  have a standing grant. */
export function ConnectByIdSheet({
  onClose,
  onConnect,
}: {
  onClose: () => void;
  onConnect: (hostId: string, pin?: string) => void;
}) {
  const [hostId, setHostId] = useState("");
  const [pin, setPin] = useState("");

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    // Host IDs are generated lowercase-only (see enrollment.ts's HOST_ID_ALPHABET) and routed by
    // an exact-match Durable Object name and a case-sensitive Postgres column - typing or pasting
    // one in any other case (autocapitalized on mobile, copied from somewhere that capitalized
    // it) silently routed to the wrong place instead of the real host, looking like "can't
    // connect" for what was actually a perfectly valid, authorized ID.
    const trimmed = hostId.trim().toLowerCase();
    if (!trimmed) return;
    onConnect(trimmed, pin.trim() || undefined);
    onClose();
  };

  return (
    <Sheet title="Connect by Host ID" icon="link" onClose={onClose}>
      <p className="sheet-lede">
        For a computer someone has already shared with your account — or one whose owner gave you
        a connect PIN instead. Ask for the Host ID either way; it's shown on their dashboard next
        to the computer's name.
      </p>
      <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: "0.9rem" }}>
        <div className="field-block">
          <span className="field-label">Host ID</span>
          <input
            id="host-id"
            name="hostId"
            className="field"
            value={hostId}
            onChange={(e) => setHostId(e.target.value)}
            placeholder="e.g. 7f3k9qab"
            spellCheck={false}
            autoCapitalize="off"
            autoFocus
          />
        </div>
        <div className="field-block">
          <span className="field-label">PIN</span>
          <input
            id="connect-pin-attempt"
            name="connectPinAttempt"
            className="field"
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\s/g, ""))}
            placeholder="Only if the owner gave you one"
            spellCheck={false}
            autoCapitalize="off"
            autoComplete="off"
          />
          <span className="field-hint">Leave blank if this computer's already shared with your account.</span>
        </div>
        <button className="btn btn-primary btn-block" type="submit" disabled={!hostId.trim()}>
          <Icon name="link" size={15} />
          Connect
        </button>
      </form>
    </Sheet>
  );
}
