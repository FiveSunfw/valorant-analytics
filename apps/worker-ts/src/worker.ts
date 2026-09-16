import { connect, type Channel, type ChannelModel, type ConsumeMessage } from "amqplib";
import { Pool } from "pg";
import { accountSyncJobSchema, ACCOUNT_SYNC_QUEUE, type AccountSyncJob } from "@valorant/domain";
import { rabbitMqUrl } from "./config.js";
import { databaseUrl, riotApiKey, riotPlatform } from "./config.js";
import {
  accountSyncTopology,
  ensureAccountSyncTopology,
  ensureFixtureSyncTopology,
  fixtureSyncJobSchema,
  fixtureSyncTopology,
  type FixtureSyncTopology
} from "./jobs.js";
import { persistFixtureMatches } from "./persist.js";
import { RiotMatchClient, RiotMatchApiError } from "./riot-match-client.js";

const MAX_RETRY_ATTEMPTS = 3;

export type FixtureSyncWorker = {
  start(): Promise<void>;
  idle(): Promise<void>;
  close(): Promise<void>;
};

type WorkerOptions = { url?: string; queueName?: string };
export type AccountSyncWorkerOptions = WorkerOptions & { pool?: Pool; client?: RiotMatchClient };

function retryCount(message: ConsumeMessage): number {
  const value = message.properties.headers?.["x-retry-count"];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

async function handleMessage(channel: Channel, topology: FixtureSyncTopology, message: ConsumeMessage): Promise<void> {
  try {
    const payload = fixtureSyncJobSchema.parse(JSON.parse(message.content.toString("utf8")));
    await persistFixtureMatches(payload.riotAccountId, payload.matchPayloads);
    channel.ack(message);
  } catch (error) {
    const nextRetryCount = retryCount(message) + 1;
    const destination = nextRetryCount <= MAX_RETRY_ATTEMPTS
      ? topology.retryQueueName
      : topology.deadLetterQueueName;
    try {
      channel.sendToQueue(destination, message.content, {
        contentType: message.properties.contentType ?? "application/json",
        deliveryMode: 2,
        messageId: message.properties.messageId,
        headers: { ...message.properties.headers, "x-retry-count": nextRetryCount }
      });
      channel.ack(message);
      console.error("fixture sync failed", {
        messageId: message.properties.messageId,
        retries: nextRetryCount,
        destination,
        error: error instanceof Error ? error.message : String(error)
      });
    } catch (publishError) {
      console.error("fixture sync retry publish failed", {
        messageId: message.properties.messageId,
        error: publishError instanceof Error ? publishError.message : String(publishError)
      });
      channel.nack(message, false, true);
    }
  }
}

async function updateAccountSyncJob(pool: Pool, jobId: string, patch: {
  status: "queued" | "running" | "completed" | "failed";
  imported?: number; skipped?: number; failedMatchIds?: string[]; errorCode?: string | null;
  errorMessage?: string | null; completed?: boolean;
}): Promise<void> {
  await pool.query(
    `UPDATE sync_jobs SET status = $2, imported = COALESCE($3, imported), skipped = COALESCE($4, skipped),
      failed_match_ids = COALESCE($5::jsonb, failed_match_ids), error_code = $6,
      error_message = $7, updated_at = now(), completed_at = CASE WHEN $8 THEN now() ELSE completed_at END
     WHERE job_id = $1`,
    [jobId, patch.status, patch.imported ?? null, patch.skipped ?? null,
      patch.failedMatchIds ? JSON.stringify(patch.failedMatchIds) : null, patch.errorCode ?? null,
      patch.errorMessage ?? null, patch.completed ?? false]
  );
}

function safeSyncError(error: unknown): { code: string; message: string } {
  if (error instanceof RiotMatchApiError) return { code: error.category, message: error.message };
  if (error instanceof Error) return { code: "worker_error", message: error.message.slice(0, 500) };
  return { code: "worker_error", message: "Account sync failed" };
}

async function handleAccountMessage(
  channel: Channel, topology: ReturnType<typeof accountSyncTopology>, message: ConsumeMessage,
  pool: Pool, client: RiotMatchClient
): Promise<void> {
  let job: AccountSyncJob;
  try {
    job = accountSyncJobSchema.parse(JSON.parse(message.content.toString("utf8")));
  } catch (error) {
    const nextRetryCount = retryCount(message) + 1;
    const destination = nextRetryCount <= MAX_RETRY_ATTEMPTS ? topology.retryQueueName : topology.deadLetterQueueName;
    channel.sendToQueue(destination, message.content, { contentType: "application/json", deliveryMode: 2, messageId: message.properties.messageId, headers: { ...message.properties.headers, "x-retry-count": nextRetryCount } });
    channel.ack(message);
    console.error("account sync payload rejected", { messageId: message.properties.messageId, destination, error: error instanceof Error ? error.message : String(error) });
    return;
  }
  try {
    await updateAccountSyncJob(pool, job.jobId, { status: "running", errorCode: null, errorMessage: null });
    const account = await pool.query<{ puuid: string }>("SELECT puuid FROM riot_accounts WHERE id = $1", [job.riotAccountId]);
    if (!account.rowCount) throw new Error("authorized Riot account was not found");
    const fetched = await client.getCompletedCompetitiveMatches(account.rows[0].puuid);
    const persisted = await persistFixtureMatches(job.riotAccountId, fetched.matches.slice(0, job.maxMatches), pool);
    await updateAccountSyncJob(pool, job.jobId, {
      status: "completed", imported: persisted.imported, skipped: persisted.skipped + Math.max(0, fetched.matches.length - job.maxMatches),
      failedMatchIds: fetched.failedMatchIds, completed: true
    });
    channel.ack(message);
  } catch (error) {
    const nextRetryCount = retryCount(message) + 1;
    const failure = safeSyncError(error);
    const destination = nextRetryCount <= MAX_RETRY_ATTEMPTS ? topology.retryQueueName : topology.deadLetterQueueName;
    try {
      await updateAccountSyncJob(pool, job.jobId, {
        status: nextRetryCount <= MAX_RETRY_ATTEMPTS ? "queued" : "failed",
        errorCode: failure.code, errorMessage: failure.message, completed: nextRetryCount > MAX_RETRY_ATTEMPTS
      });
      channel.sendToQueue(destination, message.content, { contentType: "application/json", deliveryMode: 2, messageId: job.jobId, headers: { ...message.properties.headers, "x-retry-count": nextRetryCount } });
      channel.ack(message);
      console.error("account sync failed", { jobId: job.jobId, retries: nextRetryCount, destination, error: failure.message });
    } catch (publishError) {
      console.error("account sync retry publish failed", { jobId: job.jobId, error: publishError instanceof Error ? publishError.message : String(publishError) });
      channel.nack(message, false, true);
    }
  }
}

export function createFixtureSyncWorker(options: WorkerOptions = {}): FixtureSyncWorker {
  const topology = fixtureSyncTopology(options.queueName);
  let connection: ChannelModel | undefined;
  let channel: Channel | undefined;
  let consumerTag: string | undefined;
  let inFlight = 0;
  let resolveIdle: (() => void) | undefined;

  return {
    async start(): Promise<void> {
      if (channel) return;
      const nextConnection = await connect(options.url ?? rabbitMqUrl);
      const nextChannel = await nextConnection.createChannel();
      await ensureFixtureSyncTopology(nextChannel, topology);
      await nextChannel.prefetch(2);
      const consumer = await nextChannel.consume(topology.queueName, (message) => {
        if (!message) return;
        inFlight += 1;
        void handleMessage(nextChannel, topology, message).finally(() => {
          inFlight -= 1;
          if (inFlight === 0) resolveIdle?.();
        });
      }, { noAck: false });
      connection = nextConnection;
      channel = nextChannel;
      consumerTag = consumer.consumerTag;
    },
    async idle(): Promise<void> {
      if (inFlight === 0) return;
      await new Promise<void>((resolve) => {
        resolveIdle = resolve;
      });
      resolveIdle = undefined;
    },
    async close(): Promise<void> {
      if (channel && consumerTag) await channel.cancel(consumerTag);
      if (channel) await channel.close();
      if (connection) await connection.close();
      channel = undefined;
      connection = undefined;
      consumerTag = undefined;
    }
  };
}

export function createAccountSyncWorker(options: AccountSyncWorkerOptions = {}): FixtureSyncWorker {
  const topology = accountSyncTopology();
  let connection: ChannelModel | undefined;
  let channel: Channel | undefined;
  let consumerTag: string | undefined;
  let inFlight = 0;
  let resolveIdle: (() => void) | undefined;
  const pool = options.pool ?? new Pool({ connectionString: databaseUrl });
  const client = options.client ?? RiotMatchClient.fromEnvironment();
  const ownsPool = options.pool === undefined;
  return {
    async start(): Promise<void> {
      if (channel) return;
      const nextConnection = await connect(options.url ?? rabbitMqUrl);
      const nextChannel = await nextConnection.createChannel();
      await ensureAccountSyncTopology(nextChannel, topology);
      await nextChannel.prefetch(2);
      const consumer = await nextChannel.consume(ACCOUNT_SYNC_QUEUE, (message) => {
        if (!message) return;
        inFlight += 1;
        void handleAccountMessage(nextChannel, topology, message, pool, client).finally(() => {
          inFlight -= 1;
          if (inFlight === 0) resolveIdle?.();
        });
      }, { noAck: false });
      connection = nextConnection;
      channel = nextChannel;
      consumerTag = consumer.consumerTag;
    },
    async idle(): Promise<void> {
      if (inFlight === 0) return;
      await new Promise<void>((resolve) => { resolveIdle = resolve; });
      resolveIdle = undefined;
    },
    async close(): Promise<void> {
      if (channel && consumerTag) await channel.cancel(consumerTag);
      if (channel) await channel.close();
      if (connection) await connection.close();
      if (ownsPool) await pool.end();
      channel = undefined;
      connection = undefined;
      consumerTag = undefined;
    }
  };
}
