/** Shapes shared between the transport layer and the components. */

export interface ProductRef {
  readonly id: string;
  readonly title: string;
  /** Pre-formatted by the server, e.g. "$13.99". Never assembled here. */
  readonly price: string;
  readonly url: string;
  readonly imageUrl: string | null;
  readonly available: boolean;
  /** Pre-formatted "Shape · Finish" by the server, e.g. "Almond · Gloss". Null when neither is known. */
  readonly meta: string | null;
}

export interface ChatMessage {
  readonly id: string;
  readonly role: "customer" | "assistant";
  readonly text: string;
  /** Set once the turn completes. A streaming message has none. */
  readonly products?: readonly ProductRef[];
  readonly failed?: boolean;
  readonly handoff?: { readonly id: string };
}

export interface TicketConfirmationInput {
  readonly email: string;
  readonly name: string;
  readonly addedDetail: string;
  readonly includeTranscript: boolean;
  readonly includeOrderContext?: boolean;
  readonly orderId?: string;
}

export interface CustomerOrderMoney {
  readonly amount: string;
  readonly currencyCode: string;
}

export interface CustomerOrderSummary {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
  readonly total: CustomerOrderMoney;
  readonly financialStatus: string | null;
  readonly fulfillmentStatus: string;
}

export interface CustomerOrderDetail extends CustomerOrderSummary {
  readonly lineItems: readonly { readonly name: string; readonly quantity: number }[];
  readonly tracking: readonly {
    readonly company: string | null;
    readonly number: string | null;
    readonly url: string | null;
  }[];
}

export type CustomerOrderState =
  | { readonly status: "idle" }
  | { readonly status: "sign_in"; readonly message?: string }
  | { readonly status: "loading"; readonly message: string }
  | { readonly status: "list"; readonly orders: readonly CustomerOrderSummary[] }
  | { readonly status: "empty" }
  | { readonly status: "detail"; readonly order: CustomerOrderDetail }
  | { readonly status: "error"; readonly message: string };
