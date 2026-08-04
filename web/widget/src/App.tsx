import { useEffect, useRef, useState } from "react";
import { loadFont } from "./index.js";
import { AgentAvatar } from "./components/AgentAvatar.js";
import { Composer } from "./components/Composer.js";
import { Message } from "./components/Message.js";
import { QuickActions } from "./components/QuickActions.js";
import { loadPersistedState, savePersistedState, useChat } from "./useChat.js";

function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
         stroke-linecap="round" aria-hidden="true">
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

/** The header's baseline tagline — "— replying now" is appended while busy. */
const STATUS_TAGLINE = "Styling · Fit · Care";

/** How near the bottom counts as "already following the conversation." */
const NEAR_BOTTOM_PX = 120;

export function App() {
  const { messages, status, toolActivity, send, stop } = useChat();
  // Reopens itself after a navigation. Landing on a product page with the chat
  // closed makes it look like the conversation ended, when the customer only
  // followed a recommendation the bot gave them.
  const [open, setOpen] = useState(() => loadPersistedState().open);
  // Shown when a reply keeps streaming while the customer has scrolled up to
  // read something earlier — holding their scroll position is correct, but
  // they still need a way back to what just arrived.
  const [showJump, setShowJump] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const launcher = useRef<HTMLButtonElement>(null);

  const busy = status === "thinking" || status === "streaming";
  // Dots show only while there is nothing else on screen proving progress —
  // once real answer text is streaming in, the growing bubble IS the
  // indicator. Matches exactly when the old text-based status line used to
  // render something rather than sitting empty.
  const showTyping = status === "thinking" || toolActivity !== null;

  useEffect(() => {
    savePersistedState({ open, messages });
  }, [open, messages]);

  // Follow the stream, but only when the customer is already at the bottom.
  // Yanking the view down while someone is reading an earlier answer is one of
  // the most irritating things a chat UI can do.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
    if (nearBottom) {
      el.scrollTop = el.scrollHeight;
      setShowJump(false);
    } else if (messages.length > 0) {
      setShowJump(true);
    }
  }, [messages, toolActivity]);

  // Tracks manual scrolling too, not just new content — a customer scrolling
  // up mid-stream should see the affordance appear immediately, not wait for
  // the next token.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const onScroll = () => {
      const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
      setShowJump(!nearBottom && messages.length > 0);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [messages.length]);

  const jumpToLatest = () => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
    setShowJump(false);
  };

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
    if (!matchMedia("(max-width: 640px)").matches) return;

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
        {/* ⚠️ AN SVG, NOT AN EMOJI. The original 💬 rendered as a different
            glyph on every platform — Apple, Google and Microsoft draw unrelated
            speech bubbles, none in the brand colour, and the merchant had no
            control over any of it. */}
        {open ? <CloseIcon /> : <AgentAvatar />}
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
          <div class="nz-header__text">
            <span class="nz-header__eyebrow">NAILZIFY</span>
            <span class="nz-header__title">The Concierge</span>
            <div class="nz-header__status">
              <span class="nz-header__dot" aria-hidden="true" />
              <span class="nz-header__caption">
                {STATUS_TAGLINE}
                {busy ? " — replying now" : ""}
              </span>
            </div>
          </div>
          <button class="nz-header__close" onClick={() => setOpen(false)} aria-label="Close chat">
            ✕
          </button>
        </header>

        <div class="nz-scroll" ref={scroller}>
          <div class="nz-msg nz-msg--assistant">
            <span class="nz-concierge-label">CONCIERGE</span>
            <div class="nz-bubble">
              <p class="nz-bubble__lede">Welcome to Nailzify. I&rsquo;m here to make the choosing easy.</p>
              <p>
                I can match a set to your shape and occasion, size you from our official fit
                guide, and settle anything on wear, care, or returns. Where would you like to
                start?
              </p>
            </div>
          </div>

          {/* Resting state only — before the first message. Does not
              reappear once the conversation has started. */}
          {messages.length === 0 && <QuickActions onSelect={send} disabled={busy} />}

          {messages.map((message) => (
            <Message key={message.id} message={message} />
          ))}

          {showTyping && (
            <div class="nz-typing" aria-hidden="true">
              <span class="nz-typing__dot" />
              <span class="nz-typing__dot" />
              <span class="nz-typing__dot" />
            </div>
          )}

          {/* Screen-reader progress announcement — the dots above are
              aria-hidden, so this is the only announcement a screen reader
              user gets. `polite` because interrupting mid-sentence is worse
              than waiting. */}
          <div class="nz-sr-only" aria-live="polite">
            {toolActivity ?? (status === "thinking" ? "Thinking…" : "")}
          </div>

          {showJump && (
            <button type="button" class="nz-jump" onClick={jumpToLatest}>
              ↓ New messages
            </button>
          )}
        </div>

        <div class="nz-composer-wrap">
          <Composer onSend={send} onStop={stop} busy={busy} />
          <p class="nz-footer">
            Answers are drawn from the Nailzify fit guide and store policies. Pricing and stock
            are live.
          </p>
        </div>
      </div>
    </>
  );
}
