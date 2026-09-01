import { useEffect } from "react";
import { Icon, type IconName } from "./Icon";

/** The one modal shell used everywhere (share, setup, connect-by-id). A centered card on desktop,
 *  a full-width bottom sheet on a phone — see .sheet-backdrop / .sheet in App.css — because a
 *  centered dialog on a 375px-wide screen wastes half the available width on margins. */
export function Sheet({
  title,
  icon,
  onClose,
  children,
}: {
  title: string;
  icon?: IconName;
  onClose: () => void;
  children: React.ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-header">
          <h2>
            {icon && <Icon name={icon} size={18} />}
            {title}
          </h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <Icon name="x" size={18} />
          </button>
        </div>
        <div className="sheet-body">{children}</div>
      </div>
    </div>
  );
}
