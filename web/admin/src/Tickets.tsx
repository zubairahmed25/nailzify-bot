import { useCallback, useEffect, useMemo, useState } from "react";
import { addTicketComment, getTicket, listTickets, retryTicketNotification, updateTicket } from "./api.js";
import { Icon } from "./Icons.js";
import type { Ticket, TicketDetail, TicketPriority, TicketStatus } from "./types.js";

const ALL_STATUSES: readonly TicketStatus[] = ["new", "open", "pending", "hold", "solved", "closed"];
const PRIORITIES: readonly TicketPriority[] = ["low", "normal", "high", "urgent"];

interface Props {
  readonly ticketId: string | null;
  readonly onSelect: (id: string | null) => void;
}

export function Tickets({ ticketId, onSelect }: Props) {
  if (ticketId) return <TicketView ticketId={ticketId} onBack={() => onSelect(null)} />;
  return <TicketQueue onSelect={onSelect} />;
}

function TicketQueue({ onSelect }: { readonly onSelect: (id: string) => void }) {
  const [tickets, setTickets] = useState<readonly Ticket[]>([]);
  const [status, setStatus] = useState<TicketStatus | "active">("active");
  const [loaded, setLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const statuses = status === "active" ? ALL_STATUSES.slice(0, 4) : [status];
      setTickets(await listTickets(statuses));
      setError(null);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setLoaded(true);
      setRefreshing(false);
    }
  }, [status]);

  useEffect(() => { void refresh(); }, [refresh]);

  return (
    <main class="workspace ticket-workspace" id="main-content">
      <section class="page-hero page-hero--tickets" aria-labelledby="tickets-title">
        <div class="page-hero__copy">
          <span class="eyebrow"><Icon name="inbox" /> Customer care</span>
          <h1 id="tickets-title">Your team’s support workspace</h1>
          <p>Review escalations, reply to customers, and keep every ticket moving from one place.</p>
        </div>
        <div class="queue-summary"><span class="queue-summary__icon"><Icon name="mail" /></span><div><strong>{loaded ? tickets.length : "…"}</strong><span>{status === "active" ? "Active conversations" : `${label(status)} tickets`}</span></div></div>
      </section>

      <section class="queue-card" aria-labelledby="queue-title">
        <div class="queue-card__header">
          <div><span class="eyebrow">Team inbox</span><h2 id="queue-title">{status === "active" ? "Needs attention" : label(status)}</h2><p>{queueDescription(status)}</p></div>
          <button class="secondary-action" onClick={() => void refresh()} disabled={refreshing}><Icon name="refresh" class={refreshing ? "icon is-spinning" : "icon"} />{refreshing ? "Refreshing" : "Refresh"}</button>
        </div>

        <nav class="ticket-filters" aria-label="Filter tickets by status">
          <button class={status === "active" ? "is-active" : ""} aria-pressed={status === "active"} onClick={() => setStatus("active")}><span class="filter-dot filter-dot--active" />Active</button>
          {ALL_STATUSES.map((value) => <button key={value} class={status === value ? "is-active" : ""} aria-pressed={status === value} onClick={() => setStatus(value)}><span class={`filter-dot filter-dot--${value}`} />{label(value)}</button>)}
        </nav>

        {error && <div class="notice notice--error" role="alert">{error}</div>}
        {!loaded && <StatePanel loading title="Loading your support queue" body="Gathering the latest customer conversations." />}
        {loaded && tickets.length === 0 && !error && <StatePanel title="You are all caught up" body="No tickets match this view. New customer requests will appear here." />}
        {tickets.length > 0 && (
          <ul class="ticket-list" aria-live="polite">
            {tickets.map((ticket) => (
              <li key={ticket.id}>
                <button class={`ticket-row ticket-row--${ticket.priority}`} onClick={() => onSelect(ticket.id)}>
                  <span class="requester-avatar" aria-hidden="true">{initials(ticket.requesterName ?? ticket.requesterEmail)}</span>
                  <span class="ticket-row__main">
                    <span class="ticket-row__top"><span class="ticket-number">{ticket.id}</span><TicketStatusBadge status={ticket.status} /></span>
                    <strong>{ticket.subject}</strong>
                    <span>{ticket.requesterName ?? ticket.requesterEmail}</span>
                  </span>
                  <span class="ticket-row__meta">
                    <PriorityBadge priority={ticket.priority} />
                    <span class="updated-time"><Icon name="clock" /><time dateTime={new Date(ticket.updatedAt).toISOString()}>{relative(ticket.updatedAt)}</time></span>
                    <span class="row-arrow"><Icon name="chevron-right" /></span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}

function TicketView({ ticketId, onBack }: { readonly ticketId: string; readonly onBack: () => void }) {
  const [detail, setDetail] = useState<TicketDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [body, setBody] = useState("");
  const [visibility, setVisibility] = useState<"public" | "private">("public");
  const [nextStatus, setNextStatus] = useState<TicketStatus>("pending");
  const [saving, setSaving] = useState(false);

  const refresh = useCallback(async () => {
    try { setDetail(await getTicket(ticketId)); setError(null); }
    catch (cause) { setError((cause as Error).message); }
  }, [ticketId]);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    if (!detail) return;
    setNextStatus(detail.ticket.status === "solved" ? "open" : allowedNextStatuses(detail.ticket.status).includes("pending") ? "pending" : detail.ticket.status);
  }, [detail?.ticket.id, detail?.ticket.status]);

  const timeline = useMemo(() => {
    if (!detail) return [];
    return [
      ...detail.comments.map((item) => ({ kind: "comment" as const, at: item.createdAt, item })),
      ...detail.events.map((item) => ({ kind: "event" as const, at: item.createdAt, item })),
      ...detail.notificationJobs.map((item) => ({ kind: "notification" as const, at: item.createdAt, item })),
    ].sort((a, b) => a.at - b.at);
  }, [detail]);

  const mutate = async (update: Parameters<typeof updateTicket>[2]) => {
    if (!detail) return;
    setSaving(true);
    try { await updateTicket(detail.ticket.id, detail.ticket.version, update); await refresh(); }
    catch (cause) { setError((cause as Error).message); }
    finally { setSaving(false); }
  };

  if (!detail) return <main class="workspace ticket-workspace" id="main-content"><button class="back-action" onClick={onBack}><Icon name="arrow-left" />Back to tickets</button>{error ? <div class="notice notice--error" role="alert">{error}</div> : <StatePanel loading title="Opening ticket" body="Loading the full customer conversation." />}</main>;
  const { ticket } = detail;

  return (
    <main class="workspace ticket-workspace" id="main-content">
      <button class="back-action" onClick={onBack}><Icon name="arrow-left" />Back to tickets</button>
      <header class="ticket-hero">
        <div class="ticket-hero__identity"><span class="requester-avatar requester-avatar--large" aria-hidden="true">{initials(ticket.requesterName ?? ticket.requesterEmail)}</span><div><span class="ticket-number">{ticket.id}</span><h1>{ticket.subject}</h1><p>{ticket.requesterName ?? "Customer"} <span aria-hidden="true">•</span> Updated {relative(ticket.updatedAt)}</p></div></div>
        <div class="ticket-hero__badges"><PriorityBadge priority={ticket.priority} /><TicketStatusBadge status={ticket.status} /></div>
      </header>

      {error && <div class="notice notice--error" role="alert">{error}</div>}
      <div class="ticket-layout">
        <div class="ticket-conversation">
          <article class="ticket-summary">
            <div class="section-heading"><span class="section-icon section-icon--pink"><Icon name="sparkles" /></span><div><span class="eyebrow">AI handoff</span><h2>What the customer needs</h2></div></div>
            <p class="summary-copy">{ticket.summary}</p>
            <div class="context-grid"><div><span>Reason for handoff</span><strong>{ticket.reason}</strong></div>{ticket.addedDetail && <div><span>Customer added</span><strong>{ticket.addedDetail}</strong></div>}</div>
          </article>

          {ticket.transcript && (
            <details class="transcript">
              <summary><span><Icon name="mail" />Chat transcript</span><span>{ticket.transcript.length} messages</span></summary>
              <div class="transcript__body">{ticket.transcript.map((message, index) => <article key={`${message.createdAt}-${index}`} class={`transcript__message transcript__message--${message.role}`}><strong>{message.role === "user" ? "Customer" : "Nail Bestie"}</strong><p>{message.body}</p></article>)}</div>
            </details>
          )}

          <section class="timeline" aria-labelledby="timeline-title">
            <div class="timeline__heading"><div><span class="eyebrow">Full history</span><h2 id="timeline-title">Conversation and activity</h2></div><span>{timeline.length} updates</span></div>
            {timeline.length === 0 && <StatePanel title="No conversation yet" body="Replies and ticket activity will appear here." />}
            {timeline.map((entry) => {
              if (entry.kind === "comment") return <article key={`comment-${entry.item.id}`} class={`timeline-card ${entry.item.visibility === "private" ? "timeline-card--private" : ""}`}>
                <span class={`message-avatar message-avatar--${entry.item.authorType}`} aria-hidden="true">{entry.item.authorType === "merchant" ? <Icon name="sparkles" /> : initials(ticket.requesterName ?? ticket.requesterEmail)}</span>
                <div class="timeline-card__content"><div class="timeline-card__meta"><strong>{entry.item.authorType === "merchant" ? "Team" : "Customer"}</strong><span>{entry.item.visibility === "private" ? "Private note" : label(entry.item.channel)}</span><time dateTime={new Date(entry.at).toISOString()}>{format(entry.at)}</time></div><p>{entry.item.body}</p>{entry.item.deliveryStatus && <span class={`delivery delivery--${entry.item.deliveryStatus}`}>Email {entry.item.deliveryStatus}{entry.item.deliveryFailureReason ? `: ${entry.item.deliveryFailureReason}` : ""}</span>}</div>
              </article>;
              if (entry.kind === "notification") return <article key={`notification-${entry.item.id}`} class="timeline-event timeline-event--notification"><span class="activity-icon"><Icon name="mail" /></span><div><span>Email to {entry.item.recipient}</span><small>{label(entry.item.template)}</small>{entry.item.failureReason && <small class="failure-reason">{entry.item.failureReason}</small>}</div><span class={`delivery delivery--${entry.item.deliveryStatus ?? entry.item.status}`}>{label(entry.item.deliveryStatus ?? entry.item.status)}</span>{entry.item.status === "failed" && <button class="retry-action" disabled={saving} onClick={async () => { setSaving(true); try { await retryTicketNotification(ticket.id, entry.item.id); await refresh(); } catch (cause) { setError((cause as Error).message); } finally { setSaving(false); } }}>Retry</button>}<time dateTime={new Date(entry.at).toISOString()}>{format(entry.at)}</time></article>;
              return <article key={`event-${entry.item.id}`} class="timeline-event"><span class="activity-icon"><Icon name="clock" /></span><span>{label(entry.item.type)}</span><time dateTime={new Date(entry.at).toISOString()}>{format(entry.at)}</time></article>;
            })}
          </section>

          {ticket.status !== "closed" && <form class={`reply-box reply-box--${visibility}`} onSubmit={async (event) => {
            event.preventDefault(); if (!body.trim()) return; setSaving(true);
            try { await addTicketComment(ticket.id, { expectedVersion: ticket.version, body, visibility, nextStatus }); setBody(""); await refresh(); }
            catch (cause) { setError((cause as Error).message); } finally { setSaving(false); }
          }}>
            <div class="reply-box__tabs" role="group" aria-label="Reply type"><button type="button" class={visibility === "public" ? "is-active" : ""} aria-pressed={visibility === "public"} onClick={() => setVisibility("public")}><Icon name="mail" />Public email</button><button type="button" class={visibility === "private" ? "is-active" : ""} aria-pressed={visibility === "private"} onClick={() => setVisibility("private")}><Icon name="user" />Private note</button></div>
            <label class="sr-only" for="reply-body">{visibility === "public" ? "Email reply" : "Private note"}</label>
            <textarea id="reply-body" value={body} onInput={(event) => setBody(event.currentTarget.value)} placeholder={visibility === "public" ? `Write a helpful reply to ${ticket.requesterEmail}` : "Add context only your team can see"} rows={7} maxLength={10000} />
            <div class="reply-box__actions"><label for="reply-status"><span>Set status after sending</span><select id="reply-status" value={nextStatus} onChange={(event) => setNextStatus(event.currentTarget.value as TicketStatus)}>{[ticket.status, ...allowedNextStatuses(ticket.status)].filter((value, index, values) => value !== "closed" && values.indexOf(value) === index).map((value) => <option key={value} value={value}>{label(value)}</option>)}</select></label><button class="primary-action" type="submit" disabled={saving || !body.trim()}><Icon name={visibility === "public" ? "mail" : "check"} />{saving ? "Saving" : visibility === "public" ? "Send email" : "Add private note"}</button></div>
          </form>}
        </div>

        <aside class="ticket-sidebar" aria-label="Ticket details">
          <section class="sidebar-section"><div class="sidebar-section__heading"><span class="section-icon section-icon--neutral"><Icon name="user" /></span><div><span class="eyebrow">Requester</span><h2>Customer</h2></div></div><strong>{ticket.requesterName ?? "Customer"}</strong><a href={`mailto:${ticket.requesterEmail}`}>{ticket.requesterEmail}</a></section>
          <section class="sidebar-section"><div class="sidebar-section__heading"><span class="section-icon section-icon--neutral"><Icon name="inbox" /></span><div><span class="eyebrow">Workflow</span><h2>Ticket controls</h2></div></div><label for="ticket-status">Status<select id="ticket-status" value={ticket.status} disabled={saving || ticket.status === "closed"} onChange={(event) => void mutate({ status: event.currentTarget.value as TicketStatus })}>{[ticket.status, ...allowedNextStatuses(ticket.status)].filter((value, index, values) => values.indexOf(value) === index).map((value) => <option key={value} value={value}>{label(value)}</option>)}</select></label><label for="ticket-priority">Priority<select id="ticket-priority" value={ticket.priority} disabled={saving || ticket.status === "closed"} onChange={(event) => void mutate({ priority: event.currentTarget.value as TicketPriority })}>{PRIORITIES.map((value) => <option key={value} value={value}>{label(value)}</option>)}</select></label><label for="ticket-assignee">Assignee<input id="ticket-assignee" defaultValue={ticket.assigneeUserId ?? ""} disabled={saving || ticket.status === "closed"} placeholder="Shopify user ID" onBlur={(event) => { const value = event.currentTarget.value || null; if (value !== ticket.assigneeUserId) void mutate({ assigneeUserId: value }); }} /></label></section>
          <section class="sidebar-section sidebar-section--metadata"><span class="eyebrow">Timing</span><dl><div><dt>Created</dt><dd>{format(ticket.createdAt)}</dd></div><div><dt>First response</dt><dd>{ticket.firstRespondedAt ? format(ticket.firstRespondedAt) : "Waiting for team"}</dd></div></dl></section>
        </aside>
      </div>
    </main>
  );
}

function TicketStatusBadge({ status }: { readonly status: TicketStatus }) {
  return <span class={`ticket-status ticket-status--${status}`}><span aria-hidden="true" />{label(status)}</span>;
}

function PriorityBadge({ priority }: { readonly priority: TicketPriority }) {
  return <span class={`priority-badge priority-badge--${priority}`}>{label(priority)} priority</span>;
}

function StatePanel({ loading = false, title, body }: { readonly loading?: boolean; readonly title: string; readonly body: string }) {
  return <div class="state-panel" role={loading ? "status" : undefined}><span class={`state-panel__icon ${loading ? "is-loading" : ""}`}>{loading ? <span class="spinner" /> : <Icon name="check" />}</span><h3>{title}</h3><p>{body}</p></div>;
}

const label = (value: string) => value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
const initials = (value: string) => value.split(/\s+|@/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("") || "C";
const format = (value: number) => new Date(value).toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
const relative = (value: number) => {
  const elapsed = Date.now() - value;
  const minutes = Math.max(1, Math.floor(elapsed / 60000));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return days < 7 ? `${days}d ago` : new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric" });
};
const queueDescription = (status: TicketStatus | "active") => ({ active: "Open conversations sorted so the oldest work stays visible.", new: "New requests waiting for a first response.", open: "Conversations your team is actively handling.", pending: "Waiting for the customer to respond.", hold: "Paused while another person or team helps.", solved: "Requests your team has marked as resolved.", closed: "Final records kept for support history." })[status];
const allowedNextStatuses = (status: TicketStatus): readonly TicketStatus[] => ({ new: ["open", "pending", "hold", "solved"], open: ["pending", "hold", "solved"], pending: ["open", "hold", "solved"], hold: ["open", "pending", "solved"], solved: ["open", "closed"], closed: [] })[status] as readonly TicketStatus[];
