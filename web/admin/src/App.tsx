import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, createUpload, deleteUpload, listUploads, putFile } from "./api.js";
import { Icon } from "./Icons.js";
import type { UploadedDocument } from "./types.js";
import { Tickets } from "./Tickets.js";

const POLL_MS = 4000;

function KnowledgeBase() {
  const [documents, setDocuments] = useState<readonly UploadedDocument[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [purpose, setPurpose] = useState("");
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    try {
      const docs = await listUploads();
      setDocuments(docs);
      setError(null);
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const hasPending = documents.some((doc) => doc.status === "processing");
  useEffect(() => {
    if (!hasPending) return;
    const id = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(id);
  }, [hasPending, refresh]);

  const handleUpload = useCallback(
    async (event: Event) => {
      event.preventDefault();
      const file = fileInput.current?.files?.[0];
      const trimmedPurpose = purpose.trim();
      if (!file || !trimmedPurpose) return;

      setUploading(true);
      setError(null);
      try {
        const { uploadUrl } = await createUpload(trimmedPurpose);
        await putFile(uploadUrl, file);
        if (fileInput.current) fileInput.current.value = "";
        setPurpose("");
        setSelectedFile(null);
        await refresh();
      } catch (cause) {
        setError(describeError(cause));
      } finally {
        setUploading(false);
      }
    },
    [purpose, refresh],
  );

  const handleDelete = useCallback(
    async (documentId: string) => {
      if (!window.confirm(`Remove "${documentId}"? This deletes it from the bot's knowledge.`)) {
        return;
      }
      try {
        await deleteUpload(documentId);
        await refresh();
      } catch (cause) {
        setError(describeError(cause));
      }
    },
    [refresh],
  );

  const readyCount = documents.filter((document) => document.status === "ready").length;

  return (
    <main class="workspace" id="main-content">
      <section class="page-hero page-hero--knowledge" aria-labelledby="knowledge-title">
        <div class="page-hero__copy">
          <span class="eyebrow"><Icon name="sparkles" /> AI knowledge</span>
          <h1 id="knowledge-title">Train your Nail Bestie</h1>
          <p>
            Add the policies and guides your assistant needs. Fresh uploads automatically become
            part of every grounded answer.
          </p>
        </div>
        <div class="hero-stats" aria-label="Knowledge Base summary">
          <div><strong>{documents.length}</strong><span>Documents</span></div>
          <div><strong>{readyCount}</strong><span>Ready to answer</span></div>
        </div>
      </section>

      <section class="upload-card" aria-labelledby="upload-title">
        <div class="section-heading">
          <span class="section-icon section-icon--pink"><Icon name="upload" /></span>
          <div><h2 id="upload-title">Add to the knowledge base</h2><p>Upload one PDF with a clear purpose so the assistant knows when to use it.</p></div>
        </div>
        <form class="upload-form" onSubmit={handleUpload}>
          <label class="field purpose-field" for="document-purpose">
            <span>Purpose</span>
            <input
              id="document-purpose"
              type="text"
              placeholder="For example: Returns and exchanges"
              value={purpose}
              onInput={(event) => setPurpose(event.currentTarget.value)}
              disabled={uploading}
              required
            />
            <small>This becomes the document title and tells the bot when it is relevant.</small>
          </label>
          <div class="field file-field">
            <span>PDF document</span>
            <label class={`file-picker ${selectedFile ? "has-file" : ""}`} for="document-file">
              <span class="file-picker__icon"><Icon name={selectedFile ? "check" : "document"} /></span>
              <span class="file-picker__copy">
                <strong>{selectedFile ?? "Choose a PDF"}</strong>
                <small>{selectedFile ? "Ready to upload" : "PDF files only"}</small>
              </span>
              <span class="file-picker__action">Browse</span>
            </label>
            <input
              ref={fileInput}
              id="document-file"
              class="sr-only"
              type="file"
              accept="application/pdf"
              disabled={uploading}
              required
              onChange={(event) => setSelectedFile(event.currentTarget.files?.[0]?.name ?? null)}
            />
          </div>
          <button class="primary-action" type="submit" disabled={uploading || purpose.trim().length === 0 || !selectedFile}>
            <Icon name="upload" /> {uploading ? "Uploading PDF" : "Upload and train"}
          </button>
        </form>
      </section>

      {error && <div class="notice notice--error" role="alert">{error}</div>}

      <section class="library-card" aria-labelledby="library-title" aria-live="polite">
        <div class="library-card__header">
          <div><span class="eyebrow">Your library</span><h2 id="library-title">Knowledge documents</h2></div>
          <span class="library-count">{documents.length} total</span>
        </div>

        {!loaded && <LoadingState label="Loading your documents" />}
        {loaded && documents.length === 0 && !error && (
          <EmptyState icon="book" title="Your knowledge base is ready for its first guide" body="Upload a policy, product guide, or FAQ above and it will appear here." />
        )}
        {documents.length > 0 && (
          <div class="table-wrap">
            <table class="documents">
              <caption class="sr-only">Uploaded knowledge base documents</caption>
              <thead><tr><th scope="col">Document</th><th scope="col">Status</th><th scope="col">Type</th><th scope="col">Updated</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead>
              <tbody>
                {documents.map((doc) => (
                  <tr key={doc.documentId}>
                    <th scope="row" data-label="Document">
                      <div class="document-name"><span class="document-icon"><Icon name="document" /></span><div><strong>{doc.title ?? doc.documentId}</strong><span>PDF knowledge source</span>{doc.status === "failed" && doc.errorMessage && <span class="doc-error">{doc.errorMessage}</span>}</div></div>
                    </th>
                    <td data-label="Status"><StatusPill status={doc.status} /></td>
                    <td data-label="Type"><span class="type-label">{doc.docType ?? "Document"}</span></td>
                    <td data-label="Updated"><time dateTime={doc.updatedAt}>{formatTimestamp(doc.updatedAt)}</time></td>
                    <td class="document-actions">
                      <button type="button" class="icon-action icon-action--danger" aria-label={`Delete ${doc.title ?? doc.documentId}`} onClick={() => void handleDelete(doc.documentId)}><Icon name="trash" /></button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}

export function App() {
  const initial = window.location.hash.match(/^#tickets\/(.+)$/);
  const [section, setSection] = useState<"knowledge" | "tickets">(window.location.hash.startsWith("#tickets") ? "tickets" : "knowledge");
  const [ticketId, setTicketId] = useState<string | null>(initial?.[1] ? decodeURIComponent(initial[1]) : null);

  const navigate = (next: "knowledge" | "tickets", id: string | null = null) => {
    setSection(next);
    setTicketId(id);
    window.location.hash = next === "tickets" ? id ? `tickets/${encodeURIComponent(id)}` : "tickets" : "knowledge";
  };

  return (
    <div class="admin-shell">
      <a class="skip-link" href="#main-content">Skip to main content</a>
      <header class="admin-header">
        <div class="brand-lockup"><span class="brand-mark"><Icon name="sparkles" /></span><div><span class="admin-brand">NAILZIFY</span><strong>Support Studio</strong><small>Knowledge and customer care</small></div></div>
        <nav aria-label="App sections">
          <button class={section === "knowledge" ? "is-active" : ""} aria-current={section === "knowledge" ? "page" : undefined} onClick={() => navigate("knowledge")}><Icon name="book" /><span>Knowledge Base</span></button>
          <button class={section === "tickets" ? "is-active" : ""} aria-current={section === "tickets" ? "page" : undefined} onClick={() => navigate("tickets")}><Icon name="inbox" /><span>Tickets</span></button>
        </nav>
      </header>
      {section === "knowledge" ? <KnowledgeBase /> : <Tickets ticketId={ticketId} onSelect={(id) => navigate("tickets", id)} />}
    </div>
  );
}

function StatusPill({ status }: { status: UploadedDocument["status"] }) {
  const label = status === "processing" ? "Processing" : status === "ready" ? "Ready" : "Failed";
  return <span class={`pill pill--${status}`}><span aria-hidden="true" />{label}</span>;
}

function LoadingState({ label }: { readonly label: string }) {
  return <div class="loading-state" role="status"><span class="spinner" aria-hidden="true" />{label}</div>;
}

function EmptyState({ icon, title, body }: { readonly icon: "book" | "inbox"; readonly title: string; readonly body: string }) {
  return <div class="empty-state"><span class="empty-state__icon"><Icon name={icon} /></span><h3>{title}</h3><p>{body}</p></div>;
}

function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
}

function describeError(cause: unknown): string {
  if (cause instanceof ApiError && cause.status === 401) return "Your session expired. Refresh this page to reconnect.";
  return cause instanceof Error ? cause.message : "Something went wrong. Please try again.";
}
