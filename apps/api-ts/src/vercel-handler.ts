import type { FastifyInstance } from "fastify";
import { buildApp } from "./app.js";

type AppProvider = () => Promise<FastifyInstance>;
type RequestMethod = "DELETE" | "GET" | "HEAD" | "OPTIONS" | "PATCH" | "POST" | "PUT";

const hopByHopHeaders = new Set([
  "connection",
  "content-length",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade"
]);

export function fastifyUrl(request: Request): string {
  const incoming = new URL(request.url);
  const rewrittenPath = incoming.searchParams.get("__path");
  incoming.searchParams.delete("__path");

  const pathname = rewrittenPath
    ? (rewrittenPath.startsWith("/") ? rewrittenPath : `/${rewrittenPath}`)
    : incoming.pathname.replace(/^\/api\/index\/?/, "/");
  const query = incoming.searchParams.toString();
  return query ? `${pathname}?${query}` : pathname;
}

export async function handleVercelRequest(request: Request, getApp: AppProvider): Promise<Response> {
  const app = await getApp();
  const payload = request.method === "GET" || request.method === "HEAD"
    ? undefined
    : Buffer.from(await request.arrayBuffer());
  const injected = await app.inject({
    method: request.method as RequestMethod,
    url: fastifyUrl(request),
    headers: Object.fromEntries(request.headers.entries()),
    payload
  });

  const headers = new Headers();
  for (const [name, value] of Object.entries(injected.headers)) {
    if (value === undefined || hopByHopHeaders.has(name.toLowerCase())) continue;
    for (const item of Array.isArray(value) ? value : [value]) headers.append(name, String(item));
  }
  const body = request.method === "HEAD" || [204, 205, 304].includes(injected.statusCode)
    ? null
    : injected.body;
  return new Response(body, { status: injected.statusCode, headers });
}

let app: FastifyInstance | undefined;
let appReady: PromiseLike<void> | undefined;

async function productionApp(): Promise<FastifyInstance> {
  if (!app) {
    app = buildApp();
    appReady = app.ready().then(() => undefined);
  }
  await appReady;
  return app;
}

export default {
  fetch(request: Request): Promise<Response> {
    return handleVercelRequest(request, productionApp);
  }
};
