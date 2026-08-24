# Human escalation tickets, interface design

## Summary

The embedded admin app uses one lively Nailzify workspace for Knowledge Base and Tickets. It keeps the current workflows and data, but replaces the plain utility page with clearer hierarchy, warmer surfaces, useful visual status, and polished responsive behavior.

## Source of truth

This feature extends the existing embedded Shopify admin page in `web/admin`. The storefront widget remains the visual reference for the berry, blush, cream, and green palette. The admin app translates that personality into a focused workspace with stronger contrast and less decoration around dense support work.

No new component library or image dependency is required. Interface icons use small inline SVG elements. All values come from the existing upload and ticket responses.

## Shared app shell

1. Use a soft cream background with subtle radial color washes. Keep all working surfaces white or lightly tinted.
2. Present the Nailzify identity, product name, and short workspace description in a compact brand block.
3. Present `Knowledge Base` and `Tickets` as large icon tabs inside one rounded navigation control. The active tab uses the berry accent and a clear selected state.
4. Use a centered content width that fills the Shopify frame without creating long text lines.
5. Use cards with gentle borders, shadows, and rounded corners. Avoid flat tables floating on an empty white page.
6. Provide visible keyboard focus on every interactive element and honor reduced motion preferences.

## Knowledge Base

1. Open with a small section label, a confident page title, and concise guidance. Show document totals derived from the loaded document list.
2. Place upload controls in a prominent card. The purpose input and PDF picker each have a visible label, supporting copy, and a large touch target.
3. Show the selected filename in a custom file picker surface. Keep the native file input available to assistive technology.
4. Disable the upload action until both a purpose and a PDF are selected. Show the current upload state in the button.
5. Present existing documents in a framed library card. Each row includes a PDF icon, title, type, updated time, status badge, and a quiet delete action.
6. On narrow screens, replace the table layout with stacked document cards that keep every value and action readable without horizontal scrolling.
7. Empty, loading, processing, failed, and ready states each have distinct copy and color. Color is never the only status signal.

## Ticket queue

1. Open with a page title, queue count, short description, and a refresh action.
2. Present lifecycle filters as responsive segmented chips with counts for the currently loaded view where a reliable count exists.
3. Render each ticket as a roomy selectable card, not a plain row. Show requester initial, subject, requester, ticket number, status, priority, and last update.
4. Use priority as a small labeled badge. Urgent and high priority receive stronger visual treatment without making normal tickets feel inactive.
5. Hover, focus, and pressed states make it obvious that the complete card opens the ticket.
6. The default `Active` view includes `new`, `open`, `pending`, and `hold`. The oldest active work remains first.

## Ticket workspace

1. Use a clear back action and a compact ticket hero containing number, subject, status, requester, and last update.
2. Keep the main two column layout. The conversation column is fluid and the customer sidebar remains visible while scrolling on wide screens.
3. Present the handoff summary as a tinted context card with separate reason and customer detail blocks.
4. Present transcript messages as compact chat bubbles inside a disclosure panel.
5. Present public messages as conversation cards with sender initials, channel, time, and delivery state. Present private notes on a warm yellow surface.
6. Present system and notification events as a lighter activity rail. Failed notifications show the reason and a clear retry action.
7. Give the reply composer a strong mode switch, generous writing area, clear status outcome, and prominent primary action.
8. Group customer identity and ticket controls in separate sidebar sections so editable controls do not blend into metadata.

## Responsive behavior

At widths below 820 pixels, the sidebar moves above the conversation, headings stack, filters scroll or wrap, and actions remain reachable. At widths below 620 pixels, the header navigation fills the available width, document rows become cards, ticket metadata stacks, and composer actions become a single column. No supported view requires horizontal page scrolling.

## Accessibility and motion

1. Interactive controls have at least a 40 pixel target and a visible `:focus-visible` ring.
2. Text and meaningful badges meet WCAG AA contrast against their surfaces.
3. Status labels remain readable without color.
4. Decorative icons are hidden from assistive technology. Meaningful icon buttons include an accessible label.
5. Use only short opacity and position transitions. Disable them through `prefers-reduced-motion`.

## Migration

This is a direct presentation update. It does not change routes, API contracts, stored data, ticket behavior, or document behavior. Rollback is one admin bundle deployment.
