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
}
