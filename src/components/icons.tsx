import type { SVGProps } from "react";

type IconName =
  | "server"
  | "browser"
  | "overview"
  | "providers"
  | "models"
  | "chat"
  | "usage"
  | "audit"
  | "users"
  | "settings"
  | "logout"
  | "plus"
  | "check"
  | "x"
  | "up"
  | "down"
  | "key"
  | "lock"
  | "trash"
  | "test"
  | "refresh"
  | "shield"
  | "send"
  | "warning"
  | "menu"
  | "copy"
  | "agents"
  | "manager"
  | "workflow"
  | "git"
  | "stop"
  | "studio"
  | "image"
  | "video"
  | "download"
  | "audio"
  | "render"
  | "bell"
  | "knowledge"
  | "clock"
  | "tool"
  | "upload"
  | "history"
  | "search"
  | "link"
  | "memory"
  | "skill"
  | "api"
  | "file"
  | "folder"
  | "package"
  | "open"
  | "result"
  | "sidebar"
  | "chevron"
  | "chevrons"
  | "sun"
  | "moon"
  | "device"
  | "spark"
  | "dots"
  | "pencil"
  | "sliders"
  | "plan"
  | "admin"
  | "edit"
  | "back"
  | "right"
  | "pin"
  | "list"
  | "bubble"
  | "info"
  | "help";

const paths: Record<IconName, React.ReactNode> = {
  // v2.0: the shell and the conversation.
  sidebar: (
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="3" />
      <path d="M9.5 4.5v15" />
    </>
  ),
  chevron: <path d="m6 9 6 6 6-6" />,
  back: <path d="M19 12H5m6-6-6 6 6 6" />,
  right: <path d="m9 6 6 6-6 6" />,
  pin: <path d="M9 4h6l-1 5.5 3.5 4h-11l3.5-4L9 4ZM12 13.5V20" />,
  list: <path d="M9 6.5h11M9 12h11M9 17.5h11M4.5 6.5h.01M4.5 12h.01M4.5 17.5h.01" />,
  bubble: <path d="M12 4.5c4.4 0 8 3 8 6.8s-3.6 6.8-8 6.8c-.9 0-1.8-.1-2.6-.4L5 19.5l1.1-3.4C4.8 14.9 4 13.2 4 11.3c0-3.8 3.6-6.8 8-6.8Z" />,
  info: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 11v5M12 8h.01" />
    </>
  ),
  chevrons: <path d="m8 9 4-4 4 4M8 15l4 4 4-4" />,
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4" />
    </>
  ),
  moon: <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" />,
  device: (
    <>
      <rect x="3" y="4.5" width="18" height="12" rx="2" />
      <path d="M8.5 20h7M12 16.5V20" />
    </>
  ),
  spark: <path d="M12 3v6m0 6v6M3 12h6m6 0h6M5.6 5.6l4.2 4.2m4.4 4.4 4.2 4.2M18.4 5.6l-4.2 4.2m-4.4 4.4-4.2 4.2" />,
  dots: (
    <>
      <circle cx="5.5" cy="12" r="1" />
      <circle cx="12" cy="12" r="1" />
      <circle cx="18.5" cy="12" r="1" />
    </>
  ),
  pencil: <path d="M4 20h4L19 9l-4-4L4 16v4ZM13.5 6.5l4 4" />,
  sliders: (
    <>
      <path d="M4 7h9m4 0h3M4 17h3m4 0h9" />
      <circle cx="15" cy="7" r="2" />
      <circle cx="9" cy="17" r="2" />
    </>
  ),
  plan: <path d="m12 3 2.6 5.6 6 .7-4.4 4.2 1.2 6-5.4-3-5.4 3 1.2-6L3.4 9.3l6-.7L12 3Z" />,
  admin: (
    <>
      <path d="M12 3 5 6v5c0 4 3 7 7 9 4-2 7-5 7-9V6l-7-3Z" />
      <circle cx="12" cy="10.5" r="2" />
      <path d="M8.8 15.5a3.4 3.4 0 0 1 6.4 0" />
    </>
  ),
  edit: (
    <>
      <path d="M12 5H7a3 3 0 0 0-3 3v9a3 3 0 0 0 3 3h9a3 3 0 0 0 3-3v-5" />
      <path d="M17.5 3.5a2 2 0 0 1 3 3L12 15l-4 1 1-4 8.5-8.5Z" />
    </>
  ),
  help: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .8-1 1.5v.4M12 17h.01" />
    </>
  ),
  overview: <path d="M4 13h7V4H4v9Zm0 7h7v-5H4v5Zm9 0h7v-9h-7v9Zm0-16v5h7V4h-7Z" />,
  providers: (
    <>
      <path d="M9 7V3m6 4V3M8 7h8a0 0 0 0 1 0 0v4a4 4 0 0 1-4 4 4 4 0 0 1-4-4V7Z" />
      <path d="M12 15v6" />
    </>
  ),
  models: (
    <>
      <path d="M12 3 4 7.5v9L12 21l8-4.5v-9L12 3Z" />
      <path d="M4 7.5 12 12l8-4.5M12 12v9" />
    </>
  ),
  chat: <path d="M4 5h16v11H9l-5 4V5Z" />,
  usage: <path d="M4 20V4m0 16h16M8 16v-5m4 5V8m4 8v-3" />,
  audit: (
    <>
      <path d="M12 3 5 6v5c0 4 3 7 7 9 4-2 7-5 7-9V6l-7-3Z" />
      <path d="m9 11 2 2 4-4" />
    </>
  ),
  users: (
    <>
      <path d="M16 19v-1a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v1" />
      <circle cx="9.5" cy="8" r="3" />
      <path d="M21 19v-1a4 4 0 0 0-3-3.87" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 0 1-4 0v-.1A1.6 1.6 0 0 0 7 19.4a1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0-1.1-2.7H1a2 2 0 0 1 0-4h.1A1.6 1.6 0 0 0 2.6 7a1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.6 1.6 0 0 0 7 2.6h.1A1.6 1.6 0 0 0 8.8 1H9a2 2 0 0 1 4 0v.1A1.6 1.6 0 0 0 15 2.6a1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0 1.1 2.7H21a2 2 0 0 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1Z" />
    </>
  ),
  logout: <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4m7 14 5-5-5-5m5 5H9" />,
  plus: <path d="M12 5v14M5 12h14" />,
  check: <path d="m5 12 5 5L20 7" />,
  x: <path d="M6 6l12 12M18 6 6 18" />,
  up: <path d="M12 19V5m-6 6 6-6 6 6" />,
  down: <path d="M12 5v14m6-6-6 6-6-6" />,
  key: (
    <>
      <circle cx="7.5" cy="15.5" r="4.5" />
      <path d="m10.5 12.5 8-8M16 3l3 3-3 3" />
    </>
  ),
  lock: (
    <>
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </>
  ),
  trash: <path d="M4 7h16M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2m-9 0 1 13a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1l1-13" />,
  test: <path d="m7 4 13 8L7 20V4Z" />,
  refresh: <path d="M3 12a9 9 0 0 1 15-6.7L21 8M21 3v5h-5M21 12a9 9 0 0 1-15 6.7L3 16m0 5v-5h5" />,
  shield: <path d="M12 3 5 6v5c0 4 3 7 7 9 4-2 7-5 7-9V6l-7-3Z" />,
  send: <path d="M4 12 20 4l-6 16-3-7-7-1Z" />,
  warning: <path d="M12 3 2 20h20L12 3Zm0 6v5m0 3v.5" />,
  menu: <path d="M4 8.5h16M4 15.5h10" />,
  copy: (
    <>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V5a2 2 0 0 1 2-2h8" />
    </>
  ),
  agents: (
    <>
      <rect x="5" y="8" width="14" height="11" rx="2" />
      <path d="M12 8V4M9 13h.01M15 13h.01M8 19v2M16 19v2" />
    </>
  ),
  manager: (
    <>
      <rect x="9" y="3" width="6" height="5" rx="1" />
      <rect x="3" y="16" width="6" height="5" rx="1" />
      <rect x="15" y="16" width="6" height="5" rx="1" />
      <path d="M12 8v4M6 16v-2a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v2" />
    </>
  ),
  stop: <rect x="6" y="6" width="12" height="12" rx="2" />,
  workflow: (
    <>
      <circle cx="6" cy="6" r="2.5" />
      <circle cx="18" cy="6" r="2.5" />
      <circle cx="12" cy="18" r="2.5" />
      <path d="M6 8.5v3a2 2 0 0 0 2 2h2m8-5v3a2 2 0 0 1-2 2h-2" />
    </>
  ),
  git: (
    <>
      <circle cx="6" cy="6" r="2.5" />
      <circle cx="6" cy="18" r="2.5" />
      <circle cx="18" cy="9" r="2.5" />
      <path d="M6 8.5v7M8.3 7.5 15.5 9M18 11.5c0 3-3 3.5-6 3.5" />
    </>
  ),
  studio: (
    <>
      <path d="m11 3 1.9 5.1L18 10l-5.1 1.9L11 17l-1.9-5.1L4 10l5.1-1.9L11 3Z" />
      <path d="m18.5 15 .8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8.8-2.2Z" />
    </>
  ),
  image: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <circle cx="8.5" cy="10" r="1.5" />
      <path d="m21 15-4.5-4.5L8 19" />
    </>
  ),
  video: (
    <>
      <rect x="3" y="6" width="13" height="12" rx="2" />
      <path d="m16 10.5 5-3v9l-5-3" />
    </>
  ),
  download: <path d="M12 4v11m0 0-4-4m4 4 4-4M5 19h14" />,
  // A voice: sound waves.
  audio: <path d="M4 10v4M8 6v12M12 3v18M16 7v10M20 10v4" />,
  // Clips joined into one strip of film.
  render: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M8 5v14M16 5v14M3 9.5h5M3 14.5h5M16 9.5h5M16 14.5h5" />
    </>
  ),
  bell: <path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4l2-2Zm4 5h4" />,
  knowledge: (
    <>
      <path d="M5 4h10a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3V4Z" />
      <path d="M5 17a3 3 0 0 1 3-3h10M9 8h5" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3.5 2" />
    </>
  ),
  tool: <path d="M14.5 6.5a4 4 0 0 0-5.3 5.3L3 18l3 3 6.2-6.2a4 4 0 0 0 5.3-5.3L15 12l-3-3 2.5-2.5Z" />,
  upload: <path d="M12 16V5m0 0-4 4m4-4 4 4M5 19h14" />,
  history: (
    <>
      <path d="M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5" />
      <path d="M12 8v4l3 2" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m16 16 4.5 4.5" />
    </>
  ),
  link: <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3A4 4 0 0 0 11 18.7l1-1" />,
  skill: (
    <>
      <path d="M12 3 4 7v5c0 4.5 3.2 7.8 8 9 4.8-1.2 8-4.5 8-9V7l-8-4Z" />
      <path d="m9 12 2 2 4-4.5" />
    </>
  ),
  memory: (
    <>
      <path d="M7 3h10a2 2 0 0 1 2 2v16l-7-4-7 4V5a2 2 0 0 1 2-2Z" />
      <path d="M9.5 8h5M9.5 11.5h3" />
    </>
  ),
  api: <path d="m8 8-4 4 4 4m8-8 4 4-4 4M13.5 5l-3 14" />,
  server: (
    <>
      <rect x="3.5" y="4" width="17" height="6.5" rx="1.5" />
      <rect x="3.5" y="13.5" width="17" height="6.5" rx="1.5" />
      <path d="M7 7.25h.01M7 16.75h.01M11 7.25h5.5M11 16.75h5.5" />
    </>
  ),
  browser: (
    <>
      <rect x="3" y="4.5" width="18" height="15" rx="2" />
      <path d="M3 9h18M6.5 6.75h.01M9.5 6.75h.01" />
    </>
  ),
  file: (
    <>
      <path d="M6 3h8l4 4v14H6V3Z" />
      <path d="M14 3v4h4" />
    </>
  ),
  folder: <path d="M3 6h6l2 2h10v11H3V6Z" />,
  package: (
    <>
      <path d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3Z" />
      <path d="m4 7.5 8 4.5 8-4.5M12 12v9" />
    </>
  ),
  open: <path d="M14 4h6v6M20 4l-9 9M18 14v6H4V6h6" />,
  result: (
    <>
      <rect x="3.5" y="4" width="17" height="16" rx="2" />
      <path d="m8 12.5 2.5 2.5L16 9.5" />
    </>
  ),
};

export function Icon({
  name,
  size = 18,
  ...props
}: { name: IconName; size?: number } & SVGProps<SVGSVGElement>) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {paths[name]}
    </svg>
  );
}

export type { IconName };
