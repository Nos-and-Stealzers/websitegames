import { useEffect, useRef, useState } from "react";
import { useAuth } from "../auth/AuthProvider";
import { supabase } from "../lib/supabase";
import { updateProfile, changeEmail, changePassword, deleteAccount } from "../data/account";
import { Icon } from "../ui/Icon";
import { Spinner } from "../ui/Spinner";
import { useToast } from "../ui/Toasts";

type UsernameStatus = "idle" | "checking" | "free" | "taken";

/** Everything a signed-in account can change about itself — display name, username, email,
 *  password — plus the one irreversible thing: deleting the account outright. Reachable from the
 *  account menu; the same shell (.dash / header / card) the dashboard and the old admin-settings
 *  page used, so it doesn't feel like a bolted-on screen. */
export function AccountSettingsPage({ onBack }: { onBack: () => void }) {
  const { session, profile, refreshProfile, signOut } = useAuth();
  const toast = useToast();

  return (
    <div className="dash">
      <header className="dash-header">
        <button className="link-btn" onClick={onBack}>
          <Icon name="arrow-left" size={14} />
          Back
        </button>
        <span />
      </header>

      <div className="dash-body" style={{ maxWidth: 640 }}>
        <div className="dash-title-block">
          <h1>Account settings</h1>
          <p className="dash-subtitle">Signed in as {session?.user.email}</p>
        </div>

        <ProfileSection
          initialDisplayName={profile?.display_name ?? ""}
          initialUsername={profile?.username ?? ""}
          onSaved={refreshProfile}
        />
        <EmailSection currentEmail={session?.user.email ?? ""} />
        <PasswordSection />
        <DangerZone
          onDeleted={async () => {
            toast("Account deleted.", "good");
            await signOut();
          }}
        />
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="card" style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
      <h2 style={{ margin: 0, fontSize: "1.02rem" }}>{title}</h2>
      {children}
    </section>
  );
}

function ProfileSection({
  initialDisplayName,
  initialUsername,
  onSaved,
}: {
  initialDisplayName: string;
  initialUsername: string;
  onSaved: () => Promise<void>;
}) {
  const toast = useToast();
  const [displayName, setDisplayName] = useState(initialDisplayName);
  const [username, setUsername] = useState(initialUsername);
  const [saving, setSaving] = useState(false);
  const usernameStatus = useUsernameAvailability(username, initialUsername);

  // The profile this page's initial*/props are built from loads asynchronously (a separate
  // fetch after sign-in) and can still be in flight when someone opens this page - useState only
  // takes its argument on first render, so if that happens these fields would start out blank
  // ("") and never update once the real profile arrives, permanently failing the username regex
  // below and leaving Save disabled no matter what's typed. Resyncs from the real values once
  // they show up, as long as the user hasn't already started editing.
  const editedRef = useRef(false);
  useEffect(() => {
    if (editedRef.current) return;
    setDisplayName(initialDisplayName);
    setUsername(initialUsername);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialDisplayName, initialUsername]);

  const usernameValid = /^[a-z0-9_]{3,24}$/.test(username);
  const dirty = displayName.trim() !== initialDisplayName || username.trim() !== initialUsername;
  const ready = usernameValid && dirty && usernameStatus !== "taken";

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ready || saving) return;
    setSaving(true);
    try {
      await updateProfile(displayName, username);
      await onSaved();
      toast("Profile updated.", "good");
    } catch (err) {
      toast(err instanceof Error ? err.message : "Couldn't update your profile.", "bad");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Section title="Profile">
      <form style={{ display: "flex", flexDirection: "column", gap: "0.9rem" }} onSubmit={save}>
        <div className="field-block">
          <span className="field-label">Name</span>
          <input id="profile-display-name" name="displayName" className="field" value={displayName} onChange={(e) => { editedRef.current = true; setDisplayName(e.target.value); }} placeholder="Your name" />
        </div>
        <div className="field-block">
          <span className="field-label-row">
            <span className="field-label">Username</span>
            {username.trim() !== initialUsername && username && (
              <span
                className={`field-status field-status-${
                  !usernameValid
                    ? "warn"
                    : usernameStatus === "checking"
                      ? "muted"
                      : usernameStatus === "taken"
                        ? "bad"
                        : "good"
                }`}
              >
                {!usernameValid
                  ? "3–24 characters: a–z, 0–9, _"
                  : usernameStatus === "checking"
                    ? "Checking…"
                    : usernameStatus === "taken"
                      ? "Already taken"
                      : "Available"}
              </span>
            )}
          </span>
          <div className="field-prefixed">
            <span className="field-prefix">@</span>
            <input
              id="profile-username"
              name="username"
              className="field"
              value={username}
              onChange={(e) => {
                editedRef.current = true;
                setUsername(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ""));
              }}
              spellCheck={false}
              autoCapitalize="off"
              maxLength={24}
            />
          </div>
          <span className="field-hint">This is how others invite you to share a computer.</span>
        </div>
        <button className="btn btn-primary" type="submit" disabled={!ready || saving} style={{ alignSelf: "flex-start" }}>
          {saving ? <Spinner size={14} /> : <Icon name="check" size={15} />}
          Save
        </button>
      </form>
    </Section>
  );
}

function EmailSection({ currentEmail }: { currentEmail: string }) {
  const toast = useToast();
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = email.trim();
    if (!trimmed || trimmed === currentEmail) return;
    setBusy(true);
    try {
      await changeEmail(trimmed);
      toast("Check your inbox to confirm the new address.", "good");
      setEmail("");
    } catch (err) {
      toast(err instanceof Error ? err.message : "Couldn't start the email change.", "bad");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title="Email">
      <form style={{ display: "flex", flexDirection: "column", gap: "0.9rem" }} onSubmit={submit}>
        <div className="field-block">
          <span className="field-label">Current email</span>
          <input id="current-email" name="currentEmail" className="field" value={currentEmail} disabled />
        </div>
        <div className="field-block">
          <span className="field-label">New email</span>
          <input
            id="new-email"
            name="newEmail"
            className="field"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            spellCheck={false}
            autoCapitalize="off"
          />
        </div>
        <p className="alert alert-info">
          <Icon name="info" size={14} />
          Changing your email requires confirming a link sent to the new address before it takes
          effect.
        </p>
        <button
          className="btn btn-secondary"
          type="submit"
          disabled={busy || !email.trim() || email.trim() === currentEmail}
          style={{ alignSelf: "flex-start" }}
        >
          {busy ? <Spinner size={14} /> : null}
          Update email
        </button>
      </form>
    </Section>
  );
}

function PasswordSection() {
  const toast = useToast();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);

  const ready = password.length >= 8 && password === confirm;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    try {
      await changePassword(password);
      setPassword("");
      setConfirm("");
      toast("Password updated.", "good");
    } catch (err) {
      toast(err instanceof Error ? err.message : "Couldn't update your password.", "bad");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title="Password">
      <form style={{ display: "flex", flexDirection: "column", gap: "0.9rem" }} onSubmit={submit}>
        <div className="field-block">
          <span className="field-label">New password</span>
          <input
            id="new-password"
            name="newPassword"
            className="field"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="At least 8 characters"
            autoComplete="new-password"
          />
        </div>
        <div className="field-block">
          <span className="field-label">Confirm new password</span>
          <input
            id="confirm-new-password"
            name="confirmNewPassword"
            className="field"
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            autoComplete="new-password"
          />
          {confirm && password !== confirm && <span className="field-hint">Doesn't match yet.</span>}
        </div>
        <button className="btn btn-secondary" type="submit" disabled={!ready || busy} style={{ alignSelf: "flex-start" }}>
          {busy ? <Spinner size={14} /> : null}
          Update password
        </button>
      </form>
    </Section>
  );
}

function DangerZone({ onDeleted }: { onDeleted: () => Promise<void> }) {
  const toast = useToast();
  const [confirmText, setConfirmText] = useState("");
  const [busy, setBusy] = useState(false);

  const ready = confirmText.trim().toUpperCase() === "DELETE";

  const doDelete = async () => {
    if (!ready || busy) return;
    setBusy(true);
    try {
      await deleteAccount();
      await onDeleted();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Couldn't delete your account.", "bad");
      setBusy(false);
    }
  };

  return (
    <Section title="Danger zone">
      <p className="alert alert-bad">
        <Icon name="alert" size={14} />
        Deleting your account is permanent. Every computer you own is deleted along with it, and
        every share you granted or received disappears.
      </p>
      <div className="field-block">
        <span className="field-label">Type DELETE to confirm</span>
        <input
          className="field"
          value={confirmText}
          onChange={(e) => setConfirmText(e.target.value)}
          placeholder="DELETE"
          spellCheck={false}
          autoCapitalize="off"
        />
      </div>
      <button
        className="btn"
        style={{ alignSelf: "flex-start", background: "var(--danger)", color: "#fff" }}
        onClick={doDelete}
        disabled={!ready || busy}
      >
        {busy ? <Spinner size={14} /> : <Icon name="trash" size={15} />}
        Delete my account
      </button>
    </Section>
  );
}

/** Same debounced RPC check as sign-up (see AuthScreen.tsx), but treats the account's own current
 *  username as always-available — otherwise every save would report your own name as "taken". */
function useUsernameAvailability(username: string, currentUsername: string): UsernameStatus {
  const [status, setStatus] = useState<UsernameStatus>("idle");
  const latest = useRef(0);

  useEffect(() => {
    if (username === currentUsername) {
      setStatus("idle");
      return;
    }
    if (!/^[a-z0-9_]{3,24}$/.test(username)) {
      setStatus("idle");
      return;
    }
    setStatus("checking");
    const ticket = ++latest.current;
    const timer = window.setTimeout(async () => {
      const { data, error } = await supabase.rpc("username_available", { candidate: username });
      if (ticket !== latest.current) return;
      if (error) setStatus("idle");
      else setStatus(data ? "free" : "taken");
    }, 350);

    return () => window.clearTimeout(timer);
  }, [username, currentUsername]);

  return status;
}
