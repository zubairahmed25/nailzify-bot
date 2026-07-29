# Nailzify chat widget

React source, Preact runtime, one file, **12.2 KB gzipped** against a 25 KB CI budget.

```bash
npm run build --workspace=web/widget   # -> dist/nailzify-widget.js
npm run dev   --workspace=web/widget   # local, with a stubbed endpoint
```

## Why Preact

The bundle loads on **every storefront page**, including the ones where nobody opens
the chat. React + ReactDOM is ~45 KB gzipped before a line of our own code, so it
cannot fit the budget — and raising the budget means every visitor pays for a feature
a few use.

`preact/compat` implements the React API, aliased in `vite.config.ts`. The source is
ordinary React: hooks, JSX, function components. Switching to real React is deleting
two alias lines and raising the budget on purpose.

## Why Shadow DOM

This runs inside a theme the merchant bought, beside a reviews app and a currency
switcher, all shipping global CSS. Without a shadow root a theme rule like
`button { text-transform: uppercase }` deforms the widget on one store and not
another — unreproducible, reported as "your chat looks broken". And our styles leak
outward onto their product page, which is worse.

## Why there is no `dangerouslySetInnerHTML`

The text rendered here was written by a language model that just read retrieved
documents and Shopify product descriptions — content the store owner did not
necessarily author. `markdown.ts` returns a **tree**, not an HTML string, and React
renders it as elements. Unrecognised syntax arrives as a text node, which React
escapes. There is no code path from model output to markup.

Links are allowlisted to absolute `https:`. `javascript:`, `data:` and
protocol-relative `//host` are rejected and render as plain text — the last is a real
phishing vector, since the customer sees a link that appears to be on nailzify.com.

## Why prices are not parsed out of the answer

The `done` event carries a typed `products[]` array with the price **pre-formatted by
the server**. A price parsed back out of the model's prose would be a number written
by a language model. This is the two-plane rule at the presentation tier.

## Install

Build, upload `dist/nailzify-widget.js` to the theme's assets, add
`shopify/nailzify-concierge.liquid` as a snippet, then one line in `theme.liquid`
before `</body>`:

```liquid
{% render 'nailzify-concierge' %}
```

The widget POSTs to `/apps/nailzify-chat/message`, which Shopify's App Proxy forwards
to the Lambda with an HMAC signature. No API keys reach the browser.
