/** Stable commands behind the quick action pills. */
export type ServerQuickActionIntent =
  | "help_choose"
  | "current_promos"
  | "wear_care"
  | "my_order"
  | "best_sellers";

export type QuickActionIntent = ServerQuickActionIntent | "other";

export interface QuickActionDefinition {
  readonly intent: QuickActionIntent;
  readonly title: string;
  readonly subtitle: string;
  readonly icon?: boolean;
}

export const OTHER_PROMPT = "What else can I help you with today?";

export const QUICK_ACTIONS: readonly QuickActionDefinition[] = [
  {
    intent: "help_choose",
    title: "Help me choose",
    subtitle: "Shape, length, occasion",
    icon: true,
  },
  {
    intent: "current_promos",
    title: "Current promos",
    subtitle: "Bundles, offers, free shipping",
  },
  {
    intent: "wear_care",
    title: "Wear & care",
    subtitle: "Apply, reuse, remove safely",
  },
  { intent: "my_order", title: "My order", subtitle: "Track, change or return" },
  {
    intent: "best_sellers",
    title: "Best sellers",
    subtitle: "This week's most-loved sets",
  },
  { intent: "other", title: "Other", subtitle: "Ask me anything else" },
];
