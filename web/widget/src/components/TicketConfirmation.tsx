import { useState } from "react";
import type { TicketConfirmationInput } from "../types.js";

interface Props {
  readonly escalationId: string;
  readonly orderId?: string | undefined;
  readonly onSubmit: (
    escalationId: string,
    input: TicketConfirmationInput,
  ) => Promise<{ ticketId: string }>;
}

export function TicketConfirmation({ escalationId, orderId, onSubmit }: Props) {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [addedDetail, setAddedDetail] = useState("");
  const [includeTranscript, setIncludeTranscript] = useState(false);
  const [includeOrderContext, setIncludeOrderContext] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [ticketId, setTicketId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (ticketId) {
    return (
      <div class="nz-ticket-confirmation nz-ticket-confirmation--success" role="status">
        <strong>We’ve got it.</strong>
        <span>Your request number is {ticketId}. Our team will follow up by email.</span>
      </div>
    );
  }

  return (
    <form
      class="nz-ticket-confirmation"
      onSubmit={async (event) => {
        event.preventDefault();
        setSubmitting(true);
        setError(null);
        try {
          const result = await onSubmit(escalationId, {
            email,
            name,
            addedDetail,
            includeTranscript,
            ...(orderId && includeOrderContext
              ? { includeOrderContext: true, orderId }
              : {}),
          });
          setTicketId(result.ticketId);
        } catch (cause) {
          setError((cause as Error).message);
        } finally {
          setSubmitting(false);
        }
      }}
    >
      <div class="nz-ticket-confirmation__intro">
        <strong>Want me to send this to our team?</strong>
        <span>Tell us where to reach you. Nothing is sent until you confirm.</span>
      </div>
      <label>
        Email
        <input
          type="email"
          value={email}
          onInput={(event) => setEmail(event.currentTarget.value)}
          required
          autocomplete="email"
          maxlength={254}
        />
      </label>
      <label>
        Name <span class="nz-ticket-confirmation__optional">optional</span>
        <input
          value={name}
          onInput={(event) => setName(event.currentTarget.value)}
          autocomplete="name"
          maxlength={120}
        />
      </label>
      <label>
        Anything else we should know? <span class="nz-ticket-confirmation__optional">optional</span>
        <textarea
          value={addedDetail}
          onInput={(event) => setAddedDetail(event.currentTarget.value)}
          maxlength={2000}
          rows={3}
        />
      </label>
      <label class="nz-ticket-confirmation__consent">
        <input
          type="checkbox"
          checked={includeTranscript}
          onChange={(event) => setIncludeTranscript(event.currentTarget.checked)}
        />
        Include this chat so the team has the full context
      </label>
      {orderId && (
        <label class="nz-ticket-confirmation__consent">
          <input
            type="checkbox"
            checked={includeOrderContext}
            onChange={(event) => setIncludeOrderContext(event.currentTarget.checked)}
          />
          Include the selected order number, date, items, total, payment, fulfillment, and tracking details
        </label>
      )}
      {error && <p class="nz-ticket-confirmation__error" role="alert">{error}</p>}
      <button type="submit" disabled={submitting}>
        {submitting ? "Sending…" : "Send to the team"}
      </button>
    </form>
  );
}
