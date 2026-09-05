import Fastify from "fastify";
import { Redis } from "ioredis";
import { Pool } from "pg";
import { databaseUrl, redisUrl } from "./config.js";

export function buildApp(dependencies = {
  pool: new Pool({ connectionString: databaseUrl }),
  redis: new Redis(redisUrl, { maxRetriesPerRequest: 1 })
}) {
  const app = Fastify({ logger: true });
  app.get("/health", async () => {
    await dependencies.pool.query("SELECT 1");
    await dependencies.redis.ping();
    return { status: "ok", service: "api", database: "ok", redis: "ok" };
  });
  app.addHook("onClose", async () => {
    await dependencies.pool.end();
    await dependencies.redis.quit();
  });
  return app;
}
