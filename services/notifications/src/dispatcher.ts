import { SendMessageBatchCommand, SQSClient } from "@aws-sdk/client-sqs";

interface DynamoAttribute { readonly S?: string; readonly N?: string }
interface StreamRecord {
  readonly eventName?: string;
  readonly dynamodb?: {
    readonly NewImage?: Record<string, DynamoAttribute>;
    readonly OldImage?: Record<string, DynamoAttribute>;
  };
}
interface StreamEvent { readonly Records: readonly StreamRecord[] }

const sqs = new SQSClient({});

export async function handler(event: StreamEvent): Promise<void> {
  const queueUrl = required("TICKET_NOTIFICATION_QUEUE_URL");
  const jobs = event.Records
    .filter((record) =>
      record.eventName === "INSERT" ||
      (record.eventName === "MODIFY" &&
        record.dynamodb?.NewImage?.["status"]?.S === "queued" &&
        record.dynamodb?.OldImage?.["status"]?.S !== "queued"),
    )
    .map((record) => record.dynamodb?.NewImage)
    .filter((image): image is Record<string, DynamoAttribute> => image?.["entityType"]?.S === "TicketNotification")
    .map((image) => ({
      jobId: string(image, "jobId"),
      ticketId: string(image, "ticketId"),
      eventId: string(image, "eventId"),
      recipientType: string(image, "recipientType"),
      template: string(image, "template"),
      recipient: string(image, "recipient"),
      createdAt: number(image, "createdAt"),
      ...(image["commentId"]?.S ? { commentId: image["commentId"].S } : {}),
      ...(image["commentCreatedAt"]?.N ? { commentCreatedAt: Number(image["commentCreatedAt"].N) } : {}),
    }));

  for (let offset = 0; offset < jobs.length; offset += 10) {
    const batch = jobs.slice(offset, offset + 10);
    const result = await sqs.send(new SendMessageBatchCommand({
      QueueUrl: queueUrl,
      Entries: batch.map((job, index) => ({
        Id: `${offset + index}`,
        MessageBody: JSON.stringify(job),
      })),
    }));
    if (result.Failed?.length) throw new Error(`Failed to queue ${result.Failed.length} ticket notifications`);
  }
  if (jobs.length > 0) console.log(JSON.stringify({ event: "ticket.notifications.queued", count: jobs.length }));
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}
function string(image: Record<string, DynamoAttribute>, key: string): string {
  const value = image[key]?.S;
  if (!value) throw new Error(`Notification record is missing ${key}`);
  return value;
}
function number(image: Record<string, DynamoAttribute>, key: string): number {
  return Number(image[key]?.N ?? 0);
}
