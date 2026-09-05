import { createFixtureSyncWorker } from "./worker.js";

const worker = createFixtureSyncWorker();

await worker.start();
console.info("fixture worker ready", { concurrency: 2, queue: "rabbitmq" });

const shutdown = async () => {
  await worker.close();
  process.exit(0);
};

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
