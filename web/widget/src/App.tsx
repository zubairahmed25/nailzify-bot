import { useEffect, useRef, useState } from "react";
import { Composer } from "./components/Composer.js";
import { Message } from "./components/Message.js";
import { useChat } from "./useChat.js";

const GREETING =
  "Hi! I can help you find a set, work out your size, or answer questions about " +
  "returns. What are you after?";

export function App() {
  const { messages, status, toolActivity, send, stop } = useChat();
  const [open, setOpen] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const launcher = useRef<HTMLButtonElement>(null);

  const busy = status === "thinking" || status === "streaming";

  // Follow the stream, but only when the customer is already at the bottom.
  // Yanking the view down while someone is reading an earlier answer is one of
  // the most irritating things a chat UI can do.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [messages, toolActivity]);

  // Escape closes, and focus returns to the launcher. Without the second half,
  // a keyboard user is dumped at the top of the merchant's page.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        launcher.current?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  useEffect(() => {
    if (open) panel.current?.querySelector("textarea")?.focus();
  }, [open]);

  return (
    <>
      <button
        ref={launcher}
        class={`nz-launcher${open ? " nz-launcher--open" : ""}`}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls="nz-panel"
        aria-label={open ? "Close chat" : "Chat with us about nails"}
      >
        {open ? "✕" : "💬"}
      </button>

      <div
        id="nz-panel"
        ref={panel}
        class={`nz-panel${open ? " nz-panel--open" : ""}`}
        role="dialog"
        aria-label="Nailzify chat"
        aria-hidden={!open}
        // `inert` removes the subtree from the tab order entirely. Hiding the
        // panel visually is not enough — without this the composer stays
        // focusable behind the merchant's page, and a keyboard user tabs into
        // an invisible text box. Cast because Preact's JSX types predate the
        // attribute; the DOM honours it.
        {...({ inert: open ? undefined : "" } as Record<string, unknown>)}
      >
        <header class="nz-header">
          <span class="nz-header__title">Nailzify</span>
          <button class="nz-header__close" onClick={() => setOpen(false)} aria-label="Close chat">
            ✕
          </button>
        </header>

        <div class="nz-scroll" ref={scroller}>
          <div class="nz-msg nz-msg--assistant">
            <div class="nz-bubble">
              <p>{GREETING}</p>
            </div>
          </div>

          {messages.map((message) => (
            <Message key={message.id} message={message} />
          ))}

          {/* aria-live so a screen reader announces progress and the final
              answer without the customer hunting for it. `polite` because
              interrupting mid-sentence is worse than waiting. */}
          <div class="nz-status" aria-live="polite">
            {toolActivity ?? (status === "thinking" ? "Thinking…" : "")}
          </div>
        </div>

        <Composer onSend={send} onStop={stop} busy={busy} />

        <p class="nz-footer">
          Answers come from our size guide and policies. Prices and stock are live.
        </p>
      </div>
    </>
  );
}
