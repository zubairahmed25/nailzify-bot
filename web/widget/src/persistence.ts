/**
 * Keeping the conversation alive across a page navigation.
 *
 * Pure — no React, no DOM beyond sessionStorage — so it is testable directly.
 */

import type { ChatMessage } from "./types.js";

/** Matches the server's ID_PATTERN: 8-64 chars of [A-Za-z0-9_-]. */
const SESSION_KEY = "nailzify.chat.session";

/**
 * The rendered conversation, so it survives a page navigation.
 *
 * ⚠️ THE WIDGET IS DESTROYED BY EVERY NAVIGATION. Clicking a product card loads
 * a new page, the script runs again, and React state starts empty — the customer
 * taps a recommendation and their conversation is gone.
 *
 * The SESSION id already survived here, so the server never lost anything; only
 * what was on screen did. That is the worse half to lose: the customer cannot
 * see that the bot still remembers.
 *
 * sessionStorage, not localStorage, on purpose. It is scoped to the tab and
 * cleared when the tab closes, which matches how long a shopping conversation is
 * actually relevant — and means a shared computer does not show the next person
 * what the last one asked.
 */
const STATE_KEY = "nailzify.chat.state";

/**
 * Cap on persisted turns.
 *
 * sessionStorage is ~5MB and a long conversation with product cards is not
 * small. Keeping the tail is right: the recent exchange is what the customer
 * needs to see on landing, and the server holds the full history regardless.
 */
const MAX_PERSISTED = 30;

interface PersistedState {
  readonly open: boolean;
  readonly messages: readonly ChatMessage[];
}

export function loadPersistedState(): PersistedState {
  try {
    const raw = sessionStorage.getItem(STATE_KEY);
    if (!raw) return { open: false, messages: [] };
    const parsed = JSON.parse(raw) as PersistedState;
    // Anything malformed is discarded rather than rendered. A storage value is
    // not trusted input just because we wrote it — a previous version's shape
    // would throw somewhere deep in render.
    if (!Array.isArray(parsed.messages)) return { open: false, messages: [] };
    return { open: parsed.open === true, messages: parsed.messages };
  } catch {
    return { open: false, messages: [] };
  }
}

export function savePersistedState(state: PersistedState): void {
  try {
    sessionStorage.setItem(
      STATE_KEY,
      JSON.stringify({ open: state.open, messages: state.messages.slice(-MAX_PERSISTED) }),
    );
  } catch {
    // Safari private mode, or a full quota. Losing continuity across a
    // navigation is far better than the widget throwing on every message.
  }
}

/**
 * Mark the panel closed without touching the conversation.
 *
 * ⚠️ WHY A SEPARATE FUNCTION INSTEAD OF setOpen(false) IN REACT. Clicking a
 * product card is a real `<a href>` — the browser starts navigating to a new
 * page as soon as the click handler returns. React state updates are batched
 * and applied on the NEXT render, which may never happen: the page can already
 * be gone by then. This writes to sessionStorage directly and synchronously,
 * so it is guaranteed to land before the browser unloads the page.
 *
 * Reads the current persisted state first rather than taking `messages` as a
 * parameter, so a component that only knows about ONE product (ProductCard has
 * no view of the whole conversation) can still flip this one field correctly.
 */
export function setPersistedOpen(open: boolean): void {
  savePersistedState({ ...loadPersistedState(), open });
}

export type Status = "idle" | "thinking" | "streaming" | "error";

export function newId(): string {
  // crypto.randomUUID is unavailable on http:// origins and in older Safari.
  // A storefront runs on https, but a merchant previewing over http is a real
  // case and a hard crash there is a bad way to find out.
  const uuid =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return uuid.replace(/-/g, "").slice(0, 32);
}

export function loadSessionId(): string {
  try {
    const stored = sessionStorage.getItem(SESSION_KEY);
    if (stored) return stored;
    const created = newId();
    sessionStorage.setItem(SESSION_KEY, created);
    return created;
  } catch {
    // Safari in private mode throws on sessionStorage. Losing continuity across
    // a reload is a far smaller problem than the widget failing to load at all.
    return newId();
  }
}
