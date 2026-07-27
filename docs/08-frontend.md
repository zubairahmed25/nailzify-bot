# Phase 8 — Frontend Architecture

The widget has an unusual constraint that shapes every decision: **it runs inside someone
else's page**. Your React app is a guest in a Shopify theme alongside jQuery, a reviews
app, a currency converter, and three analytics scripts. It must not break any of them, and
they must not break it.

---

## 8.1 How it gets onto the storefront

Three ways to put a widget in a Shopify theme:

| Method | Verdict |
|---|---|
| Edit `theme.liquid` directly | ❌ Overwritten on theme update; requires merchant to touch code; no per-page control |
| ScriptTag API | ⚠️ Deprecated direction; loads on every page with no merchant control |
| **Theme App Extension (app embed block)** | ✅ **Chosen** |

**Theme App Extension** is the modern, supported path. The merchant toggles your app on in
the theme editor; Shopify injects your script. Benefits that matter:

- Survives theme updates and theme switches
- Merchant controls placement and settings (accent colour, greeting, enabled pages)
  through the theme editor UI — no code, no support ticket
- Required for Shopify App Store listing if you ever publish it
- Settings are declared in a schema and delivered to your script

```liquid
{% comment %} extensions/nailzify-chat/blocks/chat-widget.liquid {% endcomment %}
<div id="nailzify-chat-root"
     data-shop="{{ shop.permanent_domain }}"
     data-customer-id="{{ customer.id | default: '' }}"
     data-accent="{{ block.settings.accent_color }}"
     data-greeting="{{ block.settings.greeting | escape }}"
     data-locale="{{ request.locale.iso_code }}"></div>

<script src="{{ 'nailzify-widget.js' | asset_url }}" defer></script>

{% schema %}
{
  "name": "Nailzify AI Concierge",
  "target": "body",
  "settings": [
    { "type": "color",    "id": "accent_color", "label": "Accent colour", "default": "#D4A5A5" },
    { "type": "text",     "id": "greeting",     "label": "Greeting",
      "default": "Hi! Ask me about sizing, shipping, or finding your perfect set." },
    { "type": "checkbox", "id": "show_on_mobile", "label": "Show on mobile", "default": true }
  ]
}
{% endschema %}
```

Note `customer.id` comes from **Liquid, server-rendered by Shopify** — not from JavaScript.
It's a real identity signal, and combined with App Proxy HMAC it's trustworthy.

---

## 8.2 Isolation — the non-negotiable part

The storefront theme has global CSS. It will style your `<button>`. Ask any developer who
has shipped an embedded widget: **style collision is the number one production bug.**

**Use Shadow DOM.**

```tsx
const host = document.getElementById("nailzify-chat-root")!;
const shadow = host.attachShadow({ mode: "open" });

const styles = document.createElement("style");
styles.textContent = WIDGET_CSS;          // inlined at build time
shadow.appendChild(styles);

const mount = document.createElement("div");
shadow.appendChild(mount);
createRoot(mount).render(<ChatWidget config={readConfig(host)} />);
```

Shadow DOM gives true style encapsulation in both directions: theme CSS cannot reach in,
your CSS cannot leak out. iframes also isolate, but cost you a separate document, awkward
resizing, clumsy mobile behaviour, and harder accessibility. Shadow DOM is the right tool
here.

**Other isolation rules:**

- Namespace everything global: `window.__nailzifyChat`, not `window.chat`.
- Never attach listeners to `document` without checking `event.composedPath()`.
- Use a high but not absurd `z-index` (e.g. `2147483000`) and document it.
- Don't polyfill globals — you'll break other apps on the page.

---

## 8.3 Bundle size

The widget loads on every storefront page. **Every kilobyte is measured against conversion
rate**, and merchants (rightly) blame slow stores on apps.

| Budget | Target |
|---|---|
| Initial JS (gzipped) | **< 25 KB** |
| CSS | < 6 KB |
| Time to interactive | < 150 ms after load |

How to hit it:

- **Preact + `preact/compat`** instead of React — ~4 KB vs ~45 KB, same API, aliased at
  build time so you write normal React.
- **Two-stage load.** Ship only a launcher button initially (~6 KB). Dynamically import the
  full chat UI on first click. Most visitors never open the chat and should pay almost
  nothing for it.
- No component library. No `moment`. No `lodash`. Use platform APIs.
- CSS-in-JS is a runtime cost — write plain CSS, inline it at build.
- Load with `defer`, never blocking.
- Measure with `rollup-plugin-visualizer` and **fail CI on budget regressions** (Phase 11).

```
Stage 1 (always):    launcher button + open handler        ~6 KB
Stage 2 (on click):  chat UI, SSE client, markdown render  ~19 KB
```

---

## 8.4 Component structure

```
web/widget/src/
├── index.tsx                    entry: read config, attach shadow root, mount
├── ChatWidget.tsx               shell, open/closed state
├── components/
│   ├── Launcher.tsx             floating button + unread badge
│   ├── MessagePane.tsx          scroll container, autoscroll, virtualization
│   ├── MessageBubble.tsx        markdown, citations, feedback buttons
│   ├── ProductCard.tsx          image, title, LIVE price, stock, CTA
│   ├── Composer.tsx             textarea, send, character counter
│   ├── TypingIndicator.tsx
│   └── QuickReplies.tsx         suggested starter prompts
├── hooks/
│   ├── useChatStream.ts         ← SSE client; the core of the frontend
│   ├── useSession.ts            sessionId in sessionStorage
│   └── useAutoScroll.ts         scroll unless the user scrolled up
├── lib/
│   ├── api.ts                   fetch through the App Proxy path
│   ├── markdown.ts              tiny renderer — sanitized, allowlisted tags
│   └── analytics.ts             emit to Shopify Web Pixels
└── styles/widget.css
```

---

## 8.5 Streaming client

The counterpart to Phase 5's streaming Lambda. Note it uses `fetch` + `ReadableStream`,
**not** `EventSource` — `EventSource` cannot issue a POST or set headers.

```ts
export function useChatStream(sessionId: string) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [status, setStatus] = useState<"idle" | "streaming" | "error">("idle");

  const send = useCallback(async (text: string) => {
    setStatus("streaming");
    setMessages(m => [...m, userMessage(text), assistantPlaceholder()]);

    const res = await fetch("/apps/nailzify-chat/message", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId, message: text, messageId: crypto.randomUUID() }),
    });

    if (!res.ok || !res.body) { setStatus("error"); return; }

    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;

      // SSE frames are separated by a blank line. Buffer until you have a
      // complete frame — a chunk boundary can land mid-event.
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";

      for (const frame of frames) {
        if (!frame.startsWith("data: ")) continue;
        const event = JSON.parse(frame.slice(6));

        if (event.type === "token") {
          setMessages(m => appendToLast(m, event.text));
        } else if (event.type === "done") {
          setMessages(m => finalizeLast(m, event.citations, event.products));
          setStatus("idle");
        } else if (event.type === "error") {
          setMessages(m => setLastError(m, event.message));
          setStatus("error");
        }
      }
    }
  }, [sessionId]);

  return { messages, status, send };
}
```

**The buffering detail is a real bug source.** Network chunks do not align with SSE event
boundaries. Split on `\n\n`, keep the trailing incomplete fragment in the buffer, and
process only complete frames. Parsing chunk-by-chunk works in local testing and fails
intermittently in production — the worst kind of bug.

**Also handle:**
- `AbortController` so navigating away cancels the request
- Reconnect with the same `sessionId` if the stream drops mid-answer
- A heartbeat comment (`: ping\n\n`) from the server every 15 s so intermediaries don't
  close an idle connection

---

## 8.6 Rendering model output safely

The model returns markdown. **Never `dangerouslySetInnerHTML` on model output.** Even
though the model is yours, retrieved document text flows into its context — that's an
indirect prompt-injection path to stored XSS on your merchant's storefront.

- Render with a minimal markdown parser and an **allowlist**: `p`, `strong`, `em`, `ul`,
  `ol`, `li`, `code`, `a`.
- Anchors: enforce `https:` scheme, force `rel="noopener noreferrer"` and `target="_blank"`.
- Strip everything else.

**Product cards are structured data, not markdown.** The `done` event carries a typed
`products[]` array; render it with React components. This means price and availability go
through a typed path with no string parsing — a second layer of the same anti-hallucination
principle, now at the presentation tier.

```tsx
<ProductCard
  title={p.title}
  price={formatMoney(p.price, p.currency)}   // from Shopify, this request
  available={p.available}                     // live
  imageUrl={p.imageUrl}
  href={p.url}
/>
```

---

## 8.7 State management

**Don't reach for Redux or Zustand.** The state is: a message list, a status enum, an
open/closed boolean, and a session ID. `useState` + `useReducer` covers it in ~40 lines
with zero bundle cost. Adding a state library here would be more bytes than the state.

```ts
type ChatState = {
  isOpen: boolean;
  messages: Message[];
  status: "idle" | "streaming" | "error";
  sessionId: string;
};
```

Persist `sessionId` and the last N messages to `sessionStorage` so a page navigation
(customer clicks a product link mid-conversation — which is exactly what you *want* them
to do) doesn't lose the thread. `sessionStorage` over `localStorage`: the conversation
should end when the visit does.

---

## 8.8 Accessibility

Not optional. It's a legal exposure for the merchant and it's the right thing to do.

- Launcher: `<button aria-label="Open chat" aria-expanded={isOpen}>`
- Message pane: `role="log" aria-live="polite" aria-relevant="additions"` — screen readers
  announce new messages without interrupting.
- **Streaming and screen readers conflict.** Announcing every token is unusable. Update the
  live region only on sentence boundaries, or announce once when the message completes.
- Focus trap while open; `Esc` closes; focus returns to the launcher.
- `Enter` sends, `Shift+Enter` newlines.
- Respect `prefers-reduced-motion` for the typing indicator.
- 4.5:1 contrast minimum — and validate the merchant's chosen accent colour against the
  background, since they can set anything in the theme editor.

---

## 8.9 Mobile

More than half of Shopify traffic is mobile.

- Full-screen sheet on mobile, floating panel ≥ 768 px.
- **Use `100dvh`, not `100vh`** — mobile browser chrome makes `vh` wrong, and the chat
  composer ends up under the URL bar. This is *the* classic mobile chat-widget bug.
- Handle the virtual keyboard with `visualViewport` so the composer stays visible.
- 44×44 px minimum touch targets.
- Don't hijack scroll — let the page scroll when the chat is closed.

---

## 8.10 Analytics

Emit through **Shopify Web Pixels** so events land in the merchant's existing analytics
rather than a separate silo:

| Event | Why |
|---|---|
| `chat_opened` | Engagement rate |
| `message_sent` | Depth of use |
| `product_clicked` | **Attribution — chat → PDP → purchase** |
| `escalated_to_human` | Deflection rate (the core ROI metric) |
| `feedback_given` | Quality signal + eval-set source |

`product_clicked` is the one that justifies the project's existence to a business
stakeholder. Instrument it on day one — retrofitting attribution is painful and you'll
want the number in month two.

---

Next: [Phase 9 — Deployment architecture](09-deployment.md)
