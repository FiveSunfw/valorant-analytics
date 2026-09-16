import { createAccountSyncWorker, createFixtureSyncWorker } from "./worker.js";
import { riotApiKey } from "./config.js";

const fixtureWorker = createFixtureSyncWorker();
const accountWorker = riotApiKey ? createAccountSyncWorker() : undefined;

await fixtureWorker.start();
if (accountWorker) await accountWorker.start();
console.info("fixture worker ready", { concurrency: 2, queue: "rabbitmq" });
console.info(accountWorker ? "account sync worker ready" : "account sync worker disabled until RIOT_API_KEY is configured", { concurrency: 2, queue: "valorant.account-sync" });

const shutdown = async () => {
  await Promise.all([fixtureWorker.close(), accountWorker?.close()]);
  process.exit(0);
};

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
