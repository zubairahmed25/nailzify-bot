import { parseMarkdown, type Inline } from "../markdown.js";
import type { ChatMessage } from "../types.js";
import { ProductCard } from "./ProductCard.js";

/**
 * ⚠️ NO `dangerouslySetInnerHTML`, ANYWHERE IN THIS WIDGET.
 *
 * The text below was written by a language model that has just read retrieved
 * documents and Shopify product descriptions — content the store owner did not
 * necessarily author. Rendering it as HTML on a merchant's live storefront, next
 * to their checkout, is an injection path with a real payoff for an attacker.
 *
 * The markdown parser returns a tree and React renders it as elements. Anything
 * unrecognised arrives here as a text node, which React escapes. There is no
 * code path from model output to markup.
 */
function Span({ span }: { span: Inline }) {
  switch (span.kind) {
    case "strong":
      return <strong>{span.value}</strong>;
    case "em":
      return <em>{span.value}</em>;
    case "code":
      return <code>{span.value}</code>;
    case "link":
      // href is already validated as absolute https. `noopener` prevents the
      // opened page from reaching back via window.opener.
      return (
        <a href={span.href} target="_blank" rel="noopener noreferrer nofollow">
          {span.value}
        </a>
      );
    default:
      return <>{span.value}</>;
  }
}

export function Message({ message }: { message: ChatMessage }) {
  const isCustomer = message.role === "customer";
  const blocks = isCustomer ? null : parseMarkdown(message.text);

  return (
    <div class={`nz-msg nz-msg--${message.role}${message.failed ? " nz-msg--failed" : ""}`}>
      <div class="nz-bubble">
        {/* A customer's own words are never parsed as markdown — typing
            *asterisks* should show asterisks, and there is no reason to run a
            parser over untrusted input we already have verbatim. */}
        {isCustomer ? (
          <p>{message.text}</p>
        ) : (
          blocks!.map((block, i) =>
            block.kind === "list" ? (
              <ul key={i}>
                {block.items.map((item, j) => (
                  <li key={j}>
                    {item.map((span, k) => (
                      <Span key={k} span={span} />
                    ))}
                  </li>
                ))}
              </ul>
            ) : (
              <p key={i}>
                {block.spans.map((span, k) => (
                  <Span key={k} span={span} />
                ))}
              </p>
            ),
          )
        )}
      </div>

      {/* Structured data, not markdown. Price and availability travel a typed
          path from Shopify to this element with no string parsing in between. */}
      {message.products && message.products.length > 0 && (
        <div class="nz-products">
          {message.products.map((product) => (
            <ProductCard key={product.id} product={product} />
          ))}
        </div>
      )}
    </div>
  );
}
