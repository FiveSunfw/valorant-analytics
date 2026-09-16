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
