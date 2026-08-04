import { useEffect, useRef, useState } from "react";
import { loadFont } from "./index.js";
import { AgentAvatar } from "./components/AgentAvatar.js";
import { Composer } from "./components/Composer.js";
import { Message } from "./components/Message.js";
import { QuickActions, QuickActionsBar } from "./components/QuickActions.js";
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

  // Whether the customer is currently following the bottom of the thread.
  //
  // ⚠️ A REF UPDATED ONLY BY REAL SCROLL EVENTS — deliberately not recomputed
  // inside the auto-follow effect below, which is the bug this replaced.
  // Product cards land all at once on the "done" event and add ~250-300px to
  // `scrollHeight` in a single render, before `scrollTop` has had any chance
  // to move. Recomputing "am I near the bottom?" AFTER that jump, from
  // inside the very effect reacting to it, measures the gap against content
  // that did not exist a moment ago — a customer who was genuinely at the
  // bottom right up until the cards appeared reads as "scrolled away," and
  // the view sticks on the text above the cards instead of following them
  // down. A ref fed only by the scroll listener reflects where the customer
  // actually was BEFORE this update, which is the only question that matters.
  const followingBottom = useRef(true);

  // A plain ref mirror of messages.length, updated every render. The scroll
  // listener below reads this instead of closing over `messages.length`
  // directly, which is what lets the listener be registered ONCE.
  //
  // ⚠️ IT USED TO BE A useEffect DEPENDENCY, AND THAT WAS THE BUG a second
  // customer sent-a-message report actually traced back to. `send()` in
  // useChat.ts appends the customer bubble AND an empty assistant bubble in
  // one state update, so `messages.length` jumps the instant a reply starts.
  // With `[messages.length]` in the deps array, that same render re-ran this
  // effect's setup — which called `onScroll()` immediately to "correct state
  // on mount" — and that synchronous call read `scrollHeight` already grown
  // by the two new bubbles while `scrollTop` hadn't been advanced yet (the
  // effect below does that, but runs after this one). On a mostly-empty
  // panel that gap stayed under NEAR_BOTTOM_PX and nothing looked wrong; once
  // a full round of conversation (plus the quick-actions bar eating vertical
  // space) was already on screen, the same read crossed the threshold and
  // wrongly marked the customer as "scrolled away," so the next reply never
  // auto-scrolled into view. Same race the product-card fix addressed,
  // reached through a second path the first fix didn't touch.
  const messageCount = useRef(messages.length);
  messageCount.current = messages.length;

  const isNearBottom = (el: HTMLDivElement) =>
    el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;

  // Tracks manual scrolling — a customer scrolling up mid-stream should see
  // the "jump to latest" affordance immediately, not wait for the next token.
  // This is also what keeps `followingBottom` correct: it fires again after
  // OUR OWN programmatic scrollTop assignments below, since a scroll event
  // fires either way, so the ref stays truthful without this effect needing
  // to know who moved the scroll position.
  //
  // Registered once — see the messageCount comment above for why re-running
  // this on every new message was itself the bug.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const onScroll = () => {
      const nearBottom = isNearBottom(el);
      followingBottom.current = nearBottom;
      setShowJump(!nearBottom && messageCount.current > 0);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  // Follow the stream, but only when the customer was already at the bottom.
  // Yanking the view down while someone is reading an earlier answer is one of
  // the most irritating things a chat UI can do.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (followingBottom.current) {
      el.scrollTop = el.scrollHeight;
      setShowJump(false);
    } else if (messages.length > 0) {
      setShowJump(true);
    }
  }, [messages, toolActivity]);

  const jumpToLatest = () => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
    followingBottom.current = true;
    setShowJump(false);
  };

  // On open — including the reopen after a navigation — jump to the latest
  // message. Restoring a conversation scrolled to its beginning shows the
  // customer the greeting instead of the answer they just acted on.
  //
  // Also resets `followingBottom`, since the scroll listener no longer
  // corrects it on mount (see the messageCount comment above) — a reopen
  // always lands at the bottom, so the ref should agree.
  useEffect(() => {
    if (!open) return;
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
    followingBottom.current = true;
    setShowJump(false);
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

        {/* Takes over from the resting-state grid once the conversation has
            started, and stays for the rest of it — not part of the original
            handoff, added after real customers lost track of the options
            once they'd sent a first message. */}
        {messages.length > 0 && <QuickActionsBar onSelect={send} disabled={busy} />}

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
