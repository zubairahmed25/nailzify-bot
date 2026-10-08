import type { CustomerOrderState, CustomerOrderSummary } from "../types.js";

interface Props {
  readonly state: CustomerOrderState;
  readonly onSignIn: () => void;
  readonly onRetry: () => void;
  readonly onSelect: (orderId: string) => void;
  readonly onBack: () => void;
  readonly onContactSupport: (orderId?: string) => void;
}

export function OrderLookup({
  state,
  onSignIn,
  onRetry,
  onSelect,
  onBack,
  onContactSupport,
}: Props) {
  if (state.status === "idle") return null;

  if (state.status === "loading") {
    return (
      <section class="nz-order nz-order--status" aria-live="polite" aria-busy="true">
        <span class="nz-order__eyebrow">YOUR ORDERS</span>
        <div class="nz-order__loading" aria-hidden="true"><span /><span /><span /></div>
        <p>{state.message}</p>
      </section>
    );
  }

  if (state.status === "sign_in") {
    return (
      <section class="nz-order nz-order--status" aria-live="polite">
        <span class="nz-order__eyebrow">YOUR ORDERS</span>
        <h2>See your latest order</h2>
        <p>{state.message ?? "Sign in securely with the email code from Shopify."}</p>
        <button type="button" class="nz-order__primary" onClick={onSignIn}>
          Sign in to view orders
        </button>
        <small>Your password and email code are handled by Shopify.</small>
      </section>
    );
  }

  if (state.status === "empty") {
    return (
      <section class="nz-order nz-order--status" aria-live="polite">
        <span class="nz-order__eyebrow">YOUR ORDERS</span>
        <h2>No recent orders found</h2>
        <p>There are no recent orders available for this signed in account.</p>
        <button type="button" class="nz-order__secondary" onClick={() => onContactSupport()}>
          Contact support
        </button>
      </section>
    );
  }

  if (state.status === "error") {
    return (
      <section class="nz-order nz-order--status" aria-live="assertive">
        <span class="nz-order__eyebrow">YOUR ORDERS</span>
        <h2>We couldn’t load your orders</h2>
        <p>{state.message}</p>
        <div class="nz-order__actions">
          <button type="button" class="nz-order__primary" onClick={onRetry}>Try again</button>
          <button type="button" class="nz-order__secondary" onClick={() => onContactSupport()}>
            Contact support
          </button>
        </div>
      </section>
    );
  }

  if (state.status === "list") {
    return (
      <section class="nz-order" aria-live="polite">
        <div class="nz-order__heading">
          <div>
            <span class="nz-order__eyebrow">YOUR ORDERS</span>
            <h2>Your recent orders</h2>
          </div>
          <span class="nz-order__secure">Secure</span>
        </div>
        <p>Select an order to view its latest status and tracking.</p>
        <div class="nz-order__list">
          {state.orders.map((order) => (
            <button
              key={order.id}
              type="button"
              class="nz-order-row"
              onClick={() => onSelect(order.id)}
              aria-label={`View ${order.name}, placed ${formatDate(order.createdAt)}`}
            >
              <span class="nz-order-row__main">
                <strong>{order.name}</strong>
                <span>{formatDate(order.createdAt)}</span>
              </span>
              <span class="nz-order-row__side">
                <strong>{formatMoney(order)}</strong>
                <span>{friendlyStatus(order.fulfillmentStatus)}</span>
              </span>
              <span class="nz-order-row__arrow" aria-hidden="true">→</span>
            </button>
          ))}
        </div>
        <div class="nz-order__actions">
          <a class="nz-order__secondary" href="/account/orders">View all orders</a>
        </div>
      </section>
    );
  }

  const { order } = state;
  return (
    <section class="nz-order nz-order--detail" aria-live="polite">
      <button type="button" class="nz-order__back" onClick={onBack}>← Recent orders</button>
      <div class="nz-order__heading">
        <div>
          <span class="nz-order__eyebrow">ORDER</span>
          <h2>{order.name}</h2>
        </div>
        <span class="nz-order__status-pill">{friendlyStatus(order.fulfillmentStatus)}</span>
      </div>

      <dl class="nz-order__facts">
        <div><dt>Placed</dt><dd>{formatDate(order.createdAt)}</dd></div>
        <div><dt>Total</dt><dd>{formatMoney(order)}</dd></div>
        <div><dt>Payment</dt><dd>{friendlyStatus(order.financialStatus ?? "Pending")}</dd></div>
        <div><dt>Fulfillment</dt><dd>{friendlyStatus(order.fulfillmentStatus)}</dd></div>
      </dl>

      <div class="nz-order__items">
        <h3>Items</h3>
        <ul>
          {order.lineItems.map((item, index) => (
            <li key={`${item.name}-${index}`}>
              <span>{item.name}</span><strong>× {item.quantity}</strong>
            </li>
          ))}
        </ul>
      </div>

      <div class="nz-order__tracking">
        <h3>Tracking</h3>
        {order.tracking.length ? order.tracking.map((tracking, index) => (
          <div class="nz-order__tracking-row" key={`${tracking.number ?? "tracking"}-${index}`}>
            <span>
              {tracking.company ?? "Carrier"}
              {tracking.number ? <small>{tracking.number}</small> : null}
            </span>
            {safeExternalUrl(tracking.url) ? (
              <a href={safeExternalUrl(tracking.url)!} target="_blank" rel="noopener noreferrer">Track package</a>
            ) : <em>Link unavailable</em>}
          </div>
        )) : <p>Tracking is not available yet.</p>}
      </div>

      <button type="button" class="nz-order__secondary" onClick={() => onContactSupport(order.id)}>
        Contact support about this order
      </button>
    </section>
  );
}

function formatMoney(order: CustomerOrderSummary): string {
  const amount = Number(order.total.amount);
  if (!Number.isFinite(amount)) return `${order.total.amount} ${order.total.currencyCode}`;
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: order.total.currencyCode,
    }).format(amount);
  } catch {
    return `${order.total.amount} ${order.total.currencyCode}`;
  }
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Date unavailable";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

function friendlyStatus(value: string): string {
  return value
    .replace(/_/g, " ")
    .toLowerCase()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function safeExternalUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}
