import { describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { DeterministicAnalysisModel } from "./agent-runtime.js";

const expiresAt = new Date("2030-01-01T00:00:00.000Z");
const inertDependencies = { pool: { end: async () => undefined } as never, redis: { quit: async () => "OK" } as never };

describe("Riot RSO routes", () => {
  it("registers demo login only when explicitly enabled and never accepts a player identity", async () => {
    const disabled = buildApp({ ...inertDependencies, demoMode: false, agentTrace: null });
    expect((await disabled.inject({ method: "POST", url: "/auth/demo", payload: { userId: "other-user" } })).statusCode).toBe(404);
    await disabled.close();

    const enabled = buildApp({
      ...inertDependencies,
      demoMode: true,
      demoSession: { create: async () => ({ token: "demo-session", expiresAt }) },
      agentTrace: null
    });
    const response = await enabled.inject({ method: "POST", url: "/auth/demo", payload: { userId: "other-user", puuid: "other-puuid" } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ mode: "demo" });
    expect(response.headers["set-cookie"]).toContain("valorant_session=demo-session");
    await enabled.close();
  });

  it("registers the closed eval fixture login only when explicitly enabled", async () => {
    const disabled = buildApp({ ...inertDependencies, evalMode: false, agentTrace: null });
    expect((await disabled.inject({ method: "POST", url: "/auth/eval", payload: { profile: "full" } })).statusCode).toBe(404);
    await disabled.close();
    const profiles: string[] = [];
    const enabled = buildApp({ ...inertDependencies, evalMode: true, agentTrace: null, demoSession: { create: async (profile = "full") => { profiles.push(profile); return { token: "eval-session", expiresAt }; } } });
    expect((await enabled.inject({ method: "POST", url: "/auth/eval", payload: { profile: "small", userId: "other" } })).statusCode).toBe(200);
    expect((await enabled.inject({ method: "POST", url: "/auth/eval", payload: { profile: "other" } })).statusCode).toBe(400);
    expect(profiles).toEqual(["small"]);
    await enabled.close();
  });

  it("starts RSO with an HttpOnly product session cookie", async () => {
    const calls: string[] = [];
    const app = buildApp({
      ...inertDependencies,
      oauth: {
        getOrCreateSession: async () => ({ session: { userId: "user-1", token: "session-token", expiresAt }, created: true }),
        begin: async (userId: string) => { calls.push(userId); return "https://rso.example.test/authorize?state=opaque"; }
      } as never
    });

    const response = await app.inject({ method: "GET", url: "/auth/riot/start" });
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe("https://rso.example.test/authorize?state=opaque");
    expect(response.headers["set-cookie"]).toContain("valorant_session=session-token");
    expect(response.headers["set-cookie"]).toContain("HttpOnly");
    expect(calls).toEqual(["user-1"]);
    await app.close();
  });

  it("requires the initiating product session before completing or disconnecting", async () => {
    const app = buildApp({
      ...inertDependencies,
      oauth: { getSession: async () => null } as never
    });

    const callback = await app.inject({ method: "GET", url: "/auth/riot/callback?state=opaque&code=secret-code" });
    const disconnect = await app.inject({ method: "POST", url: "/auth/riot/disconnect" });
    expect(callback.statusCode).toBe(401);
    expect(disconnect.statusCode).toBe(401);
    await app.close();
  });

  it("binds the callback and disconnect action to the current session user", async () => {
    const completions: unknown[][] = [];
    const disconnected: string[] = [];
    const app = buildApp({
      ...inertDependencies,
      oauth: {
        getSession: async () => ({ userId: "user-1", token: "session-token", expiresAt }),
        complete: async (...args: unknown[]) => { completions.push(args); return { userId: "user-1", puuid: "player-puuid" }; },
        disconnect: async (userId: string) => { disconnected.push(userId); }
      } as never
    });

    const callback = await app.inject({ method: "GET", url: "/auth/riot/callback?state=opaque&code=secret-code", headers: { cookie: "valorant_session=session-token" } });
    const disconnect = await app.inject({ method: "POST", url: "/auth/riot/disconnect", headers: { cookie: "valorant_session=session-token" } });
    expect(callback.statusCode).toBe(302);
    expect(completions).toEqual([[{ state: "opaque", code: "secret-code" }, "user-1"]]);
    expect(disconnect.statusCode).toBe(204);
    expect(disconnected).toEqual(["user-1"]);
    await app.close();
  });

  it("runs analysis only for the authenticated session", async () => {
    const calls: string[] = [];
    const app = buildApp({
      ...inertDependencies,
      oauth: {
        getSession: async () => ({ userId: "user-1", token: "session-token", expiresAt }),
      } as never,
      analyticsReader: {
        getPlayerSummary: async (userId: string) => { calls.push(userId); return { scope: { queue: "competitive", sampleSize: 0 }, metrics: null }; },
        getMatchList: async () => ({ scope: { queue: "competitive", sampleSize: 0 }, matches: [] }),
        getMatchDetail: async () => ({ scope: { queue: "competitive", sampleSize: 0 }, match: null }),
        compareAttackDefense: async () => ({ scope: { queue: "competitive", sampleSize: 0 }, attack: { roundsPlayed: 0, roundsWon: 0, winRate: 0 }, defense: { roundsPlayed: 0, roundsWon: 0, winRate: 0 } }),
        compareMapPerformance: async () => ({ scope: { queue: "competitive", sampleSize: 0 }, maps: [] }),
        findRoundEvidence: async () => ({ scope: { queue: "competitive", sampleSize: 0 }, evidence: [] }),
        getRoundEvidence: async () => ({ scope: { queue: "competitive", sampleSize: 0 }, evidence: [] })
      } as never,
      agentModel: new DeterministicAnalysisModel(),
      agentTrace: null
    });
    const response = await app.inject({ method: "POST", url: "/agent/analyze", headers: { cookie: "valorant_session=session-token" }, payload: { question: "Why am I losing?" } });
    expect(response.statusCode).toBe(200);
    expect(response.json().answer.confidence).toBe("low");
    expect(calls).toEqual(["user-1"]);
    await app.close();
  });

  it("lists only current-user matches and rejects an unavailable match scope", async () => {
    const listCalls: unknown[][] = [];
    const app = buildApp({
      ...inertDependencies,
      oauth: { getSession: async () => ({ userId: "user-1", token: "session-token", expiresAt }) } as never,
      analyticsReader: {
        getMatchList: async (...args: unknown[]) => { listCalls.push(args); return { scope: { queue: "competitive", sampleSize: 1 }, matches: [{ matchId: "match-1", mapName: "Ascent", playedAt: "2026-09-16T00:00:00.000Z", result: "win" }] }; },
        getMatchDetail: async () => ({ scope: { queue: "competitive", sampleSize: 0 }, match: null })
      } as never,
      agentTrace: null
    });
    const listed = await app.inject({ method: "GET", url: "/matches?limit=6", headers: { cookie: "valorant_session=session-token" } });
    const unavailable = await app.inject({ method: "POST", url: "/agent/analyze", headers: { cookie: "valorant_session=session-token" }, payload: { question: "复盘这局", scope: { type: "match", matchId: "other-match" } } });
    expect(listed.statusCode).toBe(200);
    expect(listCalls).toEqual([["user-1", 6]]);
    expect(unavailable.statusCode).toBe(404);
    await app.close();
  });
});

describe("account data routes", () => {
  const session = { userId: "user-1", token: "session-token", expiresAt };

  function makeApp(overrides: Record<string, unknown> = {}) {
    const pool = {
      query: async (sql: string) => {
        if (sql.includes("SELECT rso_subject FROM riot_accounts")) return { rows: [{ rso_subject: "demo-rso-full" }], rowCount: 1 };
        if (sql.includes("SELECT game_name, tag_line, rso_subject")) return { rows: [{ game_name: "Fixture", tag_line: "DEMO", rso_subject: "demo-rso-full" }], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      },
      end: async () => undefined
    };
    return buildApp({
      pool: pool as never,
      redis: { quit: async () => "OK" } as never,
      oauth: { getSession: async (token?: string) => token === "session-token" ? session : null } as never,
      analyticsReader: {
        getRiotAccountId: async () => "account-1",
        findActiveSyncJob: async () => null,
        createSyncJob: async (jobId: string) => ({ jobId, status: "queued", imported: 0, skipped: 0, failedMatchIds: [], createdAt: "2030-01-01T00:00:00.000Z", updatedAt: "2030-01-01T00:00:00.000Z" }),
        getSyncJob: async (_userId: string, jobId: string) => ({ jobId, status: "completed", imported: 1, skipped: 0, failedMatchIds: [], createdAt: "2030-01-01T00:00:00.000Z", updatedAt: "2030-01-01T00:00:00.000Z" }),
        updateSyncJob: async () => undefined,
        getTrainingMemories: async () => [],
        createTrainingMemory: async (_userId: string, kind: "goal" | "summary", content: string, sourceRunId?: string) => ({ id: "memory-1", kind, content, sourceRunId, createdAt: "2030-01-01T00:00:00.000Z", updatedAt: "2030-01-01T00:00:00.000Z" }),
        updateTrainingMemory: async (_userId: string, id: string) => id === "memory-1" ? { id, kind: "goal", content: "updated", createdAt: "2030-01-01T00:00:00.000Z", updatedAt: "2030-01-01T00:00:00.000Z" } : null,
        deleteTrainingMemory: async (_userId: string, id: string) => id === "memory-1",
        getRankBenchmark: async () => ({ available: false, tier: null, cohortPlayers: 0, minimumPlayers: 5, player: null, median: null, limitation: "sample too small" })
      } as never,
      syncEnqueuer: async (job) => job.jobId,
      agentTrace: null,
      ...overrides
    });
  }

  it("requires the current session and does not expose another user's memory", async () => {
    const app = makeApp();
    expect((await app.inject({ method: "GET", url: "/memory" })).statusCode).toBe(401);
    expect((await app.inject({ method: "PUT", url: "/memory/other", headers: { cookie: "valorant_session=session-token" }, payload: { kind: "goal", content: "no" } })).statusCode).toBe(404);
    await app.close();
  });

  it("keeps sync idempotent and returns the sample limitation for the benchmark", async () => {
    const app = makeApp({ analyticsReader: {
      getRiotAccountId: async () => "account-1",
      findActiveSyncJob: async () => ({ jobId: "11111111-1111-4111-8111-111111111111", status: "running", imported: 0, skipped: 0, failedMatchIds: [], createdAt: "2030-01-01T00:00:00.000Z", updatedAt: "2030-01-01T00:00:00.000Z" }),
      getRankBenchmark: async () => ({ available: false, tier: 2, cohortPlayers: 2, minimumPlayers: 5, player: null, median: null, limitation: "Only 2 eligible same-tier players are available; at least 5 are required." })
    } });
    const sync = await app.inject({ method: "POST", url: "/sync", headers: { cookie: "valorant_session=session-token" }, payload: {} });
    expect(sync.statusCode).toBe(202);
    expect(sync.json().jobId).toBe("11111111-1111-4111-8111-111111111111");
    const benchmark = await app.inject({ method: "GET", url: "/benchmark", headers: { cookie: "valorant_session=session-token" } });
    expect(benchmark.json()).toMatchObject({ available: false, cohortPlayers: 2, minimumPlayers: 5 });
    await app.close();
  });
});
