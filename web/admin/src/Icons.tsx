interface IconProps {
  readonly name:
    | "arrow-left"
    | "book"
    | "check"
    | "chevron-right"
    | "clock"
    | "document"
    | "inbox"
    | "mail"
    | "refresh"
    | "sparkles"
    | "trash"
    | "upload"
    | "user";
  readonly class?: string;
}

export function Icon({ name, class: className = "icon" }: IconProps) {
  const paths = {
    "arrow-left": <><path d="m15 18-6-6 6-6"/><path d="M9 12h10"/></>,
    book: <><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2Z"/></>,
    check: <path d="m5 12 4 4L19 6"/>,
    "chevron-right": <path d="m9 18 6-6-6-6"/>,
    clock: <><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>,
    document: <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/><path d="M8 13h8M8 17h5"/></>,
    inbox: <><path d="M4 4h16v16H4z"/><path d="M4 14h4l2 3h4l2-3h4"/></>,
    mail: <><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/></>,
    refresh: <><path d="M20 11a8 8 0 1 0-2.34 5.66"/><path d="M20 4v7h-7"/></>,
    sparkles: <><path d="m12 3-1.2 3.2L8 8l2.8 1.8L12 13l1.2-3.2L16 8l-2.8-1.8Z"/><path d="m5 14-.8 2.2L2 17.5l2.2 1.3L5 21l.8-2.2 2.2-1.3-2.2-1.3Z"/><path d="m19 13-.7 1.8-1.8.7 1.8.7L19 18l.7-1.8 1.8-.7-1.8-.7Z"/></>,
    trash: <><path d="M3 6h18M8 6V4h8v2M19 6l-1 16H6L5 6"/><path d="M10 11v6M14 11v6"/></>,
    upload: <><path d="M12 16V4M7 9l5-5 5 5"/><path d="M5 20h14"/></>,
    user: <><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></>,
  } as const;

  return (
    <svg
      class={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.8"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}
