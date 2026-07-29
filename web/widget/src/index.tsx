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

  // ⚠️ THE SHADOW ROOT DOES NOT PROTECT THE HOST ELEMENT.
  //
  // A shadow root isolates what is INSIDE it. The host itself sits in the light
  // DOM and every theme rule on the page can still target it. `:host` rules lose
  // to outer-document rules by specification, so styling it from inside the
  // shadow sheet is not a defence either.
  //
  // The Concept theme ships this, and it is not unusual:
  //
  //     a:empty, ul:empty, div:empty, section:empty, ... { display: none }
  //
  // ⚠️ A SHADOW HOST MATCHES `:empty`. Shadow content is not light-DOM children,
  // so the host has no children as far as `:empty` is concerned. The theme hid
  // the entire widget — mounted, styled, in the DOM, and 0x0 — with no error
  // anywhere. It reproduced only on stores whose theme has that rule, which is
  // the worst kind of bug to be told about second-hand.
  //
  // Inline styles beat author stylesheets, and `important` beats an `!important`
  // theme rule. This is the one place in the widget where !important is correct:
  // it is not a specificity fight we chose, it is a floor under a guest element
  // on a page we do not control.
  for (const [property, value] of [
    ["display", "block"],
    ["visibility", "visible"],
    ["opacity", "1"],
    // A theme hiding stray elements often reaches for these too.
    ["position", "static"],
    ["width", "auto"],
    ["height", "auto"],
    ["max-width", "none"],
    ["max-height", "none"],
    ["margin", "0"],
    ["padding", "0"],
    ["transform", "none"],
    ["clip-path", "none"],
    ["content-visibility", "visible"],
  ] as const) {
    host.style.setProperty(property, value, "important");
  }

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

  trackVisualViewport(host);

  const root = document.createElement("div");
  shadow.appendChild(root);
  render(<App />, root);
}

/**
 * Publish the visual viewport height as `--nz-vh` on the host.
 *
 * The on-screen keyboard does not change the layout viewport on iOS Safari — it
 * overlays it and scrolls. So `100dvh` keeps the panel full-screen with its
 * lower half behind the keyboard: the composer disappears and a dead gap opens
 * above it. `visualViewport.height` is the only measurement that shrinks.
 *
 * Set on the HOST rather than inside the shadow root so a single custom property
 * reaches the panel through inheritance, which crosses the shadow boundary while
 * ordinary styles do not.
 */
function trackVisualViewport(host: HTMLElement): void {
  const vv = window.visualViewport;
  if (!vv) return;

  const apply = () => host.style.setProperty("--nz-vh", `${vv.height}px`);
  apply();

  // `scroll` matters as well as `resize`: iOS shifts the visual viewport when
  // the keyboard opens without always firing a resize.
  vv.addEventListener("resize", apply);
  vv.addEventListener("scroll", apply);
}

// `document.body` may not exist yet if the theme loads scripts in <head>.
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", mount, { once: true });
} else {
  mount();
}
