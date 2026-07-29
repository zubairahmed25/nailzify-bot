import { beforeEach, describe, expect, it, vi } from "vitest";

// sessionStorage does not exist in the node test environment.
const store = new Map<string, string>();
vi.stubGlobal("sessionStorage", {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
});

const { loadPersistedState, savePersistedState } = await import(
  "/Users/zubair/Desktop/nailzify-bot/web/widget/src/persistence.js"
);

const msg = (id: string) => ({ id, role: "customer" as const, text: `m${id}` });

beforeEach(() => store.clear());

describe("conversation survives a page navigation", () => {
  it("round-trips messages and panel state", () => {
    // THE BUG: tapping a product card is a full navigation. The widget is
    // destroyed and remounts with empty state, so the customer follows a
    // recommendation and their conversation vanishes.
    savePersistedState({ open: true, messages: [msg("a"), msg("b")] });

    const restored = loadPersistedState();
    expect(restored.open).toBe(true);
    expect(restored.messages.map((m) => m.id)).toEqual(["a", "b"]);
  });

  it("returns empty state when nothing is stored", () => {
    expect(loadPersistedState()).toEqual({ open: false, messages: [] });
  });

  it("discards malformed stored state rather than rendering it", () => {
    // A value we wrote is still untrusted input — a previous version's shape
    // would throw somewhere deep inside render.
    store.set("nailzify.chat.state", '{"open":true,"messages":"not-an-array"}');
    expect(loadPersistedState()).toEqual({ open: false, messages: [] });

    store.set("nailzify.chat.state", "definitely not json");
    expect(loadPersistedState()).toEqual({ open: false, messages: [] });
  });

  it("keeps only the tail of a long conversation", () => {
    // sessionStorage is ~5MB and product cards are not small. The recent
    // exchange is what matters on landing; the server holds the full history.
    savePersistedState({
      open: true,
      messages: Array.from({ length: 50 }, (_, i) => msg(String(i))),
    });

    const restored = loadPersistedState();
    expect(restored.messages).toHaveLength(30);
    expect(restored.messages[restored.messages.length - 1]!.id).toBe("49");
  });

  it("survives sessionStorage throwing", () => {
    // Safari private mode. Losing continuity beats the widget throwing.
    vi.stubGlobal("sessionStorage", {
      getItem: () => { throw new Error("denied"); },
      setItem: () => { throw new Error("denied"); },
    });

    expect(() => savePersistedState({ open: true, messages: [msg("a")] })).not.toThrow();
    expect(loadPersistedState()).toEqual({ open: false, messages: [] });
  });
});
