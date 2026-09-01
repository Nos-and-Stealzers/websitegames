import { Icon } from "../ui/Icon";

/** A reference page for the messages this app can show — what each one means and what to do
 *  about it — plus a couple of common setup snags. Not a support ticket system, just the answers
 *  to the questions someone would otherwise have to ask a person for. */
export function HelpPage({ onBack }: { onBack: () => void }) {
  return (
    <div className="dash">
      <header className="dash-header">
        <button className="link-btn" onClick={onBack}>
          <Icon name="arrow-left" size={14} />
          Back
        </button>
        <span />
      </header>

      <div className="dash-body" style={{ maxWidth: 760 }}>
        <div className="dash-title-block">
          <h1>Help</h1>
          <p className="dash-subtitle">What things mean, and what to do about them.</p>
        </div>

        <Section title="Windows warns me not to run the downloaded file">
          <p>
            That's Windows SmartScreen — it flags any freshly downloaded app that isn't from a
            paid, verified publisher, regardless of what the app actually does. It's a one-time
            speed bump, not a sign anything is wrong:
          </p>
          <ol className="help-steps">
            <li>Click <strong>More info</strong> on the warning, then <strong>Run anyway</strong>.</li>
            <li>
              Or, before running it: right-click the .exe → <strong>Properties</strong> → check{" "}
              <strong>Unblock</strong> at the bottom of the General tab → <strong>OK</strong>.
              This removes the "downloaded from the internet" flag Windows attaches, and the
              warning won't appear again for that file.
            </li>
          </ol>
        </Section>

        <Section title="Ctrl+Alt+Del from the sideboard does nothing">
          <p>
            Windows deliberately blocks any ordinary app from sending this — it's what stops
            malware from faking the login screen. Turn on "software SAS generation" on the host
            once:
          </p>
          <ol className="help-steps">
            <li>
              On the host PC, open <code>regedit</code> and go to{" "}
              <code>HKEY_LOCAL_MACHINE\Software\Microsoft\Windows NT\CurrentVersion\Winlogon</code>.
            </li>
            <li>Create a DWORD value named <code>SoftwareSASGeneration</code>, set to <code>1</code>.</li>
            <li>Sign out and back in (or reboot) for it to take effect.</li>
          </ol>
        </Section>

        <Section title="Video/screen shows nothing, or looks wrong">
          <ul className="help-list">
            <li>Check the sideboard's <strong>Stats</strong> tab — if fps and bitrate are both 0, no video is being sent at all (a connection problem). If they're nonzero, video is flowing but not displaying (try refreshing the page once).</li>
            <li>Desktop Duplication (what the host uses to capture the screen) can't see anything if you're viewing the host machine's own screen through another remote-desktop tool at the same time, or if its display is asleep/locked.</li>
          </ul>
        </Section>

        <Section title="Error reference">
          <p className="sideboard-hint" style={{ marginBottom: "0.25rem" }}>
            The exact wording you might see, and what it means.
          </p>
          <ErrorTable
            rows={[
              ["Your sign-in expired. Sign in again and retry.", "Your browser session ran out before the connection finished. Sign in again."],
              ["Your account doesn't have access to this computer.", "The computer's owner hasn't shared it with your account. Ask them to add your username from their dashboard."],
              ["Your sign-in couldn't be verified.", "The relay couldn't validate your session token — usually clears up by signing out and back in."],
              ["That computer isn't online right now.", "The host app isn't currently connected to the relay — it may be closed, asleep, or offline."],
              ["The signaling service didn't answer in time.", "No response from the relay within 20 seconds — check your internet connection and retry."],
              ["Lost the connection to the signaling service.", "The relay connection dropped before a peer connection was established. Retry."],
              ["The connection dropped.", "An already-established session's connection failed (network change, closed lid, etc.) and couldn't recover."],
              ["Invalid host token.", "The host's saved identity doesn't match any computer on record — delete its identity.json and set it up again."],
              ["Setup key is required. / That setup key isn't recognized. / That setup key has already been used. / That setup key expired.", "Enrollment-key problems — generate a fresh one from the dashboard's Add a computer flow; each key is single-use and expires after an hour."],
              ["Download temporarily unavailable.", "The signaling relay couldn't fetch the host installer from GitHub right now — try again shortly."],
            ]}
          />
        </Section>

        <Section title="Still stuck?">
          <p>
            Reach out with what you were trying to do, what you saw on screen, and — if it's a
            connection problem — a screenshot of the sideboard's Stats tab while it's happening.
          </p>
        </Section>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="card" style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
      <h2 style={{ margin: 0, fontSize: "1.02rem" }}>{title}</h2>
      {children}
    </section>
  );
}

function ErrorTable({ rows }: { rows: [string, string][] }) {
  return (
    <div className="error-table">
      {rows.map(([message, meaning]) => (
        <div className="error-table-row" key={message}>
          <span className="error-table-message">{message}</span>
          <span className="error-table-meaning">{meaning}</span>
        </div>
      ))}
    </div>
  );
}
