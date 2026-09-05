import { connect, type Channel, type ChannelModel, type ConsumeMessage } from "amqplib";
import { rabbitMqUrl } from "./config.js";
import {
  ensureFixtureSyncTopology,
  fixtureSyncJobSchema,
  fixtureSyncTopology,
  type FixtureSyncTopology
} from "./jobs.js";
import { persistFixtureMatches } from "./persist.js";

const MAX_RETRY_ATTEMPTS = 3;

export type FixtureSyncWorker = {
  start(): Promise<void>;
  idle(): Promise<void>;
  close(): Promise<void>;
};

type WorkerOptions = { url?: string; queueName?: string };

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
