import type { ProductRef } from "../types.js";
import { setPersistedOpen } from "../persistence.js";

/**
 * Close the panel just before the browser navigates to the product page.
 *
 * Without this, the customer taps a recommendation, the new page loads, and
 * the widget re-mounts with the panel still marked "open" from before — so it
 * pops back up and covers the very product page they just asked to see.
 *
 * ⚠️ SKIPPED FOR A MODIFIED CLICK. Cmd/Ctrl-click, Shift-click and middle-click
 * all open the link in a NEW tab or window — this tab never navigates. Closing
 * the panel here would be pointless motion for a customer who is still looking
 * at the conversation in front of them.
 */
function handleProductClick(e: MouseEvent): void {
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
  setPersistedOpen(false);
}

function CartIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M5 8h14l-1.2 11H6.2L5 8Z" />
      <path d="M9 8V6a3 3 0 0 1 6 0v2" />
    </svg>
  );
}

/**
 * A product, rendered from typed fields only.
 *
 * Every value here came from Shopify during THIS request and travelled as
 * structured data. Nothing on this card was written by the model, which is what
 * makes a wrong price impossible rather than unlikely.
 *
 * `price` and `meta` arrive pre-formatted from the server so the browser cannot
 * format either wrongly — currency and attribute formatting live in one place,
 * beside the types that enforce them (handle-message.ts).
 */
export function ProductCard({ product }: { product: ProductRef }) {
  const metaLine = [product.meta, product.price].filter(Boolean).join(" · ");

  return (
    <a
      class="nz-card"
      href={product.url}
      // ⚠️ SAME TAB, deliberately. A new tab is the right default for a link
      // that leaves the site; this one goes to a product page on the SAME store.
      // Opening a second tab there orphans the conversation in the first one and
      // leaves the customer to find their way back.
      rel="noopener"
      onClick={handleProductClick}
      aria-label={`${product.title}, ${product.price}${product.available ? "" : ", sold out"}`}
    >
      <div class="nz-card__media">
        {product.imageUrl ? (
          // `loading="lazy"` because a long conversation can accumulate a dozen
          // of these on a page the merchant already paid to make fast.
          <img class="nz-card__img" src={product.imageUrl} alt="" loading="lazy" decoding="async" />
        ) : (
          <div class="nz-card__img nz-card__img--empty" aria-hidden="true" />
        )}
        {/* On the image, not in the text row — a customer scanning tiles decides
            whether to tap before reading anything below. */}
        {!product.available && <span class="nz-card__sold">Sold out</span>}
      </div>

      <div class="nz-card__footer">
        <div class="nz-card__info">
          <span class="nz-card__name">{product.title}</span>
          <span class="nz-card__meta">{metaLine}</span>
        </div>
        {/*
         * ⚠️ A SPAN, NOT A BUTTON — deliberately. Styled to the redesign
         * exactly (design_handoff_ai_concierge), including the hover swap to
         * a filled accent circle, but it does not add anything to a cart:
         * nothing in this codebase talks to Shopify's Cart API yet, and this
         * whole card is already one `<a>` to the product page. A `<button>`
         * nested inside that `<a>` would be invalid HTML AND would announce
         * a real "add to cart" affordance to screen readers that this build
         * cannot back up — worse than not having it. `aria-hidden` keeps it
         * purely decorative until the real cart integration replaces it.
         */}
        <span class="nz-card__cart" aria-hidden="true">
          <CartIcon />
        </span>
      </div>
    </a>
  );
}
