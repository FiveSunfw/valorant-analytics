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
import { analysisModelInputUsdPerMillion, analysisModelOutputUsdPerMillion, enableDemoMode, enableEvalMode } from "./config.js";
import { PostgresRiotOAuthStore, RiotOAuthError, RiotOAuthService } from "./riot-oauth.js";
import { AnalyticsReader } from "./analytics-reader.js";
import { AgentRunError, createDefaultAnalysis, type AgentModel } from "./agent-runtime.js";
import { createAgentModelFromEnvironment } from "./openai-compatible-model.js";
import { PostgresAgentTraceSink, type AgentTraceSink } from "./agent-trace.js";
import { DemoSessionError, DemoSessionService } from "./demo-session.js";
import { isDemoFixtureProfile, type DemoFixtureProfile } from "./demo-fixtures.js";

const SESSION_COOKIE = "valorant_session";

type RuntimeDependencies = {
  pool: Pool;
  redis: Redis;
  oauth?: RiotOAuthService;
  analyticsReader?: AnalyticsReader;
  agentModel?: AgentModel;
  agentTrace?: AgentTraceSink | null;
  demoMode?: boolean;
  evalMode?: boolean;
  demoSession?: { create(profile?: DemoFixtureProfile): Promise<{ token: string; expiresAt: Date }> };
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
  const analyticsReader = dependencies.analyticsReader ?? new AnalyticsReader(dependencies.pool);
  const agentModel = dependencies.agentModel ?? createAgentModelFromEnvironment();
  const agentTrace = dependencies.agentTrace === undefined ? new PostgresAgentTraceSink(dependencies.pool) : dependencies.agentTrace;
  const demoMode = dependencies.demoMode ?? enableDemoMode;
  const evalMode = dependencies.evalMode ?? enableEvalMode;
  const demoSession = dependencies.demoSession ?? new DemoSessionService(dependencies.pool);

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
  if (demoMode && process.env.NODE_ENV !== "production") {
    app.post("/auth/demo", async (_request, reply) => {
      const session = await demoSession.create();
      reply.header("Set-Cookie", sessionCookie(session.token, Math.floor((session.expiresAt.getTime() - Date.now()) / 1_000)));
      return reply.send({ mode: "demo" });
    });
  }
  if (evalMode && process.env.NODE_ENV !== "production") {
    app.post("/auth/eval", async (request, reply) => {
      const profile = (request.body as { profile?: unknown } | undefined)?.profile;
      if (!isDemoFixtureProfile(profile)) return reply.code(400).send({ error: "invalid_fixture_profile", message: "A fixed fixture profile is required" });
      const session = await demoSession.create(profile);
      reply.header("Set-Cookie", sessionCookie(session.token, Math.floor((session.expiresAt.getTime() - Date.now()) / 1_000)));
      return reply.send({ mode: "eval", profile });
    });
  }
  app.get("/matches", async (request) => {
    const session = await oauth.getSession(readCookie(request.headers.cookie, SESSION_COOKIE));
    if (!session) throw new RiotOAuthError("authorization", 401, "A valid product session is required");
    const requestedLimit = Number((request.query as { limit?: string }).limit ?? 6);
    const limit = Number.isInteger(requestedLimit) && requestedLimit >= 1 && requestedLimit <= 10 ? requestedLimit : 6;
    return analyticsReader.getMatchList(session.userId, limit);
  });
  app.post("/agent/analyze", async (request, reply) => {
    const session = await oauth.getSession(readCookie(request.headers.cookie, SESSION_COOKIE));
    if (!session) throw new RiotOAuthError("authorization", 401, "A valid product session is required");
    const body = request.body as { question?: unknown; scope?: unknown } | undefined;
    if (typeof body?.question !== "string") throw new AgentRunError("invalid_input", "question must be a string");
    let scopedQuestion = body.question;
    if (body.scope !== undefined) {
      if (!body.scope || typeof body.scope !== "object" || !("type" in body.scope)) throw new AgentRunError("invalid_input", "scope is invalid");
      const scope = body.scope as { type?: unknown; matchId?: unknown };
      if (scope.type === "match") {
        if (typeof scope.matchId !== "string" || !scope.matchId) throw new AgentRunError("invalid_input", "match scope requires matchId");
        const ownedMatch = await analyticsReader.getMatchDetail(session.userId, scope.matchId);
        if (!ownedMatch.match) return reply.code(404).send({ error: "match_not_found", message: "The selected competitive match was not found" });
        scopedQuestion = `${body.question}\n[Product scope: analyze only competitive match ${scope.matchId}]`;
      } else if (scope.type !== "recent") throw new AgentRunError("invalid_input", "scope type is invalid");
    }
    const result = await createDefaultAnalysis({
      user: { userId: session.userId }, question: scopedQuestion, reader: analyticsReader, model: agentModel, traceSink: agentTrace, usageRates: { inputUsdPerMillion: analysisModelInputUsdPerMillion, outputUsdPerMillion: analysisModelOutputUsdPerMillion }
    });
    return reply.send(result);
  });
  app.get("/agent/runs/:runId", async (request, reply) => {
    const session = await oauth.getSession(readCookie(request.headers.cookie, SESSION_COOKIE));
    if (!session) throw new RiotOAuthError("authorization", 401, "A valid product session is required");
    if (!agentTrace || !(agentTrace instanceof PostgresAgentTraceSink)) return reply.code(404).send({ error: "not_found", message: "Run trace is unavailable" });
    const run = await agentTrace.findForUser((request.params as { runId: string }).runId, session.userId);
    if (!run) return reply.code(404).send({ error: "not_found", message: "Run trace was not found" });
    return reply.send(run);
  });
  app.setErrorHandler((error, request, reply) => {
    request.log.error({ err: error }, "Request failed");
    if (error instanceof RiotOAuthError) return reply.code(error.statusCode).send({ error: error.kind, message: error.message });
    if (error instanceof DemoSessionError) return reply.code(409).send({ error: "demo_not_seeded", message: error.message });
    if (error instanceof AgentRunError) return reply.code(error.code === "model_failed" ? 503 : error.code === "invalid_input" ? 400 : 422).send({ error: error.code, message: error.message });
    return reply.code(500).send({ error: "internal", message: "Internal server error" });
  });
  app.addHook("onClose", async () => {
    await dependencies.pool.end();
    await dependencies.redis.quit();
  });
  return app;
}
