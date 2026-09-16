import { randomUUID } from "node:crypto";
import { connect, type Channel } from "amqplib";
import { z } from "zod";
import {
  ACCOUNT_SYNC_EXCHANGE,
  ACCOUNT_SYNC_QUEUE,
  ACCOUNT_SYNC_ROUTING_KEY,
  accountSyncJobSchema,
  rawMatchSchema,
  type AccountSyncJob
} from "@valorant/domain";
import { rabbitMqUrl } from "./config.js";

export const SYNC_EXCHANGE = "valorant.sync";
export const SYNC_ROUTING_KEY = "fixture-sync";
export const SYNC_FIXTURE_QUEUE = "valorant.fixture-sync";
export { ACCOUNT_SYNC_EXCHANGE, ACCOUNT_SYNC_QUEUE, ACCOUNT_SYNC_ROUTING_KEY };
export type { AccountSyncJob };

export const fixtureSyncJobSchema = z.object({
  riotAccountId: z.string().uuid(),
  matchPayloads: z.array(rawMatchSchema)
});

export type FixtureSyncJob = z.infer<typeof fixtureSyncJobSchema>;

export type FixtureSyncTopology = {
  exchangeName: string;
  routingKey: string;
  queueName: string;
  retryQueueName: string;
  deadLetterQueueName: string;
};

export function fixtureSyncTopology(queueName = SYNC_FIXTURE_QUEUE): FixtureSyncTopology {
  const isDefault = queueName === SYNC_FIXTURE_QUEUE;
  return {
    exchangeName: isDefault ? SYNC_EXCHANGE : `${SYNC_EXCHANGE}.${queueName}`,
    routingKey: SYNC_ROUTING_KEY,
    queueName,
    retryQueueName: `${queueName}.retry`,
    deadLetterQueueName: `${queueName}.dlq`
  };
}

export async function ensureFixtureSyncTopology(channel: Channel, topology = fixtureSyncTopology()): Promise<void> {
  await channel.assertExchange(topology.exchangeName, "direct", { durable: true });
  await channel.assertQueue(topology.queueName, { durable: true });
  await channel.bindQueue(topology.queueName, topology.exchangeName, topology.routingKey);
  await channel.assertQueue(topology.retryQueueName, {
    durable: true,
    arguments: {
      "x-message-ttl": 1_000,
      "x-dead-letter-exchange": topology.exchangeName,
      "x-dead-letter-routing-key": topology.routingKey
    }
  });
  await channel.assertQueue(topology.deadLetterQueueName, { durable: true });
}

export function publishFixtureSync(
  channel: Channel,
  job: FixtureSyncJob,
  topology = fixtureSyncTopology()
): string {
  const payload = fixtureSyncJobSchema.parse(job);
  const messageId = randomUUID();
  channel.publish(topology.exchangeName, topology.routingKey, Buffer.from(JSON.stringify(payload)), {
    contentType: "application/json",
    deliveryMode: 2,
    messageId,
    headers: { "x-retry-count": 0 }
  });
  return messageId;
}

export async function enqueueFixtureSync(job: FixtureSyncJob): Promise<string> {
  const connection = await connect(rabbitMqUrl);
  const channel = await connection.createChannel();
  try {
    const topology = fixtureSyncTopology();
    await ensureFixtureSyncTopology(channel, topology);
    return publishFixtureSync(channel, job, topology);
  } finally {
    await channel.close();
    await connection.close();
  }
}

export type AccountSyncTopology = {
  exchangeName: string;
  routingKey: string;
  queueName: string;
  retryQueueName: string;
  deadLetterQueueName: string;
};

export function accountSyncTopology(): AccountSyncTopology {
  return {
    exchangeName: ACCOUNT_SYNC_EXCHANGE,
    routingKey: ACCOUNT_SYNC_ROUTING_KEY,
    queueName: ACCOUNT_SYNC_QUEUE,
    retryQueueName: `${ACCOUNT_SYNC_QUEUE}.retry`,
    deadLetterQueueName: `${ACCOUNT_SYNC_QUEUE}.dlq`
  };
}

export async function ensureAccountSyncTopology(channel: Channel, topology = accountSyncTopology()): Promise<void> {
  await channel.assertExchange(topology.exchangeName, "direct", { durable: true });
  await channel.assertQueue(topology.queueName, { durable: true });
  await channel.bindQueue(topology.queueName, topology.exchangeName, topology.routingKey);
  await channel.assertQueue(topology.retryQueueName, {
    durable: true,
    arguments: {
      "x-message-ttl": 1_000,
      "x-dead-letter-exchange": topology.exchangeName,
      "x-dead-letter-routing-key": topology.routingKey
    }
  });
  await channel.assertQueue(topology.deadLetterQueueName, { durable: true });
}

export function publishAccountSync(channel: Channel, job: AccountSyncJob, topology = accountSyncTopology()): string {
  const payload = accountSyncJobSchema.parse(job);
  channel.publish(topology.exchangeName, topology.routingKey, Buffer.from(JSON.stringify(payload)), {
    contentType: "application/json",
    deliveryMode: 2,
    messageId: payload.jobId,
    headers: { "x-retry-count": 0 }
  });
  return payload.jobId;
}

export async function enqueueAccountSync(job: AccountSyncJob): Promise<string> {
  const connection = await connect(rabbitMqUrl);
  const channel = await connection.createChannel();
  try {
    const topology = accountSyncTopology();
    await ensureAccountSyncTopology(channel, topology);
    return publishAccountSync(channel, job, topology);
  } finally {
    await channel.close();
    await connection.close();
  }
}
