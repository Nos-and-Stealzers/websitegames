// One inline SVG sprite as a component. Inline rather than an <img>/icon font so icons inherit
// currentColor (they sit on buttons in half a dozen states) and cost no extra request.
//
// Every path is drawn on the same 24x24 grid with a 1.7 stroke and round caps, which is what makes
// a mixed row of them — a gauge next to a keyboard next to an X — look like one set.

export type IconName =
  | "alert"
  | "arrow-left"
  | "bolt"
  | "check"
  | "chevron-down"
  | "clipboard"
  | "copy"
  | "download"
  | "expand"
  | "eye"
  | "eye-off"
  | "gauge"
  | "help-circle"
  | "info"
  | "key"
  | "keyboard"
  | "link"
  | "lock"
  | "logout"
  | "mail"
  | "minimize"
  | "monitor"
  | "more"
  | "mouse"
  | "pencil"
  | "plug"
  | "plus"
  | "power"
  | "refresh"
  | "search"
  | "settings"
  | "share"
  | "sliders"
  | "trash"
  | "users"
  | "wifi"
  | "x";

const PATHS: Record<IconName, React.ReactNode> = {
  alert: (
    <>
      <path d="M12 8.5v4.2" />
      <path d="M12 16.4h.01" />
      <path d="M10.3 3.9 2.6 17.4A2 2 0 0 0 4.3 20.4h15.4a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
    </>
  ),
  "arrow-left": <path d="M19 12H5m0 0 6-6m-6 6 6 6" />,
  bolt: <path d="M13 2 4.5 13.2A.7.7 0 0 0 5 14.3h5.4l-1.4 7.6a.35.35 0 0 0 .62.28L19.5 10.8a.7.7 0 0 0-.55-1.13H13.5L14.6 2.3a.35.35 0 0 0-.6-.3Z" />,
  check: <path d="m4.5 12.5 5 5 10-11" />,
  "chevron-down": <path d="m6 9.5 6 6 6-6" />,
  clipboard: (
    <>
      <rect x="8" y="3" width="8" height="4" rx="1.3" />
      <path d="M8 5H6a2 2 0 0 0-2 2v12.5a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2" />
    </>
  ),
  copy: (
    <>
      <rect x="9" y="9" width="12" height="12" rx="2.2" />
      <path d="M15 5.5A2.5 2.5 0 0 0 12.5 3H5.5A2.5 2.5 0 0 0 3 5.5v7A2.5 2.5 0 0 0 5.5 15" />
    </>
  ),
  download: <path d="M12 3.5v11m0 0-4.2-4.2M12 14.5l4.2-4.2M4 19.5h16" />,
  expand: <path d="M4 9V5.8A1.8 1.8 0 0 1 5.8 4H9M20 9V5.8A1.8 1.8 0 0 0 18.2 4H15M4 15v3.2A1.8 1.8 0 0 0 5.8 20H9m11-5v3.2A1.8 1.8 0 0 1 18.2 20H15" />,
  eye: (
    <>
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  "eye-off": (
    <>
      <path d="M9.9 5.8A9.5 9.5 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a17 17 0 0 1-3 3.9M6.5 7.6A17 17 0 0 0 2.5 12S6 18.5 12 18.5a9.4 9.4 0 0 0 3.5-.65" />
      <path d="M10 10a2.8 2.8 0 0 0 4 4" />
      <path d="m3.5 3.5 17 17" />
    </>
  ),
  gauge: (
    <>
      <path d="M4 18a9 9 0 1 1 16 0" />
      <path d="m12 14 4-4" />
      <circle cx="12" cy="15" r="1.4" />
    </>
  ),
  "help-circle": (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M9.2 9.3a2.8 2.8 0 0 1 5.4.9c0 1.9-2.6 2.1-2.6 3.8" />
      <path d="M12 16.8h.01" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5.2M12 7.9h.01" />
    </>
  ),
  key: (
    <>
      <circle cx="8" cy="13" r="4" />
      <path d="m11 11 8.5-8.5M17 5l2.5 2.5M14.5 7.5 17 10" />
    </>
  ),
  keyboard: (
    <>
      <rect x="2.5" y="6" width="19" height="12" rx="2.2" />
      <path d="M6 10h.01M9.5 10h.01M13 10h.01M16.5 10h.01M6 13.6h.01M18 13.6h.01M9.4 13.6h5.2" />
    </>
  ),
  link: <path d="M10.5 13.5a4 4 0 0 0 5.7 0l2.6-2.6a4 4 0 0 0-5.7-5.7l-1.3 1.3M13.5 10.5a4 4 0 0 0-5.7 0l-2.6 2.6a4 4 0 0 0 5.7 5.7l1.3-1.3" />,
  lock: (
    <>
      <rect x="4.5" y="10.5" width="15" height="10" rx="2.2" />
      <path d="M8 10.5V7.8a4 4 0 0 1 8 0v2.7" />
    </>
  ),
  logout: <path d="M15 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h7a2 2 0 0 0 2-2v-2M10.5 12H21m0 0-3.2-3.2M21 12l-3.2 3.2" />,
  mail: (
    <>
      <rect x="2.5" y="5" width="19" height="14" rx="2.2" />
      <path d="m3.5 7 7.4 5.4a2 2 0 0 0 2.2 0L20.5 7" />
    </>
  ),
  minimize: <path d="M9 4v3.2A1.8 1.8 0 0 1 7.2 9H4m11-5v3.2A1.8 1.8 0 0 0 16.8 9H20M9 20v-3.2A1.8 1.8 0 0 0 7.2 15H4m11 5v-3.2a1.8 1.8 0 0 1 1.8-1.8H20" />,
  monitor: (
    <>
      <rect x="2.5" y="4" width="19" height="13" rx="2" />
      <path d="M8.5 20.5h7M12 17v3.5" />
    </>
  ),
  more: (
    <>
      <circle cx="12" cy="5.5" r="1.4" />
      <circle cx="12" cy="12" r="1.4" />
      <circle cx="12" cy="18.5" r="1.4" />
    </>
  ),
  mouse: (
    <>
      <rect x="6.5" y="2.5" width="11" height="19" rx="5.5" />
      <path d="M12 6.5v3.5" />
    </>
  ),
  pencil: <path d="M4 20h4l10.5-10.5a2.83 2.83 0 0 0-4-4L4 16v4ZM14.5 6.5l3 3" />,
  plug: <path d="M9 3v6m6-6v6M6.5 9h11v3a5.5 5.5 0 0 1-11 0V9ZM12 17.5V21" />,
  plus: <path d="M12 5v14M5 12h14" />,
  power: <path d="M12 3.5v8M7.5 6.4a8 8 0 1 0 9 0" />,
  refresh: <path d="M20 11.5a8 8 0 1 0-.9 4.6M20 4.5V11h-6.5" />,
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m16 16 4.5 4.5" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3.2" />
      <path d="M19.9 14.4a1.6 1.6 0 0 0 .32 1.77l.06.06a1.94 1.94 0 1 1-2.75 2.75l-.06-.06a1.6 1.6 0 0 0-1.77-.32 1.6 1.6 0 0 0-.97 1.46V20a1.94 1.94 0 1 1-3.88 0v-.09a1.6 1.6 0 0 0-1.05-1.46 1.6 1.6 0 0 0-1.77.32l-.06.06a1.94 1.94 0 1 1-2.75-2.75l.06-.06a1.6 1.6 0 0 0 .32-1.77 1.6 1.6 0 0 0-1.46-.97H4a1.94 1.94 0 1 1 0-3.88h.09a1.6 1.6 0 0 0 1.46-1.05 1.6 1.6 0 0 0-.32-1.77l-.06-.06a1.94 1.94 0 1 1 2.75-2.75l.06.06a1.6 1.6 0 0 0 1.77.32h.08a1.6 1.6 0 0 0 .97-1.46V4a1.94 1.94 0 1 1 3.88 0v.09a1.6 1.6 0 0 0 .97 1.46 1.6 1.6 0 0 0 1.77-.32l.06-.06a1.94 1.94 0 1 1 2.75 2.75l-.06.06a1.6 1.6 0 0 0-.32 1.77v.08a1.6 1.6 0 0 0 1.46.97H20a1.94 1.94 0 1 1 0 3.88h-.09a1.6 1.6 0 0 0-1.46.97Z" />
    </>
  ),
  share: (
    <>
      <circle cx="17.5" cy="5.5" r="2.8" />
      <circle cx="6.5" cy="12" r="2.8" />
      <circle cx="17.5" cy="18.5" r="2.8" />
      <path d="m9 10.6 6-3.5m-6 5.8 6 3.5" />
    </>
  ),
  sliders: <path d="M4 7h9m3 0h4M4 17h4m3 0h9M14.5 7a1.7 1.7 0 1 0 3.4 0 1.7 1.7 0 0 0-3.4 0ZM6.1 17a1.7 1.7 0 1 0 3.4 0 1.7 1.7 0 0 0-3.4 0Z" />,
  trash: <path d="M4.5 6.5h15M9.5 6.5V5a1.5 1.5 0 0 1 1.5-1.5h2A1.5 1.5 0 0 1 14.5 5v1.5M6.5 6.5 7.3 19a2 2 0 0 0 2 1.9h5.4a2 2 0 0 0 2-1.9l.8-12.5M10 10.5v6M14 10.5v6" />,
  users: (
    <>
      <circle cx="9.5" cy="8" r="3.5" />
      <path d="M3 20a6.5 6.5 0 0 1 13 0" />
      <path d="M16.5 5.2a3.5 3.5 0 0 1 0 5.6M18 14.4a6.5 6.5 0 0 1 3 5.6" />
    </>
  ),
  wifi: <path d="M2.8 9.2a14 14 0 0 1 18.4 0M6 12.6a9.2 9.2 0 0 1 12 0M9.2 16a4.6 4.6 0 0 1 5.6 0M12 19.5h.01" />,
  x: <path d="M18 6 6 18M6 6l12 12" />,
};

export function Icon({ name, size = 18, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg
      className={className ? `icon ${className}` : "icon"}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}
