/**
 * The six quick actions, in two forms (design_handoff_ai_concierge, 1a, plus
 * a follow-up: the handoff only specified the resting-state grid — customers
 * asked to still see these once they'd sent a first message, so the compact
 * bar is this project's own addition, not part of the original handoff).
 *
 * Clicking either form sends the action's TITLE as the customer's message,
 * verbatim — the same `send()` every typed question goes through. There is
 * no separate "intent" wiring: a title like "Help me pick" reaches the model
 * as an ordinary message, and the system prompt's own "ask before searching
 * only when you genuinely cannot construct a query" rule is what turns that
 * into a clarifying question rather than a blind search.
 */
const ACTIONS: readonly { title: string; subtitle: string }[] = [
  { title: "Help me pick", subtitle: "Shape, length, occasion" },
  { title: "Current promos", subtitle: "Bundles, offers, free shipping" },
  { title: "Wear & care", subtitle: "Apply, reuse, remove safely" },
  { title: "My order", subtitle: "Track, change or return" },
  { title: "Best sellers", subtitle: "This week's most-loved sets" },
  { title: "Other", subtitle: "Ask me anything else" },
];

interface QuickActionProps {
  onSelect: (title: string) => void;
  disabled: boolean;
}

/**
 * The full 2-column card grid. Resting state only — before the first
 * message, per the handoff: "greeting + quick actions is the resting
 * state." Once the customer has sent anything, `QuickActionsBar` below takes
 * over for the rest of the conversation.
 */
export function QuickActions({ onSelect, disabled }: QuickActionProps) {
  return (
    <div class="nz-quick-actions">
      {ACTIONS.map((action) => (
        <button
          key={action.title}
          type="button"
          class="nz-quick-action"
          disabled={disabled}
          onClick={() => onSelect(action.title)}
        >
          <span class="nz-quick-action__title">{action.title}</span>
          <span class="nz-quick-action__subtitle">{action.subtitle}</span>
        </button>
      ))}
    </div>
  );
}

/**
 * A compact, horizontally-scrolling pill row, pinned above the composer for
 * the rest of the conversation once it has started. Titles only — there is
 * no room for the grid's subtitles at this size, and the customer has
 * already seen them once in the resting-state grid.
 */
export function QuickActionsBar({ onSelect, disabled }: QuickActionProps) {
  return (
    <div class="nz-quick-bar" role="group" aria-label="Quick questions">
      {ACTIONS.map((action) => (
        <button
          key={action.title}
          type="button"
          class="nz-quick-bar__pill"
          disabled={disabled}
          onClick={() => onSelect(action.title)}
        >
          {action.title}
        </button>
      ))}
    </div>
  );
}
