import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "../lib/supabase";
import { Icon } from "../ui/Icon";
import { Spinner } from "../ui/Spinner";

type Mode = "signin" | "signup" | "reset";

/** Sign-in / sign-up / password reset. Deliberately one screen with three modes rather than three
 *  routes: the whole point is that getting in is fast, and swapping a heading and two fields in
 *  place is faster than a navigation. */
export function AuthScreen() {
  const [mode, setMode] = useState<Mode>("signin");
  const [pendingEmail, setPendingEmail] = useState<string | null>(null);
  const [resetSent, setResetSent] = useState(false);

  if (pendingEmail) {
    return (
      <AuthShell>
        <ConfirmEmailNotice email={pendingEmail} onBack={() => setPendingEmail(null)} />
      </AuthShell>
    );
  }

  return (
    <AuthShell>
      {mode === "reset" ? (
        <ResetForm
          sent={resetSent}
          onSent={() => setResetSent(true)}
          onBack={() => {
            setMode("signin");
            setResetSent(false);
          }}
        />
      ) : (
        <CredentialsForm
          mode={mode}
          onModeChange={setMode}
          onNeedsConfirmation={setPendingEmail}
        />
      )}
    </AuthShell>
  );
}

/** The two-column frame: a product panel that sells what this is, and the form. The panel is
 *  purely decorative, so it's the half that drops on narrow screens — the form always gets the
 *  full width on a phone. */
function AuthShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="auth-shell">
      <aside className="auth-pitch">
        <div className="auth-pitch-brand">
          <span className="brand-mark" aria-hidden="true" />
          <span>PopRemoteDesktop</span>
        </div>

        <h1 className="auth-pitch-title">
          Your computer,
          <br />
          wherever you are.
        </h1>
        <p className="auth-pitch-body">
          Full-speed remote access over a direct, end-to-end encrypted connection. Set a computer
          up once — then reach it from any browser or phone you're signed in on.
        </p>

        <ul className="auth-pitch-list">
          <li>
            <Icon name="bolt" />
            <div>
              <strong>Hardware-encoded video</strong>
              <span>H.264 straight off the GPU, up to 60&nbsp;fps.</span>
            </div>
          </li>
          <li>
            <Icon name="lock" />
            <div>
              <strong>Peer-to-peer and encrypted</strong>
              <span>Your screen never touches our servers.</span>
            </div>
          </li>
          <li>
            <Icon name="users" />
            <div>
              <strong>Share and revoke from the web</strong>
              <span>No going back to the machine to read a code.</span>
            </div>
          </li>
        </ul>

        <div className="auth-pitch-glow" aria-hidden="true" />
      </aside>

      <main className="auth-panel">{children}</main>
    </div>
  );
}

function CredentialsForm({
  mode,
  onModeChange,
  onNeedsConfirmation,
}: {
  mode: Exclude<Mode, "reset">;
  onModeChange: (mode: Mode) => void;
  onNeedsConfirmation: (email: string) => void;
}) {
  const isSignUp = mode === "signup";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const usernameStatus = useUsernameAvailability(isSignUp ? username : "");

  const passwordScore = scorePassword(password);
  const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  const usernameValid = /^[a-z0-9_]{3,24}$/.test(username);

  const ready = isSignUp
    ? emailValid && password.length >= 8 && usernameValid && usernameStatus !== "taken"
    : emailValid && password.length > 0;

  const submit = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      if (!ready || busy) return;

      setError(null);
      setBusy(true);
      try {
        if (isSignUp) {
          const { data, error: signUpError } = await supabase.auth.signUp({
            email: email.trim(),
            password,
            options: {
              data: { username, display_name: displayName.trim() || username },
              emailRedirectTo: window.location.origin,
            },
          });
          if (signUpError) throw signUpError;
          // No session back means the project requires email confirmation — that isn't an error,
          // it just means the next step happens in their inbox.
          if (!data.session) onNeedsConfirmation(email.trim());
        } else {
          const { error: signInError } = await supabase.auth.signInWithPassword({
            email: email.trim(),
            password,
          });
          if (signInError) throw signInError;
        }
      } catch (e) {
        setError(friendlyAuthError(e));
      } finally {
        setBusy(false);
      }
    },
    [ready, busy, isSignUp, email, password, username, displayName, onNeedsConfirmation],
  );

  return (
    <form className="auth-form" onSubmit={submit}>
      <div className="auth-form-head">
        <h2>{isSignUp ? "Create your account" : "Welcome back"}</h2>
        <p>
          {isSignUp
            ? "One account reaches every computer you set up or get invited to."
            : "Sign in to see your computers."}
        </p>
      </div>

      <div className="auth-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={!isSignUp}
          className={`auth-tab ${!isSignUp ? "auth-tab-active" : ""}`}
          onClick={() => onModeChange("signin")}
        >
          Sign in
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={isSignUp}
          className={`auth-tab ${isSignUp ? "auth-tab-active" : ""}`}
          onClick={() => onModeChange("signup")}
        >
          Create account
        </button>
      </div>

      {isSignUp && (
        <>
          <Field label="Name" hint="Shown to people you share a computer with.">
            <input
              id="display-name"
              name="displayName"
              className="field"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Alex Rivera"
              autoComplete="name"
            />
          </Field>

          <Field
            label="Username"
            hint="Lowercase letters, numbers and underscores. This is how others invite you."
            status={
              !username
                ? undefined
                : !usernameValid
                  ? { tone: "warn", text: "3–24 characters: a–z, 0–9, _" }
                  : usernameStatus === "checking"
                    ? { tone: "muted", text: "Checking…" }
                    : usernameStatus === "taken"
                      ? { tone: "bad", text: "Already taken" }
                      : usernameStatus === "free"
                        ? { tone: "good", text: "Available" }
                        : undefined
            }
          >
            <div className="field-prefixed">
              <span className="field-prefix">@</span>
              <input
                id="username"
                name="username"
                className="field"
                value={username}
                onChange={(e) => setUsername(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ""))}
                placeholder="alex"
                spellCheck={false}
                autoCapitalize="off"
                autoComplete="username"
                maxLength={24}
              />
            </div>
          </Field>
        </>
      )}

      <Field label="Email">
        <input
          id="email"
          name="email"
          className="field"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          spellCheck={false}
          autoCapitalize="off"
          autoComplete={isSignUp ? "email" : "username"}
          inputMode="email"
        />
      </Field>

      <Field
        label="Password"
        action={
          !isSignUp && (
            <button type="button" className="link-btn" onClick={() => onModeChange("reset")}>
              Forgot?
            </button>
          )
        }
      >
        <div className="field-prefixed field-suffixed">
          <input
            id="password"
            name="password"
            className="field"
            type={showPassword ? "text" : "password"}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={isSignUp ? "At least 8 characters" : "••••••••"}
            autoComplete={isSignUp ? "new-password" : "current-password"}
          />
          <button
            type="button"
            className="field-suffix"
            onClick={() => setShowPassword((v) => !v)}
            aria-label={showPassword ? "Hide password" : "Show password"}
          >
            <Icon name={showPassword ? "eye-off" : "eye"} />
          </button>
        </div>
      </Field>

      {isSignUp && password.length > 0 && (
        <div className="pw-meter" aria-hidden="true">
          <div className="pw-meter-track">
            <div className={`pw-meter-fill pw-meter-${passwordScore.level}`} style={{ width: `${passwordScore.pct}%` }} />
          </div>
          <span className="pw-meter-label">{passwordScore.label}</span>
        </div>
      )}

      {error && (
        <p className="alert alert-bad" role="alert">
          <Icon name="alert" />
          {error}
        </p>
      )}

      <button className="btn btn-primary btn-block" type="submit" disabled={!ready || busy}>
        {busy ? <Spinner /> : null}
        {isSignUp ? "Create account" : "Sign in"}
      </button>

      <p className="auth-switch">
        {isSignUp ? "Already have an account?" : "New here?"}{" "}
        <button type="button" className="link-btn" onClick={() => onModeChange(isSignUp ? "signin" : "signup")}>
          {isSignUp ? "Sign in instead" : "Create an account"}
        </button>
      </p>
    </form>
  );
}

function ResetForm({ sent, onSent, onBack }: { sent: boolean; onSent: () => void; onBack: () => void }) {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const { error: resetError } = await supabase.auth.resetPasswordForEmail(email.trim(), {
      redirectTo: `${window.location.origin}/#recover`,
    });
    setBusy(false);
    if (resetError) setError(friendlyAuthError(resetError));
    else onSent();
  };

  if (sent) {
    return (
      <div className="auth-form">
        <div className="auth-icon-badge auth-icon-good">
          <Icon name="mail" />
        </div>
        <div className="auth-form-head">
          <h2>Check your email</h2>
          <p>
            If an account exists for <strong>{email}</strong>, a reset link is on its way. It
            expires in an hour.
          </p>
        </div>
        <button className="btn btn-secondary btn-block" onClick={onBack}>
          Back to sign in
        </button>
      </div>
    );
  }

  return (
    <form className="auth-form" onSubmit={submit}>
      <div className="auth-form-head">
        <h2>Reset your password</h2>
        <p>We'll email you a link to set a new one.</p>
      </div>

      <Field label="Email">
        <input
          id="reset-email"
          name="resetEmail"
          className="field"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          autoComplete="email"
          inputMode="email"
          spellCheck={false}
        />
      </Field>

      {error && (
        <p className="alert alert-bad" role="alert">
          <Icon name="alert" />
          {error}
        </p>
      )}

      <button className="btn btn-primary btn-block" type="submit" disabled={busy || !email.trim()}>
        {busy ? <Spinner /> : null}
        Send reset link
      </button>
      <p className="auth-switch">
        <button type="button" className="link-btn" onClick={onBack}>
          ‹ Back to sign in
        </button>
      </p>
    </form>
  );
}

function ConfirmEmailNotice({ email, onBack }: { email: string; onBack: () => void }) {
  const [resent, setResent] = useState(false);
  const [busy, setBusy] = useState(false);

  const resend = async () => {
    setBusy(true);
    await supabase.auth.resend({ type: "signup", email });
    setBusy(false);
    setResent(true);
  };

  return (
    <div className="auth-form">
      <div className="auth-icon-badge auth-icon-good">
        <Icon name="mail" />
      </div>
      <div className="auth-form-head">
        <h2>Confirm your email</h2>
        <p>
          We sent a confirmation link to <strong>{email}</strong>. Click it and you'll land back
          here signed in.
        </p>
      </div>

      <p className="alert alert-info">
        <Icon name="info" />
        Don't see it? Check spam — confirmation mail from a new project often lands there.
      </p>

      <button className="btn btn-secondary btn-block" onClick={resend} disabled={busy || resent}>
        {busy ? <Spinner /> : null}
        {resent ? "Sent again" : "Resend confirmation"}
      </button>
      <p className="auth-switch">
        <button type="button" className="link-btn" onClick={onBack}>
          ‹ Use a different email
        </button>
      </p>
    </div>
  );
}

function Field({
  label,
  hint,
  action,
  status,
  children,
}: {
  label: string;
  hint?: string;
  action?: React.ReactNode;
  status?: { tone: "good" | "bad" | "warn" | "muted"; text: string };
  children: React.ReactNode;
}) {
  return (
    <label className="field-block">
      <span className="field-label-row">
        <span className="field-label">{label}</span>
        {action}
        {status && <span className={`field-status field-status-${status.tone}`}>{status.text}</span>}
      </span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

type UsernameStatus = "idle" | "checking" | "free" | "taken";

/** Debounced availability check against the `username_available` RPC — a security-definer
 *  function that answers taken/not-taken without exposing the profiles table to anonymous
 *  visitors, who is exactly who is filling in this form. */
function useUsernameAvailability(username: string): UsernameStatus {
  const [status, setStatus] = useState<UsernameStatus>("idle");
  const latest = useRef(0);

  useEffect(() => {
    if (!/^[a-z0-9_]{3,24}$/.test(username)) {
      setStatus("idle");
      return;
    }
    setStatus("checking");
    const ticket = ++latest.current;
    const timer = window.setTimeout(async () => {
      const { data, error } = await supabase.rpc("username_available", { candidate: username });
      if (ticket !== latest.current) return; // a newer keystroke already superseded this check
      if (error) setStatus("idle");
      else setStatus(data ? "free" : "taken");
    }, 350);

    return () => window.clearTimeout(timer);
  }, [username]);

  return status;
}

function scorePassword(password: string): { pct: number; level: "weak" | "ok" | "good"; label: string } {
  let points = Math.min(password.length, 16) / 16;
  if (/[a-z]/.test(password) && /[A-Z]/.test(password)) points += 0.2;
  if (/\d/.test(password)) points += 0.15;
  if (/[^\w\s]/.test(password)) points += 0.25;

  const pct = Math.min(100, Math.round(points * 100));
  if (password.length < 8) return { pct, level: "weak", label: "Too short" };
  if (pct < 55) return { pct, level: "weak", label: "Weak" };
  if (pct < 80) return { pct, level: "ok", label: "Decent" };
  return { pct, level: "good", label: "Strong" };
}

/** Supabase's raw messages are accurate but terse ("Invalid login credentials"), and a couple of
 *  them describe a configuration problem the person signing in can't act on. Translate the ones
 *  that actually come up. */
function friendlyAuthError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/invalid login credentials/i.test(message)) return "That email and password don't match an account.";
  if (/email not confirmed/i.test(message)) return "Confirm your email first — check your inbox for the link.";
  if (/user already registered/i.test(message)) return "An account with that email already exists. Sign in instead.";
  if (/rate limit|too many/i.test(message)) return "Too many attempts. Wait a minute and try again.";
  if (/password/i.test(message) && /least/i.test(message)) return "Password must be at least 8 characters.";
  if (/fetch|network/i.test(message)) return "Couldn't reach the server. Check your connection.";
  return message;
}
