import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, createUpload, deleteUpload, listUploads, putFile } from "./api.js";
import type { UploadedDocument } from "./types.js";

/** How often to re-check while something is still "processing". */
const POLL_MS = 4000;

export function App() {
  const [documents, setDocuments] = useState<readonly UploadedDocument[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
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

  // Poll only while something is genuinely in flight. An admin who leaves
  // this tab open with nothing processing should not generate a request
  // every four seconds forever.
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
      if (!file) return;

      setUploading(true);
      setError(null);
      try {
        const { uploadUrl } = await createUpload(file.name);
        await putFile(uploadUrl, file);
        if (fileInput.current) fileInput.current.value = "";
        await refresh();
      } catch (cause) {
        setError(describeError(cause));
      } finally {
        setUploading(false);
      }
    },
    [refresh],
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

  return (
    <main class="page">
      <h1>Knowledge base</h1>
      <p class="lede">
        Upload a PDF — a policy, a guide, an FAQ — and it becomes something the chat bot can
        answer questions from. Re-uploading a file with the same name replaces that document.
      </p>

      <form class="upload-form" onSubmit={handleUpload}>
        <input ref={fileInput} type="file" accept="application/pdf" disabled={uploading} />
        <button type="submit" disabled={uploading}>
          {uploading ? "Uploading…" : "Upload"}
        </button>
      </form>

      {error && <p class="error">{error}</p>}

      {loaded && documents.length === 0 && !error && (
        <p class="empty">No documents uploaded yet.</p>
      )}

      {documents.length > 0 && (
        <table class="documents">
          <thead>
            <tr>
              <th>Document</th>
              <th>Status</th>
              <th>Type</th>
              <th>Updated</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {documents.map((doc) => (
              <tr key={doc.documentId}>
                <td>
                  <div class="title">{doc.title ?? doc.documentId}</div>
                  {doc.status === "failed" && doc.errorMessage && (
                    <div class="doc-error">{doc.errorMessage}</div>
                  )}
                </td>
                <td>
                  <StatusPill status={doc.status} />
                </td>
                <td>{doc.docType ?? "—"}</td>
                <td>{formatTimestamp(doc.updatedAt)}</td>
                <td>
                  <button
                    type="button"
                    class="delete"
                    onClick={() => void handleDelete(doc.documentId)}
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}

function StatusPill({ status }: { status: UploadedDocument["status"] }) {
  const label = status === "processing" ? "Processing…" : status === "ready" ? "Ready" : "Failed";
  return <span class={`pill pill-${status}`}>{label}</span>;
}

function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

function describeError(cause: unknown): string {
  if (cause instanceof ApiError && cause.status === 401) {
    return "Session expired — refresh the page.";
  }
  return cause instanceof Error ? cause.message : "Something went wrong.";
}
