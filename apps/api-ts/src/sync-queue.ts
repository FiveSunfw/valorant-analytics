import { connect, type Channel } from "amqplib";
import { accountSyncJobSchema, ACCOUNT_SYNC_EXCHANGE, ACCOUNT_SYNC_QUEUE, ACCOUNT_SYNC_ROUTING_KEY, type AccountSyncJob } from "@valorant/domain";
import { rabbitMqUrl } from "./config.js";

export async function ensureAccountSyncTopology(channel: Channel): Promise<void> {
  await channel.assertExchange(ACCOUNT_SYNC_EXCHANGE, "direct", { durable: true });
  await channel.assertQueue(ACCOUNT_SYNC_QUEUE, { durable: true });
  await channel.bindQueue(ACCOUNT_SYNC_QUEUE, ACCOUNT_SYNC_EXCHANGE, ACCOUNT_SYNC_ROUTING_KEY);
}

export async function enqueueAccountSync(job: AccountSyncJob): Promise<string> {
  const payload = accountSyncJobSchema.parse(job);
  const connection = await connect(rabbitMqUrl);
  const channel = await connection.createChannel();
  try {
    await ensureAccountSyncTopology(channel);
    const accepted = channel.publish(
      ACCOUNT_SYNC_EXCHANGE,
      ACCOUNT_SYNC_ROUTING_KEY,
      Buffer.from(JSON.stringify(payload)),
      { contentType: "application/json", deliveryMode: 2, messageId: payload.jobId }
    );
    if (!accepted) throw new Error("RabbitMQ did not accept the sync message");
    return payload.jobId;
  } finally {
    await channel.close();
    await connection.close();
  }
}
