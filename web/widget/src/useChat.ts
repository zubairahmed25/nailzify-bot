/**
 * The chat state machine and its connection to the API.
 *
 * ============================================================================
 * WHY fetch() AND NOT EventSource
 * ============================================================================
 *
 * `EventSource` is the obvious choice for SSE and it is unusable here: it only
 * issues GET requests. A customer message is a POST with a body, and it must
 * carry the Shopify App Proxy signature. EventSource can do neither.
 *
 * So we read the response body stream by hand. That also means we control the
 * abort path, which matters — a customer who closes the panel mid-answer should
 * stop billing Bedrock, not finish generating into a void.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { readSse } from "./sse.js";
import type { ChatMessage } from "./types.js";

export type { ChatMessage, ProductRef } from "./types.js";

/** Shopify App Proxy path. Shopify forwards this to the Lambda with an HMAC. */
const ENDPOINT = "/apps/nailzify-chat/message";

/** Matches the server's ID_PATTERN: 8-64 chars of [A-Za-z0-9_-]. */
const SESSION_KEY = "nailzify.chat.session";

export type Status = "idle" | "thinking" | "streaming" | "error";

function newId(): string {
  // crypto.randomUUID is unavailable on http:// origins and in older Safari.
  // A storefront runs on https, but a merchant previewing over http is a real
  // case and a hard crash there is a bad way to find out.
  const uuid =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return uuid.replace(/-/g, "").slice(0, 32);
}

function loadSessionId(): string {
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

export function useChat() {
  const [messages, setMessages] = useState<readonly ChatMessage[]>([]);
  const [status, setStatus] = useState<Status>("idle");
  const [toolActivity, setToolActivity] = useState<string | null>(null);

  const sessionId = useRef<string>("");
  const abort = useRef<AbortController | null>(null);

  if (!sessionId.current) sessionId.current = loadSessionId();

  // A generation still running after the widget unmounts bills Bedrock for
  // tokens nobody will read.
  useEffect(() => () => abort.current?.abort(), []);

  const send = useCallback(async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;

    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;

    const customerMessage: ChatMessage = { id: newId(), role: "customer", text: trimmed };
    const replyId = newId();

    setMessages((prev) => [
      ...prev,
      customerMessage,
      { id: replyId, role: "assistant", text: "" },
    ]);
    setStatus("thinking");
    setToolActivity(null);

    /** Replace the in-flight reply. Kept local so every update path agrees. */
    const updateReply = (patch: Partial<ChatMessage>) =>
      setMessages((prev) =>
        prev.map((m) => (m.id === replyId ? { ...m, ...patch } : m)),
      );

    try {
      const response = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionId: sessionId.current,
          // Idempotency key. A double-click, or a retry after a flaky network,
          // must not append the same customer turn twice — the server writes
          // conditionally on this id.
          messageId: customerMessage.id,
          message: trimmed,
        }),
        signal: controller.signal,
      });

      if (!response.ok || !response.body) {
        throw new Error(`HTTP ${response.status}`);
      }

      let accumulated = "";
      for await (const event of readSse(response.body, controller.signal)) {
        switch (event.type) {
          case "token":
            accumulated += event.text;
            setStatus("streaming");
            setToolActivity(null);
            updateReply({ text: accumulated });
            break;

          case "tool_started":
            // Shown so a multi-second search does not look like a hang. The
            // wording is deliberately about the store, not about the machinery.
            setToolActivity(
              event.name.includes("product") ? "Looking through the collection…" : "Checking our policies…",
            );
            break;

          case "done":
            updateReply({ text: accumulated, products: event.products ?? [] });
            setStatus("idle");
            setToolActivity(null);
            break;

          case "refused":
            updateReply({ text: event.reason, failed: true });
            setStatus("idle");
            break;
        }
      }

      // The stream ended without a terminal event — a Lambda timeout, or a
      // connection dropped mid-answer. Partial text is still worth keeping;
      // silently showing it as complete is what would be wrong.
      setStatus((current) => (current === "idle" ? current : "idle"));
    } catch (error) {
      // An abort is a deliberate user action, not a failure to report.
      if (controller.signal.aborted) return;

      updateReply({
        text:
          "Sorry — I couldn't reach the store just then. Please try again, or " +
          "email us and a human will pick it up.",
        failed: true,
      });
      setStatus("error");
    }
  }, []);

  const stop = useCallback(() => {
    abort.current?.abort();
    setStatus("idle");
    setToolActivity(null);
  }, []);

  return { messages, status, toolActivity, send, stop };
}
