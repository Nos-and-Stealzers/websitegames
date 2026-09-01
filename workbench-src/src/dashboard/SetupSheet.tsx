import { useState } from "react";
import { issueEnrollmentKey, type IssuedKey } from "../data/enrollment";
import { WORKER_URL } from "../config";
import { Sheet } from "../ui/Sheet";
import { Icon } from "../ui/Icon";
import { Spinner } from "../ui/Spinner";
import { useToast } from "../ui/Toasts";

/** Generates a one-time setup key, shown exactly once, that binds a freshly-installed host to
 *  this account for good. This is the entire enrollment story: run the installer, paste the key
 *  when it asks, and the computer never needs to be touched again — sharing and revoking both
 *  happen from the web afterward (see ShareSheet). */
export function SetupSheet({ onClose, onEnrolled }: { onClose: () => void; onEnrolled: () => void }) {
  const toast = useToast();
  const [label, setLabel] = useState("");
  const [issued, setIssued] = useState<IssuedKey | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const generate = async () => {
    setBusy(true);
    try {
      setIssued(await issueEnrollmentKey(label));
    } catch {
      toast("Couldn't generate a setup key. Try again.", "bad");
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    if (!issued) return;
    try {
      await navigator.clipboard.writeText(issued.key);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      toast("Couldn't copy — select and copy the key manually.", "bad");
    }
  };

  return (
    <Sheet title="Set up a computer" icon="plug" onClose={onClose}>
      {!issued ? (
        <>
          <p className="sheet-lede">
            Download the installer, run it on the PC you want to reach, and paste in a one-time
            setup key when it asks. That's the only step that ever happens on the machine itself —
            after this, share and revoke access entirely from here.
          </p>

          <a className="btn btn-primary btn-block download-btn" href={`${WORKER_URL}/download/host.exe`}>
            <Icon name="download" size={16} />
            Download for Windows
          </a>

          <div className="field-block" style={{ marginTop: 20 }}>
            <span className="field-label">Name this computer (optional)</span>
            <input
              id="computer-label"
              name="computerLabel"
              className="field"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="e.g. Office Desktop"
              spellCheck={false}
            />
          </div>

          <button className="btn btn-secondary btn-block" onClick={generate} disabled={busy}>
            {busy ? <Spinner size={14} /> : <Icon name="key" size={15} />}
            Generate setup key
          </button>

          <ul className="setup-requirements">
            <li>Windows 10/11 with a GPU from the last decade.</li>
            <li>
              SmartScreen may warn on first run — <strong>More info → Run anyway</strong>.
            </li>
          </ul>
        </>
      ) : (
        <>
          <div className="key-display">
            <span className="key-display-label">Setup key — expires in 1 hour, works once</span>
            <div className="key-display-value">
              <code>{issued.key}</code>
              <button className="icon-btn" onClick={copy} aria-label="Copy setup key">
                <Icon name={copied ? "check" : "copy"} size={16} />
              </button>
            </div>
          </div>

          <p className="alert alert-info">
            <Icon name="info" size={15} />
            This is shown once. Paste it into the host when it asks during setup.
          </p>

          <ol className="setup-steps">
            <li>Run the downloaded installer on the target PC.</li>
            <li>When it asks for a setup key, paste the one above.</li>
            <li>Done — it appears on this dashboard within a few seconds.</li>
          </ol>

          <button
            className="btn btn-primary btn-block"
            onClick={() => {
              onEnrolled();
              onClose();
            }}
          >
            Done
          </button>
        </>
      )}
    </Sheet>
  );
}
