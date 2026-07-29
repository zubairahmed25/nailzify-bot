/**
 * Widget entry point.
 *
 * ============================================================================
 * SHADOW DOM IS NOT OPTIONAL HERE
 * ============================================================================
 *
 * This script runs inside a Shopify theme the store owner bought, alongside a
 * reviews app, a currency switcher, and whatever else they installed. Every one
 * of those ships global CSS.
 *
 * Without a shadow root the failure is bidirectional and both directions are
 * bad. A theme rule like `button { text-transform: uppercase }` or
 * `* { box-sizing: content-box }` silently deforms this widget on one merchant's
 * store and not another's — unreproducible, and reported as "your chat looks
 * broken". And our own styles leak outward onto their product page, which is
 * worse: we would be visibly damaging the storefront we were installed to help.
 *
 * A shadow root ends both. Styles do not cross it in either direction.
 */

import { render } from "preact";
import { App } from "./App.js";
import styles from "./styles.css?inline";

const HOST_ID = "nailzify-concierge";

function mount(): void {
  // Idempotent. A theme that includes the script twice, or a section that
  // re-renders on the Shopify theme editor's live preview, must not stack a
  // second widget on top of the first.
  if (document.getElementById(HOST_ID)) return;

  const host = document.createElement("div");
  host.id = HOST_ID;
  document.body.appendChild(host);

  const shadow = host.attachShadow({ mode: "open" });

  // Constructable stylesheet when available — it is shared rather than parsed
  // per instance. The <style> fallback covers older Safari.
  if ("adoptedStyleSheets" in shadow && typeof CSSStyleSheet !== "undefined") {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(styles);
    shadow.adoptedStyleSheets = [sheet];
  } else {
    const style = document.createElement("style");
    style.textContent = styles;
    shadow.appendChild(style);
  }

  const root = document.createElement("div");
  shadow.appendChild(root);
  render(<App />, root);
}

// `document.body` may not exist yet if the theme loads scripts in <head>.
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", mount, { once: true });
} else {
  mount();
}
