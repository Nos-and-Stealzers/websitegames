import { useCallback, useEffect, useState } from "react";
import { useAuth } from "../auth/AuthProvider";
import {
  findProfileByUsername,
  listGrants,
  revokeAccess,
  shareComputer,
  type Grant,
} from "../data/computers";
import type { ComputerEntry } from "../data/computers";
import { Sheet } from "../ui/Sheet";
import { Icon } from "../ui/Icon";
import { Spinner } from "../ui/Spinner";
import { useToast } from "../ui/Toasts";

/** Owner-only panel: who can reach this computer, and a box to grant one more person by their
 *  @username. This — plus the revoke button next to each name — is the entire "share and revoke
 *  from the web" story; nothing here ever requires going back to the machine. */
export function ShareSheet({ entry, onClose }: { entry: ComputerEntry; onClose: () => void }) {
  const { profile: me } = useAuth();
  const toast = useToast();

  const [grants, setGrants] = useState<Grant[] | null>(null);
  const [username, setUsername] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setGrants(await listGrants(entry.computer.id));
  }, [entry.computer.id]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const invite = async (e: React.FormEvent) => {
    e.preventDefault();
    const handle = username.trim().replace(/^@/, "");
    if (!handle) return;

    setBusy(true);
    setError(null);
    try {
      const target = await findProfileByUsername(handle);
      if (!target) {
        setError(`No account found for @${handle}.`);
        return;
      }
      if (target.id === me?.id) {
        setError("That's your own account.");
        return;
      }
      await shareComputer(entry.computer.id, target.id);
      setUsername("");
      await refresh();
      toast(`Shared with @${target.username}.`, "good");
    } catch {
      setError("Couldn't share right now. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (grant: Grant) => {
    setGrants((cur) => cur?.filter((g) => g.accessId !== grant.accessId) ?? cur);
    try {
      await revokeAccess(grant.accessId);
      toast(`Revoked ${grant.profile ? "@" + grant.profile.username : "access"}.`, "good");
    } catch {
      toast("Couldn't revoke access — refreshing the list.", "bad");
      void refresh();
    }
  };

  return (
    <Sheet title={`Share “${entry.computer.name}”`} onClose={onClose} icon="share">
      <p className="sheet-lede">
        Anyone you add here can connect the instant they sign in — no code, no waiting on the
        computer. Revoking takes effect on their very next connection attempt.
      </p>

      <form className="invite-row" onSubmit={invite}>
        <div className="field-prefixed" style={{ flex: 1 }}>
          <span className="field-prefix">@</span>
          <input
            id="invite-username"
            name="inviteUsername"
            className="field"
            value={username}
            onChange={(e) => setUsername(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ""))}
            placeholder="username"
            spellCheck={false}
            autoCapitalize="off"
          />
        </div>
        <button className="btn btn-primary" type="submit" disabled={busy || !username.trim()}>
          {busy ? <Spinner size={14} /> : <Icon name="plus" size={15} />}
          Add
        </button>
      </form>
      {error && (
        <p className="alert alert-bad">
          <Icon name="alert" size={14} />
          {error}
        </p>
      )}

      <div className="grant-list">
        {grants === null && (
          <div className="dash-loading dash-loading-compact">
            <Spinner size={16} />
            <span>Loading…</span>
          </div>
        )}
        {grants?.map((grant) => (
          <div className="grant-row" key={grant.accessId}>
            <div className="grant-identity">
              <span className="identity-dot" aria-hidden="true" />
              <div>
                <span className="grant-name">{grant.profile?.display_name || grant.profile?.username || "Unknown"}</span>
                <span className="grant-username">@{grant.profile?.username ?? "—"}</span>
              </div>
            </div>
            {grant.role === "owner" ? (
              <span className="chip chip-muted">Owner</span>
            ) : (
              <button className="icon-btn icon-btn-danger" onClick={() => revoke(grant)} aria-label="Revoke access">
                <Icon name="x" size={15} />
              </button>
            )}
          </div>
        ))}
      </div>
    </Sheet>
  );
}
