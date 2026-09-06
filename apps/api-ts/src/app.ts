import Fastify from "fastify";
import { Redis } from "ioredis";
import { Pool } from "pg";
import {
  databaseUrl,
  redisUrl,
  riotAccountRegion,
  riotClientId,
  riotClientSecret,
  riotPlatform,
  riotPostAuthRedirectUrl,
  riotRedirectUri,
  riotRsoAuthorizeUrl,
  riotRsoScopes,
  riotRsoTokenUrl,
  riotRsoUserinfoUrl,
  tokenEncryptionKey
} from "./config.js";
import { PostgresRiotOAuthStore, RiotOAuthError, RiotOAuthService } from "./riot-oauth.js";

const SESSION_COOKIE = "valorant_session";

type RuntimeDependencies = {
  pool: Pool;
  redis: Redis;
  oauth?: RiotOAuthService;
};

function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  return header.split(";").map((value) => value.trim()).find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1);
}

function sessionCookie(token: string, maxAgeSeconds: number): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure}`;
}

function postAuthRedirect(): string {
  try {
    const url = new URL(riotPostAuthRedirectUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Unsupported redirect protocol");
    return url.toString();
  } catch {
    throw new RiotOAuthError("configuration", 503, "RIOT_POST_AUTH_REDIRECT_URL must be an absolute HTTP(S) URL");
  }
}

export function buildApp(dependencies: RuntimeDependencies = {
  pool: new Pool({ connectionString: databaseUrl }),
  redis: new Redis(redisUrl, { maxRetriesPerRequest: 1 })
}) {
  const app = Fastify({ logger: true });
  const oauth = dependencies.oauth ?? new RiotOAuthService({
    clientId: riotClientId,
    clientSecret: riotClientSecret,
    redirectUri: riotRedirectUri,
    authorizeUrl: riotRsoAuthorizeUrl,
    tokenUrl: riotRsoTokenUrl,
    userinfoUrl: riotRsoUserinfoUrl,
    accountRegion: riotAccountRegion,
    platform: riotPlatform,
    scopes: riotRsoScopes,
    encryptionKey: tokenEncryptionKey
  }, new PostgresRiotOAuthStore(dependencies.pool));

  app.get("/health", async () => {
    await dependencies.pool.query("SELECT 1");
    await dependencies.redis.ping();
    return { status: "ok", service: "api", database: "ok", redis: "ok" };
  });
  app.get("/auth/riot/start", async (request, reply) => {
    const sessionToken = readCookie(request.headers.cookie, SESSION_COOKIE);
    const { session, created } = await oauth.getOrCreateSession(sessionToken);
    const authorizationUrl = await oauth.begin(session.userId);
    if (created) reply.header("Set-Cookie", sessionCookie(session.token, Math.floor((session.expiresAt.getTime() - Date.now()) / 1_000)));
    return reply.redirect(authorizationUrl);
  });
  app.get("/auth/riot/callback", { logLevel: "silent" }, async (request, reply) => {
    const query = request.query as { state?: string; code?: string; error?: string };
    const session = await oauth.getSession(readCookie(request.headers.cookie, SESSION_COOKIE));
    if (!session) throw new RiotOAuthError("invalid_state", 401, "A valid product session is required");
    await oauth.complete(query, session.userId);
    return reply.redirect(postAuthRedirect());
  });
  app.post("/auth/riot/disconnect", async (request, reply) => {
    const session = await oauth.getSession(readCookie(request.headers.cookie, SESSION_COOKIE));
    if (!session) throw new RiotOAuthError("authorization", 401, "A valid product session is required");
    await oauth.disconnect(session.userId);
    return reply.code(204).send();
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof RiotOAuthError) return reply.code(error.statusCode).send({ error: error.kind, message: error.message });
    return reply.code(500).send({ error: "internal", message: "Internal server error" });
  });
  app.addHook("onClose", async () => {
    await dependencies.pool.end();
    await dependencies.redis.quit();
  });
  return app;
}
