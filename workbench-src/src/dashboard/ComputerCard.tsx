import { useRef, useState } from "react";
import { isComputerOnline } from "../data/computers";
import type { ComputerEntry } from "../data/computers";
import { Icon } from "../ui/Icon";

export function ComputerCard({
  entry,
  onConnect,
  onRename,
  onRemove,
  onShare,
  onSetPin,
}: {
  entry: ComputerEntry;
  onConnect: () => void;
  onRename: (name: string) => void;
  onRemove: () => void;
  onShare?: () => void;
  onSetPin?: () => void;
}) {
  const { computer, role } = entry;
  const online = isComputerOnline(computer);

  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(computer.name);
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const commit = () => {
    const trimmed = value.trim();
    setEditing(false);
    if (trimmed && trimmed !== computer.name) onRename(trimmed);
    else setValue(computer.name);
  };

  return (
    <div className={`computer-card ${online ? "computer-card-online" : ""}`}>
      <button
        className="computer-card-hit"
        onClick={onConnect}
        disabled={!online}
        aria-label={`Connect to ${computer.name}`}
      />

      <div className="computer-card-top">
        <div className={`computer-glyph ${online ? "computer-glyph-online" : ""}`}>
          <Icon name="monitor" size={22} />
        </div>
        <span className={`status-chip ${online ? "status-chip-online" : "status-chip-offline"}`}>
          <span className="status-chip-dot" />
          {online ? "Online" : "Offline"}
        </span>
      </div>

      <div className="computer-card-body">
        {editing ? (
          <input
            id="computer-name-edit"
            name="computerName"
            ref={inputRef}
            className="field computer-name-input"
            value={value}
            autoFocus
            spellCheck={false}
            onChange={(e) => setValue(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit();
              if (e.key === "Escape") {
                setValue(computer.name);
                setEditing(false);
              }
            }}
          />
        ) : (
          <h3 className="computer-name" title={computer.name}>
            {computer.name}
          </h3>
        )}
        <p className="computer-meta">
          {role === "owner" ? "You own this" : "Shared with you"}
          {computer.os && ` · ${computer.os}`}
        </p>
        {computer.screen_width && computer.screen_height && (
          <p className="computer-meta computer-meta-muted">
            {computer.screen_width}×{computer.screen_height}
            {computer.monitor_count > 1 && ` · ${computer.monitor_count} monitors`}
          </p>
        )}
      </div>

      <div className="computer-card-actions">
        <button className="btn btn-primary computer-connect-btn" onClick={onConnect} disabled={!online}>
          {online ? "Connect" : "Offline"}
        </button>

        <div className="computer-card-menu">
          <button
            className="icon-btn"
            aria-label="More options"
            onClick={(e) => {
              e.stopPropagation();
              setMenuOpen((v) => !v);
            }}
          >
            <Icon name="more" size={16} />
          </button>

          {menuOpen && (
            <>
              <div className="menu-scrim" onClick={() => setMenuOpen(false)} />
              <div className="dropdown-menu" onClick={(e) => e.stopPropagation()}>
                <button
                  className="dropdown-item"
                  onClick={() => {
                    setMenuOpen(false);
                    setEditing(true);
                    requestAnimationFrame(() => inputRef.current?.select());
                  }}
                >
                  <Icon name="pencil" size={15} />
                  Rename
                </button>
                {onShare && (
                  <button
                    className="dropdown-item"
                    onClick={() => {
                      setMenuOpen(false);
                      onShare();
                    }}
                  >
                    <Icon name="share" size={15} />
                    Share access
                  </button>
                )}
                {onSetPin && (
                  <button
                    className="dropdown-item"
                    onClick={() => {
                      setMenuOpen(false);
                      onSetPin();
                    }}
                  >
                    <Icon name="lock" size={15} />
                    {computer.pin_hash ? "Change connect PIN" : "Set a connect PIN"}
                  </button>
                )}
                {confirmingRemove ? (
                  <button
                    className="dropdown-item dropdown-item-danger"
                    onClick={() => {
                      setMenuOpen(false);
                      onRemove();
                    }}
                  >
                    <Icon name="trash" size={15} />
                    Confirm {role === "owner" ? "delete" : "remove"}
                  </button>
                ) : (
                  <button className="dropdown-item dropdown-item-danger" onClick={() => setConfirmingRemove(true)}>
                    <Icon name="trash" size={15} />
                    {role === "owner" ? "Delete computer" : "Remove from list"}
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
