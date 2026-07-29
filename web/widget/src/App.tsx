import { useEffect, useRef, useState } from "react";
import { loadFont } from "./index.js";
import { Composer } from "./components/Composer.js";
import { Message } from "./components/Message.js";
import { loadPersistedState, savePersistedState, useChat } from "./useChat.js";

/** Support headphones. Stroked with currentColor so the button owns the colour. */
function HeadphonesIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"
         stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M4 15v-3a8 8 0 0 1 16 0v3" />
      <path d="M6 19a2 2 0 0 1-2-2v-2a2 2 0 0 1 2-2h1a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1z" />
      <path d="M18 19a2 2 0 0 0 2-2v-2a2 2 0 0 0-2-2h-1a1 1 0 0 0-1 1v4a1 1 0 0 0 1 1z" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
         stroke-linecap="round" aria-hidden="true">
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

const GREETING =
  "Hi! I can help you find a set, work out your size, or answer questions about " +
  "returns. What are you after?";

export function App() {
  const { messages, status, toolActivity, send, stop } = useChat();
  // Reopens itself after a navigation. Landing on a product page with the chat
  // closed makes it look like the conversation ended, when the customer only
  // followed a recommendation the bot gave them.
  const [open, setOpen] = useState(() => loadPersistedState().open);
  const scroller = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const launcher = useRef<HTMLButtonElement>(null);

  const busy = status === "thinking" || status === "streaming";

  useEffect(() => {
    savePersistedState({ open, messages });
  }, [open, messages]);

  // Follow the stream, but only when the customer is already at the bottom.
  // Yanking the view down while someone is reading an earlier answer is one of
  // the most irritating things a chat UI can do.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [messages, toolActivity]);

  // On open — including the reopen after a navigation — jump to the latest
  // message. Restoring a conversation scrolled to its beginning shows the
  // customer the greeting instead of the answer they just acted on.
  useEffect(() => {
    if (!open) return;
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [open]);

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
    if (!open) return;
    loadFont();
    panel.current?.querySelector("textarea")?.focus();
  }, [open]);

  // ---- scroll lock ---------------------------------------------------------
  //
  // ⚠️ `overflow: hidden` ON BODY IS NOT ENOUGH ON iOS. Safari ignores it for
  // touch scrolling, so the storefront kept scrolling behind a full-screen chat
  // panel — the customer drags to read an answer and the product page moves
  // instead. `position: fixed` on the body is what actually stops it.
  //
  // Fixing the body scrolls the page to the top, so the offset is captured and
  // restored on close. Skipping that lands the customer back at the top of the
  // storefront after every conversation, which reads as the widget breaking the
  // page.
  useEffect(() => {
    if (!open) return;
    // Only on the layout where the panel is full-screen. On desktop the page
    // behind stays usable on purpose.
    if (!matchMedia("(max-width: 480px)").matches) return;

    const { body } = document;
    const scrollY = window.scrollY;
    const previous = {
      position: body.style.position,
      top: body.style.top,
      width: body.style.width,
      overflow: body.style.overflow,
    };

    body.style.position = "fixed";
    body.style.top = `-${scrollY}px`;
    body.style.width = "100%";
    body.style.overflow = "hidden";

    return () => {
      body.style.position = previous.position;
      body.style.top = previous.top;
      body.style.width = previous.width;
      body.style.overflow = previous.overflow;
      window.scrollTo(0, scrollY);
    };
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
        {/* ⚠️ AN SVG, NOT AN EMOJI. The old 💬 rendered as a different glyph on
            every platform — Apple, Google and Microsoft draw unrelated speech
            bubbles, none of them in the brand colour, and the merchant had no
            control over any of it. An inline path is identical everywhere and
            inherits currentColor. */}
        {open ? <CloseIcon /> : <HeadphonesIcon />}
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
