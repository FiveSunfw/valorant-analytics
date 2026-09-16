import type { IncomingMessage, ServerResponse } from "node:http";
import { buildApp } from "../apps/api-ts/src/app.js";

let appPromise: ReturnType<typeof buildApp> | undefined;

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  appPromise ??= buildApp();
  const app = appPromise;
  await app.ready();
  app.routing(req, res);
}
