import { useEffect, useRef, useState } from "react";

/**
 * A single-path nail glyph, next to "Help me pick" only — that's the one
 * action a customer is literally choosing a nail shape from.
 *
 * `fill="currentColor"` rather than the source asset's own pink: the ask was
 * for the icon to match the surrounding text's color exactly (grid title vs.
 * bar pill use two different colors), and `currentColor` tracks whichever
 * one applies without needing two copies. Sized in `em` for the same reason
 * — the glyph should track whatever font-size the text next to it is using.
 */
function NailIcon() {
  return (
    <svg class="nz-quick-icon" viewBox="0 0 70.4 76.48" aria-hidden="true" focusable="false">
      <path
        fill="currentColor"
        d="M44.64,49.3c-.24,0-.52-.14-.61-.52v-20.38c-.12-1.46-.58-2.69-.96-3.6l-.14-.33-.39-.05h-.33s-.23.22-.23.22c-.21.23-.18.52-.17.62-.03.72,0,1.6.03,2.54.06,2.2.13,4.69-.46,6.1-1.09,2.59-3.64,3.51-5.66,3.51h0c-2.86,0-6.04-1.72-6.26-5.51-.06-1.14-.04-2.34,0-3.5.02-1.04.05-2.11,0-3.15.01-.09.04-.37-.17-.6l-.19-.2-.36-.02-.41.05-.14.33c-.39.91-.84,2.14-.95,3.56v20.34c-.06.44-.36.6-.63.6-.12,0-.5-.04-.63-.51v-20.52c.17-2.3,1.06-4.47,2.58-6.23.05-.06.16-.15.27-.26.33-.31.51-.47.6-.67.1-.22.15-.54.21-1.04.03-.21.05-.42.08-.55.64-2.75,2.94-6.72,5.59-7.02.08,0,.2-.01.31-.01s.24,0,.32.01c2.65.3,4.95,4.27,5.59,7.02.03.14.06.34.08.55.07.5.11.81.21,1.04.08.18.23.33.61.68.12.11.23.21.29.28,1.5,1.75,2.38,3.91,2.55,6.24l-.02,20.55c-.17.4-.51.43-.61.43ZM38.45,19.61c-.12,0-.25.01-.38.03-.86.15-1.46.88-1.52,1.87v.04s0,.04,0,.04c.08,1.45.03,3-.02,4.5-.06,1.68-.11,3.42.01,5.06.1,1.28,1.03,1.94,1.91,1.94.83,0,1.52-.55,1.8-1.43l.03-.09-.03-10.62-.04-.1c-.28-.77-.96-1.25-1.78-1.25Z"
      />
    </svg>
  );
}

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
const ACTIONS: readonly { title: string; subtitle: string; icon?: boolean }[] = [
  { title: "Help me pick", subtitle: "Shape, length, occasion", icon: true },
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
          <span class="nz-quick-action__title">
            {action.icon && <NailIcon />}
            {action.title}
          </span>
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
 *
 * Wrapped in a non-scrolling `.nz-quick-bar-wrap` so the edge fades can be
 * pinned to the visible viewport rather than scrolling away with the row —
 * a fade that's a child of the scrolling element itself would slide out of
 * view along with the pills, which defeats the point of it.
 */
export function QuickActionsBar({ onSelect, disabled }: QuickActionProps) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  // Only ever show a fade on the side that actually has more to reveal —
  // a row that fits without scrolling, or is scrolled all the way to one
  // end, shouldn't hint at content that isn't there.
  const [fade, setFade] = useState({ left: false, right: false });

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const EDGE_SLOP = 2; // sub-pixel rounding at fractional scroll positions
    const update = () => {
      setFade({
        left: el.scrollLeft > EDGE_SLOP,
        right: el.scrollLeft + el.clientWidth < el.scrollWidth - EDGE_SLOP,
      });
    };
    update();
    el.addEventListener("scroll", update, { passive: true });
    // The pills themselves never resize, but the panel they sit in can — a
    // desktop viewport resize while the chat is open can flip the row
    // between fitting and overflowing.
    const resizeObserver = new ResizeObserver(update);
    resizeObserver.observe(el);
    return () => {
      el.removeEventListener("scroll", update);
      resizeObserver.disconnect();
    };
  }, []);

  return (
    <div class="nz-quick-bar-wrap">
      <div
        class="nz-quick-bar"
        ref={scrollerRef}
        role="group"
        aria-label="Quick questions"
      >
        {ACTIONS.map((action) => (
          <button
            key={action.title}
            type="button"
            class="nz-quick-bar__pill"
            disabled={disabled}
            onClick={() => onSelect(action.title)}
          >
            {action.icon && <NailIcon />}
            {action.title}
          </button>
        ))}
      </div>
      <div
        class={`nz-quick-bar__fade nz-quick-bar__fade--left${fade.left ? " is-visible" : ""}`}
        aria-hidden="true"
      />
      <div
        class={`nz-quick-bar__fade nz-quick-bar__fade--right${fade.right ? " is-visible" : ""}`}
        aria-hidden="true"
      />
    </div>
  );
}
