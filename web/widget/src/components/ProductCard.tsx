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

/**
 * A product, rendered from typed fields only.
 *
 * Every value here came from Shopify during THIS request and travelled as
 * structured data. Nothing on this card was written by the model, which is what
 * makes a wrong price impossible rather than unlikely.
 *
 * `price` arrives pre-formatted from the server so the browser cannot format it
 * wrongly either — currency formatting lives in one place, beside the type that
 * enforces integer minor units.
 */
export function ProductCard({ product }: { product: ProductRef }) {
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

      <div class="nz-card__body">
        <span class="nz-card__title">{product.title}</span>
        <span class="nz-card__price">{product.price}</span>
      </div>
    </a>
  );
}
