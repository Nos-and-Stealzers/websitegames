import { useState } from "react";
import { useAuth } from "../auth/AuthProvider";
import type { Profile } from "../lib/database.types";
import { Icon } from "../ui/Icon";

export function AccountMenu({
  profile,
  onOpenSettings,
  onOpenHelp,
}: {
  profile: Profile | null;
  onOpenSettings: () => void;
  onOpenHelp: () => void;
}) {
  const { signOut } = useAuth();
  const [open, setOpen] = useState(false);

  const initial = (profile?.display_name || profile?.username || "?").charAt(0).toUpperCase();

  return (
    <div className="account-menu">
      <button className="account-chip" onClick={() => setOpen((v) => !v)}>
        {profile?.avatar_url ? (
          <img className="identity-avatar" src={profile.avatar_url} alt="" referrerPolicy="no-referrer" />
        ) : (
          <span className="identity-initial">{initial}</span>
        )}
        <span className="account-chip-name">{profile?.display_name || profile?.username || "Account"}</span>
        <Icon name="chevron-down" size={14} />
      </button>

      {open && (
        <>
          <div className="menu-scrim" onClick={() => setOpen(false)} />
          <div className="dropdown-menu dropdown-menu-right">
            <div className="dropdown-header">
              <span className="dropdown-header-name">{profile?.display_name || profile?.username}</span>
              <span className="dropdown-header-sub">@{profile?.username}</span>
            </div>
            <button
              className="dropdown-item"
              onClick={() => {
                setOpen(false);
                onOpenSettings();
              }}
            >
              <Icon name="settings" size={15} />
              Account settings
            </button>
            <button
              className="dropdown-item"
              onClick={() => {
                setOpen(false);
                onOpenHelp();
              }}
            >
              <Icon name="help-circle" size={15} />
              Help
            </button>
            <button className="dropdown-item dropdown-item-danger" onClick={() => void signOut()}>
              <Icon name="logout" size={15} />
              Sign out
            </button>
          </div>
        </>
      )}
    </div>
  );
}
