/**
 * The six-card resting-state grid (design_handoff_ai_concierge, 1a).
 *
 * Clicking a card sends its TITLE as the customer's message, verbatim — the
 * same `send()` every typed question goes through. There is no separate
 * "intent" wiring: a title like "Help me pick" reaches the model as an
 * ordinary first message, and the system prompt's own "ask before searching
 * only when you genuinely cannot construct a query" rule is what turns that
 * into a clarifying question rather than a blind search.
 *
 * Shown only at the true resting state — before the first message — per the
 * handoff: "greeting + quick actions is the resting state." It does not
 * reappear later in the conversation.
 */
const ACTIONS: readonly { title: string; subtitle: string }[] = [
  { title: "Help me pick", subtitle: "Shape, length, occasion" },
  { title: "Current promos", subtitle: "Bundles, offers, free shipping" },
  { title: "Wear & care", subtitle: "Apply, reuse, remove safely" },
  { title: "My order", subtitle: "Track, change or return" },
  { title: "Best sellers", subtitle: "This week's most-loved sets" },
  { title: "Other", subtitle: "Ask me anything else" },
];

export function QuickActions({
  onSelect,
  disabled,
}: {
  onSelect: (title: string) => void;
  disabled: boolean;
}) {
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
