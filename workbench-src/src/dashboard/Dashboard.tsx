import { useCallback, useEffect, useState } from "react";
import { useAuth } from "../auth/AuthProvider";
import {
  isComputerOnline,
  listComputers,
  renameComputer,
  deleteComputer,
  leaveComputer,
  subscribeToComputers,
  type ComputerEntry,
} from "../data/computers";
import { Icon } from "../ui/Icon";
import { Spinner } from "../ui/Spinner";
import { useToast } from "../ui/Toasts";
import { ComputerCard } from "./ComputerCard";
import { ShareSheet } from "./ShareSheet";
import { PinSheet } from "./PinSheet";
import { SetupSheet } from "./SetupSheet";
import { ConnectByIdSheet } from "./ConnectByIdSheet";
import { AccountMenu } from "./AccountMenu";

interface DashboardProps {
  onConnect: (hostId: string, name: string, pin?: string) => void;
  onOpenAccountSettings: () => void;
  onOpenHelp: () => void;
}

/** The signed-in landing view. A grid of every computer this account can reach — owned or
 *  shared — with live online status via Supabase Realtime, plus entry points to add a computer
 *  by Host ID or set a new one up. */
export function Dashboard({ onConnect, onOpenAccountSettings, onOpenHelp }: DashboardProps) {
  const { profile } = useAuth();
  const toast = useToast();

  const [entries, setEntries] = useState<ComputerEntry[] | null>(null);
  const [query, setQuery] = useState("");
  const [shareTarget, setShareTarget] = useState<ComputerEntry | null>(null);
  const [pinTarget, setPinTarget] = useState<ComputerEntry | null>(null);
  const [setupOpen, setSetupOpen] = useState(false);
  const [connectOpen, setConnectOpen] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setEntries(await listComputers());
    } catch {
      toast("Couldn't load your computers. Check your connection.", "bad");
    }
  }, [toast]);

  useEffect(() => {
    void refresh();
    // Realtime delivers online/offline flips and new rows the instant the Worker (or another of
    // your own devices) writes them — this is what makes the dot go green without a page reload.
    return subscribeToComputers(() => void refresh());
  }, [refresh]);

  const rename = useCallback(
    async (entry: ComputerEntry, name: string) => {
      const prev = entries;
      setEntries((cur) =>
        cur?.map((e) => (e.computer.id === entry.computer.id ? { ...e, computer: { ...e.computer, name } } : e)) ?? cur,
      );
      try {
        await renameComputer(entry.computer.id, name);
      } catch {
        setEntries(prev);
        toast("Couldn't rename that computer.", "bad");
      }
    },
    [entries, toast],
  );

  const remove = useCallback(
    async (entry: ComputerEntry) => {
      try {
        if (entry.role === "owner") await deleteComputer(entry.computer.id);
        else await leaveComputer(entry.accessId);
        setEntries((cur) => cur?.filter((e) => e.computer.id !== entry.computer.id) ?? cur);
        toast(entry.role === "owner" ? "Computer removed." : "Removed from your list.", "good");
      } catch {
        toast("Couldn't remove that computer.", "bad");
      }
    },
    [toast],
  );

  const filtered = entries?.filter((e) => e.computer.name.toLowerCase().includes(query.trim().toLowerCase()));
  const onlineCount = entries?.filter((e) => isComputerOnline(e.computer)).length ?? 0;

  return (
    <div className="dash">
      <header className="dash-header">
        <div className="dash-brand">
          <span className="brand-mark" aria-hidden="true" />
          <span className="brand-name">PopRemoteDesktop</span>
        </div>
        <AccountMenu profile={profile} onOpenSettings={onOpenAccountSettings} onOpenHelp={onOpenHelp} />
      </header>

      <div className="dash-body">
        <div className="dash-toolbar">
          <div className="dash-title-block">
            <h1>My Computers</h1>
            {entries !== null && (
              <p className="dash-subtitle">
                {entries.length === 0
                  ? "Nothing here yet"
                  : `${entries.length} computer${entries.length === 1 ? "" : "s"} · ${onlineCount} online`}
              </p>
            )}
          </div>

          <div className="dash-actions">
            {entries && entries.length > 0 && (
              <div className="search-field">
                <Icon name="search" size={15} />
                <input
                  id="computer-search"
                  name="computerSearch"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search computers…"
                  spellCheck={false}
                />
              </div>
            )}
            <button className="btn btn-secondary" onClick={() => setConnectOpen(true)}>
              <Icon name="link" size={15} />
              Connect by ID
            </button>
            <button className="btn btn-primary" onClick={() => setSetupOpen(true)}>
              <Icon name="plus" size={15} />
              Add a computer
            </button>
          </div>
        </div>

        {entries === null && (
          <div className="dash-loading">
            <Spinner size={22} />
            <span>Loading your computers…</span>
          </div>
        )}

        {entries !== null && entries.length === 0 && (
          <EmptyState onSetup={() => setSetupOpen(true)} onConnect={() => setConnectOpen(true)} />
        )}

        {entries !== null && entries.length > 0 && filtered?.length === 0 && (
          <p className="dash-empty-search">No computers match "{query}".</p>
        )}

        {filtered && filtered.length > 0 && (
          <div className="computer-grid">
            {filtered.map((entry) => (
              <ComputerCard
                key={entry.computer.id}
                entry={entry}
                onConnect={() => onConnect(entry.computer.host_id, entry.computer.name)}
                onRename={(name) => rename(entry, name)}
                onRemove={() => remove(entry)}
                onShare={entry.role === "owner" ? () => setShareTarget(entry) : undefined}
                onSetPin={entry.role === "owner" ? () => setPinTarget(entry) : undefined}
              />
            ))}
          </div>
        )}
      </div>

      {shareTarget && <ShareSheet entry={shareTarget} onClose={() => setShareTarget(null)} />}
      {pinTarget && (
        <PinSheet entry={pinTarget} onClose={() => setPinTarget(null)} onUpdated={refresh} />
      )}
      {setupOpen && <SetupSheet onClose={() => setSetupOpen(false)} onEnrolled={() => void refresh()} />}
      {connectOpen && (
        <ConnectByIdSheet onClose={() => setConnectOpen(false)} onConnect={(id, pin) => onConnect(id, id, pin)} />
      )}
    </div>
  );
}

function EmptyState({ onSetup, onConnect }: { onSetup: () => void; onConnect: () => void }) {
  return (
    <div className="dash-empty">
      <div className="dash-empty-icon">
        <Icon name="monitor" size={30} />
      </div>
      <h2>No computers yet</h2>
      <p>Set up a computer to make it reachable, or connect to one you've been invited to.</p>
      <div className="dash-empty-actions">
        <button className="btn btn-primary" onClick={onSetup}>
          <Icon name="plus" size={15} />
          Set up this computer
        </button>
        <button className="btn btn-secondary" onClick={onConnect}>
          <Icon name="link" size={15} />
          Connect by Host ID
        </button>
      </div>
    </div>
  );
}
