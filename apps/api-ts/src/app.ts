import Fastify from "fastify";
import { Redis } from "ioredis";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { accountSyncJobSchema, type AccountSyncJob } from "@valorant/domain";
import {
  databaseUrl,
  redisUrl,
  riotAccountRegion,
  riotClientId,
  riotClientSecret,
  riotPlatform,
  riotApiKey,
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
import { AgentRunError, type AgentModel } from "./agent-runtime.js";
import { runMultiAgentAnalysis } from "./multi-agent.js";
import { createAgentModelFromEnvironment } from "./openai-compatible-model.js";
import { PostgresAgentTraceSink, type AgentTraceSink } from "./agent-trace.js";
import { DemoSessionError, DemoSessionService } from "./demo-session.js";
import { isDemoFixtureProfile, type DemoFixtureProfile } from "./demo-fixtures.js";
import { enqueueAccountSync } from "./sync-queue.js";
import { KnowledgeRagClient } from "./knowledge-rag.js";
import { mem0ApiKey, mem0BaseUrl, mem0TimeoutMs } from "./config.js";
import { memoryProviderFromEnvironment, type MemoryProvider } from "./mem0-memory.js";

const SESSION_COOKIE = "valorant_session";

type RuntimeDependencies = {
  pool: Pool;
  redis: Redis;
  oauth?: RiotOAuthService;
  analyticsReader?: AnalyticsReader;
  memoryProvider?: MemoryProvider;
  agentModel?: AgentModel;
  agentTrace?: AgentTraceSink | null;
  demoMode?: boolean;
  evalMode?: boolean;
  syncEnqueuer?: (job: AccountSyncJob) => Promise<string>;
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
  const memoryProvider = dependencies.memoryProvider ?? memoryProviderFromEnvironment({ apiKey: mem0ApiKey, baseUrl: mem0BaseUrl, timeoutMs: mem0TimeoutMs });
  const analyticsReader = dependencies.analyticsReader ?? new AnalyticsReader(dependencies.pool, new KnowledgeRagClient(), memoryProvider);
  const agentModel = dependencies.agentModel ?? createAgentModelFromEnvironment();
  const agentTrace = dependencies.agentTrace === undefined ? new PostgresAgentTraceSink(dependencies.pool) : dependencies.agentTrace;
  const demoMode = dependencies.demoMode ?? enableDemoMode;
  const evalMode = dependencies.evalMode ?? enableEvalMode;
  const demoSession = dependencies.demoSession ?? new DemoSessionService(dependencies.pool);
  const syncEnqueuer = dependencies.syncEnqueuer ?? enqueueAccountSync;

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
    if (typeof (dependencies.pool as unknown as { query?: unknown }).query === "function") {
      await analyticsReader.deleteAllTrainingMemories?.(session.userId);
    }
    await oauth.disconnect(session.userId);
    return reply.code(204).send();
  });
  app.get("/auth/status", async (request) => {
    const session = await oauth.getSession(readCookie(request.headers.cookie, SESSION_COOKIE));
    if (!session) return { authenticated: false, connected: false };
    const result = await dependencies.pool.query<{ game_name: string | null; tag_line: string | null; rso_subject: string }>(
      "SELECT game_name, tag_line, rso_subject FROM riot_accounts WHERE user_id = $1 LIMIT 1", [session.userId]
    );
    const account = result.rows[0];
    return {
      authenticated: true,
      connected: Boolean(account),
      mode: account?.rso_subject.startsWith("demo-rso-") ? "demo" : "riot",
      account: account ? { gameName: account.game_name, tagLine: account.tag_line } : null
    };
  });
  // Demo mode is opt-in and uses only the fixed fixture account, so it can
  // power the hosted showcase when ENABLE_DEMO_MODE=true on Vercel.
  if (demoMode) {
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
  app.post("/sync", async (request, reply) => {
    const session = await oauth.getSession(readCookie(request.headers.cookie, SESSION_COOKIE));
    if (!session) throw new RiotOAuthError("authorization", 401, "A valid product session is required");
    const riotAccountId = await analyticsReader.getRiotAccountId(session.userId);
    if (!riotAccountId) return reply.code(409).send({ error: "riot_not_connected", message: "Connect a Riot account before syncing matches" });
    const active = await analyticsReader.findActiveSyncJob(session.userId);
    if (active) return reply.code(202).send(active);
    const jobId = randomUUID();
    const job = accountSyncJobSchema.parse({ jobId, riotAccountId, maxMatches: 10 });
    const account = await dependencies.pool.query<{ rso_subject: string }>("SELECT rso_subject FROM riot_accounts WHERE id = $1", [riotAccountId]);
    await analyticsReader.createSyncJob(jobId, session.userId, riotAccountId);
    if (demoMode && account.rows[0]?.rso_subject.startsWith("demo-rso-")) {
      const matches = await analyticsReader.getMatchList(session.userId, 10);
      await analyticsReader.updateSyncJob(jobId, { status: "completed", imported: matches.matches.length, skipped: 0, completed: true });
      return reply.code(202).send(await analyticsReader.getSyncJob(session.userId, jobId));
    }
    if (!riotApiKey) {
      await analyticsReader.updateSyncJob(jobId, { status: "failed", errorCode: "configuration", errorMessage: "Riot Match API is not configured yet", completed: true });
      return reply.code(503).send({ error: "sync_unavailable", message: "Riot Match API is not configured yet" });
    }
    try {
      await syncEnqueuer(job);
    } catch {
      await analyticsReader.updateSyncJob(jobId, { status: "failed", errorCode: "queue_unavailable", errorMessage: "Sync queue is unavailable", completed: true });
      return reply.code(503).send({ error: "sync_unavailable", message: "Sync queue is unavailable" });
    }
    return reply.code(202).send(await analyticsReader.getSyncJob(session.userId, jobId));
  });
  app.get("/sync/:jobId", async (request, reply) => {
    const session = await oauth.getSession(readCookie(request.headers.cookie, SESSION_COOKIE));
    if (!session) throw new RiotOAuthError("authorization", 401, "A valid product session is required");
    const jobId = (request.params as { jobId: string }).jobId;
    const job = await analyticsReader.getSyncJob(session.userId, jobId);
    if (!job) return reply.code(404).send({ error: "not_found", message: "Sync job was not found" });
    return job;
  });
  app.get("/matches", async (request) => {
    const session = await oauth.getSession(readCookie(request.headers.cookie, SESSION_COOKIE));
    if (!session) throw new RiotOAuthError("authorization", 401, "A valid product session is required");
    const requestedLimit = Number((request.query as { limit?: string }).limit ?? 6);
    const limit = Number.isInteger(requestedLimit) && requestedLimit >= 1 && requestedLimit <= 10 ? requestedLimit : 6;
    return analyticsReader.getMatchList(session.userId, limit);
  });
  app.get("/benchmark", async (request) => {
    const session = await oauth.getSession(readCookie(request.headers.cookie, SESSION_COOKIE));
    if (!session) throw new RiotOAuthError("authorization", 401, "A valid product session is required");
    return analyticsReader.getRankBenchmark(session.userId);
  });
  for (const [path, method] of [["/analytics/acts", "getActPerformance"], ["/analytics/agents", "getAgentPerformance"], ["/analytics/economy", "getEconomyPerformance"]] as const) {
    app.get(path, async (request) => {
      const session = await oauth.getSession(readCookie(request.headers.cookie, SESSION_COOKIE));
      if (!session) throw new RiotOAuthError("authorization", 401, "A valid product session is required");
      return analyticsReader[method](session.userId);
    });
  }
  app.get("/analytics/window", async (request, reply) => {
    const session = await oauth.getSession(readCookie(request.headers.cookie, SESSION_COOKIE));
    if (!session) throw new RiotOAuthError("authorization", 401, "A valid product session is required");
    const params = request.query as { from?: string; to?: string };
    if (!params.from || !params.to || Number.isNaN(Date.parse(params.from)) || Number.isNaN(Date.parse(params.to)) || Date.parse(params.to) < Date.parse(params.from)) return reply.code(400).send({ error: "invalid_input", message: "from and to must be valid ordered ISO dates" });
    return analyticsReader.getTimeWindow(session.userId, params.from, params.to);
  });
  app.get("/knowledge/search", async (request, reply) => {
    const session = await oauth.getSession(readCookie(request.headers.cookie, SESSION_COOKIE));
    if (!session) throw new RiotOAuthError("authorization", 401, "A valid product session is required");
    const query = String((request.query as { q?: string }).q ?? "").trim();
    if (query.length < 2 || query.length > 200) return reply.code(400).send({ error: "invalid_input", message: "A knowledge query between 2 and 200 characters is required" });
    const params = request.query as { map?: string; side?: string; limit?: string };
    const side = params.side === "attack" || params.side === "defense" ? params.side : undefined;
    const parsedLimit = Number(params.limit ?? 5);
    const limit = Number.isInteger(parsedLimit) && parsedLimit >= 1 && parsedLimit <= 10 ? parsedLimit : 5;
    return analyticsReader.searchKnowledge(session.userId, query, params.map, side, limit);
  });
  const memoryInput = z.object({ kind: z.enum(["goal", "summary"]), content: z.string().trim().min(1).max(2_000), sourceRunId: z.string().uuid().optional() }).strict();
  app.get("/memory", async (request) => {
    const session = await oauth.getSession(readCookie(request.headers.cookie, SESSION_COOKIE));
    if (!session) throw new RiotOAuthError("authorization", 401, "A valid product session is required");
    return { memories: await analyticsReader.getTrainingMemories(session.userId) };
  });
  app.post("/memory", async (request, reply) => {
    const session = await oauth.getSession(readCookie(request.headers.cookie, SESSION_COOKIE));
    if (!session) throw new RiotOAuthError("authorization", 401, "A valid product session is required");
    const parsed = memoryInput.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_input", message: "Memory kind and content are required" });
    if (parsed.data.sourceRunId && parsed.data.kind !== "summary") return reply.code(400).send({ error: "invalid_input", message: "Only a training summary can cite an analysis run" });
    if (parsed.data.sourceRunId) {
      const hasCompletedRun = typeof analyticsReader.hasCompletedAgentRun === "function"
        && await analyticsReader.hasCompletedAgentRun(session.userId, parsed.data.sourceRunId);
      if (!hasCompletedRun) return reply.code(404).send({ error: "not_found", message: "The analysis run was not found for this user" });
    }
    const memory = await analyticsReader.createTrainingMemory(session.userId, parsed.data.kind, parsed.data.content, parsed.data.sourceRunId);
    return reply.code(201).send(memory);
  });
  app.put("/memory/:id", async (request, reply) => {
    const session = await oauth.getSession(readCookie(request.headers.cookie, SESSION_COOKIE));
    if (!session) throw new RiotOAuthError("authorization", 401, "A valid product session is required");
    const parsed = memoryInput.omit({ sourceRunId: true }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_input", message: "Memory kind and content are required" });
    const memory = await analyticsReader.updateTrainingMemory(session.userId, (request.params as { id: string }).id, parsed.data.kind, parsed.data.content);
    if (!memory) return reply.code(404).send({ error: "not_found", message: "Memory was not found" });
    return memory;
  });
  app.delete("/memory/:id", async (request, reply) => {
    const session = await oauth.getSession(readCookie(request.headers.cookie, SESSION_COOKIE));
    if (!session) throw new RiotOAuthError("authorization", 401, "A valid product session is required");
    const deleted = await analyticsReader.deleteTrainingMemory(session.userId, (request.params as { id: string }).id);
    if (!deleted) return reply.code(404).send({ error: "not_found", message: "Memory was not found" });
    return reply.code(204).send();
  });
  app.post("/agent/analyze", async (request, reply) => {
    const session = await oauth.getSession(readCookie(request.headers.cookie, SESSION_COOKIE));
    if (!session) throw new RiotOAuthError("authorization", 401, "A valid product session is required");
    const body = request.body as { question?: unknown; scope?: unknown } | undefined;
    if (typeof body?.question !== "string") throw new AgentRunError("invalid_input", "question must be a string");
    if (body.question.length > 4_000) throw new AgentRunError("invalid_input", "question must not exceed 4000 characters");
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
    const result = await runMultiAgentAnalysis({
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
