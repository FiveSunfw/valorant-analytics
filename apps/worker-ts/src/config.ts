import { loadLocalEnv } from "@valorant/config";

loadLocalEnv();

export const databaseUrl = process.env.DATABASE_URL ?? "postgresql://valorant:valorant_dev@127.0.0.1:15432/valorant";
export const redisUrl = process.env.REDIS_URL ?? "redis://127.0.0.1:16379/0";
export const rabbitMqUrl = process.env.RABBITMQ_URL ?? "amqp://127.0.0.1:5672";
export const riotApiKey = process.env.RIOT_API_KEY ?? "";
export const riotPlatform = process.env.RIOT_PLATFORM ?? "ap";
