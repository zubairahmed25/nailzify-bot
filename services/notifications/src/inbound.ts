import { DeleteObjectCommand, GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { simpleParser } from "mailparser";
import { processInboundReply, ticketIdForReplyRecipients } from "./inbound-reply.js";

interface Verdict { readonly status?: string }
interface SesReceiptEvent {
  readonly Records?: readonly {
    readonly ses?: {
      readonly mail?: {
        readonly messageId?: string;
        readonly timestamp?: string;
        readonly destination?: readonly string[];
      };
      readonly receipt?: {
        readonly recipients?: readonly string[];
        readonly spamVerdict?: Verdict;
        readonly virusVerdict?: Verdict;
      };
    };
  }[];
}

const s3 = new S3Client({});

export async function handler(event: SesReceiptEvent): Promise<void> {
  for (const record of event.Records ?? []) {
    if (record.ses) await processRecord(record.ses);
  }
}

async function processRecord(ses: NonNullable<NonNullable<SesReceiptEvent["Records"]>[number]["ses"]>): Promise<void> {
  const messageId = ses.mail?.messageId;
  if (!messageId) return reject("missing_message_id");
  const bucket = required("TICKET_EMAIL_BUCKET");
  const key = `incoming/${messageId}`;

  if (!passed(ses.receipt?.spamVerdict) || !passed(ses.receipt?.virusVerdict)) {
    await removeRaw(bucket, key);
    return reject("content_verdict_failed", messageId);
  }

  const recipients = [...(ses.receipt?.recipients ?? []), ...(ses.mail?.destination ?? [])];
  if (!await ticketIdForReplyRecipients(recipients)) {
    await removeRaw(bucket, key);
    return reject("invalid_reply_token", messageId);
  }

  try {
    const raw = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const parsed = await simpleParser(Buffer.from(await raw.Body!.transformToByteArray()), {
      skipHtmlToText: false,
      skipTextToHtml: true,
    });
    await processInboundReply({
      messageId,
      recipients,
      ...(parsed.from?.value[0]?.address ? { sender: parsed.from.value[0].address } : {}),
      body: newReplyText(parsed.text ?? ""),
      receivedAt: Date.parse(ses.mail?.timestamp ?? "") || Date.now(),
    });
  } finally {
    await removeRaw(bucket, key);
  }
}

function newReplyText(text: string): string {
  return text
    .split(/\n--- Reply above this line ---/i)[0]!
    .split(/\nOn .+ wrote:\s*$/im)[0]!
    .split(/\n-{2,}\s*Original Message\s*-{2,}/i)[0]!
    .trim()
    .slice(0, 10_000);
}

function passed(verdict: Verdict | undefined) { return verdict?.status === "PASS"; }
async function removeRaw(bucket: string, key: string) {
  await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}
function reject(reason: string, messageId?: string) {
  console.warn(JSON.stringify({ event: "ticket.inbound.rejected", reason, messageId }));
}
function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

export const inboundTextForTest = newReplyText;
