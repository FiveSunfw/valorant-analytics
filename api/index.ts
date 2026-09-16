import type { IncomingMessage, ServerResponse } from "node:http";

type ApiModule = typeof import("../apps/api-ts/src/app.js");
let appPromise: Promise<ReturnType<ApiModule["buildApp"]>> | undefined;

async function createApp(): Promise<ReturnType<ApiModule["buildApp"]>> {
  const { buildApp } = await import("../apps/api-ts/src/app.js");
  return buildApp();
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  appPromise ??= createApp();
  const app = await appPromise;
  await app.ready();
  app.routing(req, res);
}
