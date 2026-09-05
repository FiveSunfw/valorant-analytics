import { loadLocalEnv } from "@valorant/config";

loadLocalEnv();

export const databaseUrl = process.env.DATABASE_URL ?? "postgresql://valorant:valorant_dev@127.0.0.1:15432/valorant";
export const redisUrl = process.env.REDIS_URL ?? "redis://127.0.0.1:16379/0";
