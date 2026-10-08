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
import type {
  ChatMessage,
  CustomerOrderDetail,
  CustomerOrderState,
  CustomerOrderSummary,
  TicketConfirmationInput,
} from "./types.js";
import type { ServerQuickActionIntent } from "./quick-actions.js";
import {
  loadPersistedState,
  loadSessionId,
  newId,
  savePersistedState,
} from "./persistence.js";

export type { ChatMessage, ProductRef } from "./types.js";
export { loadPersistedState, savePersistedState } from "./persistence.js";

/** Shopify App Proxy path. Shopify forwards this to the Lambda with an HMAC. */
const ENDPOINT = "/apps/nailzify-chat/message";
const TICKET_ENDPOINT = "/apps/nailzify-chat/tickets";
const ORDER_ENDPOINT = "/apps/nailzify-chat/customer-orders";

export type Status = "idle" | "thinking" | "streaming" | "error";

export function useChat() {
  const [messages, setMessages] = useState<readonly ChatMessage[]>(
    () => loadPersistedState().messages,
  );
  const [status, setStatus] = useState<Status>("idle");
  const [toolActivity, setToolActivity] = useState<string | null>(null);
  const [customerOrders, setCustomerOrders] = useState<CustomerOrderState>({ status: "idle" });
  const [orderTimelineIndex, setOrderTimelineIndex] = useState<number | null>(null);
  const [handoffOrderIds, setHandoffOrderIds] = useState<Readonly<Record<string, string>>>({});

  const sessionId = useRef<string>("");
  const abort = useRef<AbortController | null>(null);
  const orderAbort = useRef<AbortController | null>(null);
  const messagesRef = useRef(messages);

  messagesRef.current = messages;

  if (!sessionId.current) sessionId.current = loadSessionId();

  // A generation still running after the widget unmounts bills Bedrock for
  // tokens nobody will read.
  useEffect(() => () => {
    abort.current?.abort();
    orderAbort.current?.abort();
  }, []);

  // Persisted on every change rather than on unload: `beforeunload` is
  // unreliable on mobile Safari, which is exactly where a customer taps a
  // product card and never fires it.
  useEffect(() => {
    savePersistedState({ open: loadPersistedState().open, messages });
  }, [messages]);

  const postOrder = useCallback(async <T,>(path: string, body: Record<string, unknown>): Promise<T> => {
    orderAbort.current?.abort();
    const controller = new AbortController();
    orderAbort.current = controller;
    const response = await fetch(`${ORDER_ENDPOINT}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: sessionId.current, ...body }),
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => ({})) as T & {
      error?: string;
      code?: string;
    };
    if (!response.ok) {
      const error = new Error(payload.error ?? "Orders are temporarily unavailable.");
      Object.assign(error, { code: payload.code, status: response.status });
      throw error;
    }
    return payload;
  }, []);

  const loadRecentOrders = useCallback(async (timelineIndex?: number) => {
    setOrderTimelineIndex((current) => timelineIndex ?? current ?? messagesRef.current.length);
    setCustomerOrders({ status: "loading", message: "Finding your recent orders…" });
    try {
      const payload = await postOrder<{ readonly orders: readonly CustomerOrderSummary[] }>(
        "/recent",
        {},
      );
      setCustomerOrders(
        payload.orders.length
          ? { status: "list", orders: payload.orders }
          : { status: "empty" },
      );
    } catch (cause) {
      if ((cause as Error).name === "AbortError") return;
      const error = cause as Error & { code?: string };
      setCustomerOrders(
        error.code === "authentication_required"
          ? { status: "sign_in", message: error.message }
          : { status: "error", message: error.message },
      );
    }
  }, [postOrder]);

  const startOrderAuthentication = useCallback(async () => {
    setCustomerOrders({ status: "loading", message: "Opening secure sign in…" });
    try {
      const currentUrl = new URL(window.location.href);
      currentUrl.searchParams.delete("order_auth");
      const payload = await postOrder<{ readonly authorizationUrl: string }>("/auth/start", {
        returnUrl: currentUrl.toString(),
      });
      window.location.assign(payload.authorizationUrl);
    } catch (cause) {
      if ((cause as Error).name === "AbortError") return;
      setCustomerOrders({
        status: "error",
        message: (cause as Error).message || "Secure sign in is temporarily unavailable.",
      });
    }
  }, [postOrder]);

  const selectOrder = useCallback(async (orderId: string) => {
    setCustomerOrders({ status: "loading", message: "Checking the latest order status…" });
    try {
      const payload = await postOrder<{ readonly order: CustomerOrderDetail }>("/detail", { orderId });
      setCustomerOrders({ status: "detail", order: payload.order });
    } catch (cause) {
      if ((cause as Error).name === "AbortError") return;
      const error = cause as Error & { code?: string };
      setCustomerOrders(
        error.code === "authentication_required"
          ? { status: "sign_in", message: error.message }
          : { status: "error", message: error.message },
      );
    }
  }, [postOrder]);

  useEffect(() => {
    const url = new URL(window.location.href);
    const result = url.searchParams.get("order_auth");
    if (!result) return;
    url.searchParams.delete("order_auth");
    window.history.replaceState(window.history.state, "", url.toString());
    if (result === "success") {
      void loadRecentOrders();
    } else {
      setOrderTimelineIndex((current) => current ?? messagesRef.current.length);
      setCustomerOrders({
        status: "sign_in",
        message: result === "cancelled"
          ? "Sign in was cancelled."
          : result === "expired"
            ? "That sign in expired. Please try again."
            : "We couldn’t complete sign in. Please try again.",
      });
    }
  }, [loadRecentOrders]);

  const send = useCallback(async (
    text: string,
    quickAction?: ServerQuickActionIntent,
    orderContextId?: string,
  ): Promise<"chat" | "order_lookup"> => {
    const trimmed = text.trim();
    if (!trimmed) return "chat";

    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;

    const customerMessage: ChatMessage = { id: newId(), role: "customer", text: trimmed };
    const replyId = newId();
    let outcome: "chat" | "order_lookup" = "chat";

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
          ...(quickAction ? { quickAction } : {}),
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
            // ⚠️ A TOOL CALL IS A PARAGRAPH BOUNDARY, and forgetting that produced
            // the first bug a real customer would have hit:
            //
            //   "Let me look up the sizing guide for you.According to the..."
            //
            // The model speaks, calls a tool, then speaks again. Those are two
            // separate utterances arriving as two token streams, and appending
            // them to one buffer runs the last word of the first into the first
            // word of the second — no space, no break, one wall of text.
            if (accumulated.length > 0 && !accumulated.endsWith("\n\n")) {
              accumulated += "\n\n";
              updateReply({ text: accumulated });
            }
            // Shown so a multi-second search does not look like a hang. The
            // wording is deliberately about the store, not about the machinery.
            setToolActivity(
              event.name.includes("product") ? "Looking through the collection…" : "Checking our policies…",
            );
            break;

          case "done":
            updateReply({
              text: accumulated,
              products: event.products ?? [],
              ...(event.handoff ? { handoff: { id: event.handoff.id } } : {}),
            });
            setStatus("idle");
            setToolActivity(null);
            break;

          case "refused":
            updateReply({ text: event.reason, failed: true });
            setStatus("idle");
            break;

          case "order_lookup":
            outcome = "order_lookup";
            const messagesWithoutPendingReply = messagesRef.current.filter(
              (message) => message.id !== replyId,
            );
            setMessages(messagesWithoutPendingReply);
            setStatus("idle");
            setToolActivity(null);
            await loadRecentOrders(messagesWithoutPendingReply.length);
            break;
        }

        if (event.type === "done" && event.handoff && orderContextId) {
          setHandoffOrderIds((current) => ({ ...current, [event.handoff!.id]: orderContextId }));
        }
      }

      // The stream ended without a terminal event — a Lambda timeout, or a
      // connection dropped mid-answer. Partial text is still worth keeping;
      // silently showing it as complete is what would be wrong.
      setStatus((current) => (current === "idle" ? current : "idle"));
      return outcome;
    } catch (error) {
      // An abort is a deliberate user action, not a failure to report.
      if (controller.signal.aborted) return "chat";

      updateReply({
        text:
          "Sorry — I couldn't reach the store just then. Please try again, or " +
          "email us and a human will pick it up.",
        failed: true,
      });
      setStatus("error");
      return "chat";
    }
  }, [loadRecentOrders]);

  const addAssistantPrompt = useCallback((text: string) => {
    setMessages((prev) => [...prev, { id: newId(), role: "assistant", text }]);
  }, []);

  const submitTicket = useCallback(async (
    escalationId: string,
    input: TicketConfirmationInput,
  ): Promise<{ ticketId: string }> => {
    const response = await fetch(TICKET_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: sessionId.current, escalationId, ...input }),
    });
    const payload = await response.json().catch(() => ({})) as { ticketId?: string; error?: string };
    if (!response.ok || !payload.ticketId) {
      throw new Error(payload.error ?? "Could not create the support request");
    }
    return { ticketId: payload.ticketId };
  }, []);

  const stop = useCallback(() => {
    abort.current?.abort();
    setStatus("idle");
    setToolActivity(null);
  }, []);

  const clearCustomerOrders = useCallback(() => {
    orderAbort.current?.abort();
    setCustomerOrders({ status: "idle" });
    setOrderTimelineIndex(null);
  }, []);

  const contactSupportForOrder = useCallback(async (orderId: string) => {
    setCustomerOrders({ status: "idle" });
    setOrderTimelineIndex(null);
    await send("I want to talk to a person about this order.", undefined, orderId);
  }, [send]);

  return {
    messages,
    status,
    toolActivity,
    customerOrders,
    orderTimelineIndex,
    send,
    addAssistantPrompt,
    submitTicket,
    stop,
    loadRecentOrders,
    startOrderAuthentication,
    selectOrder,
    clearCustomerOrders,
    contactSupportForOrder,
    orderIdForEscalation: (escalationId: string) => handoffOrderIds[escalationId],
  };
}
