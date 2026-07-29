import type { ProductRef } from "../types.js";

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
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`${product.title}, ${product.price}${product.available ? "" : ", sold out"}`}
    >
      {product.imageUrl ? (
        // `loading="lazy"` because a long conversation can accumulate a dozen of
        // these on a page the merchant already paid to make fast.
        <img class="nz-card__img" src={product.imageUrl} alt="" loading="lazy" decoding="async" />
      ) : (
        <div class="nz-card__img nz-card__img--empty" aria-hidden="true" />
      )}

      <div class="nz-card__body">
        <span class="nz-card__title">{product.title}</span>
        <span class="nz-card__price">
          {product.price}
          {!product.available && <span class="nz-card__sold"> · Sold out</span>}
        </span>
      </div>
    </a>
  );
}
