import { describe, expect, it } from "vitest";
import { buildApp } from "./app.js";

describe("health probes", () => {
  it("returns 200 and the fixed liveness payload without touching dependencies", async () => {
    const poolCalls: string[] = [];
    const redisCalls: string[] = [];
    const app = buildApp({
      pool: { query: async (sql: string) => { poolCalls.push(sql); return { rows: [] }; }, end: async () => undefined } as never,
      redis: { ping: async () => { redisCalls.push("ping"); return "PONG"; }, quit: async () => "OK" } as never,
      agentTrace: null
    });

    const response = await app.inject({ method: "GET", url: "/health/live" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok", service: "api" });
    expect(poolCalls).toEqual([]);
    expect(redisCalls).toEqual([]);
    await app.close();
  });

  it("stays 200 when PostgreSQL, Redis and the model are unavailable", async () => {
    let modelTouched = false;
    const app = buildApp({
      pool: { query: async () => { throw new Error("database down"); }, end: async () => undefined } as never,
      redis: { ping: async () => { throw new Error("redis down"); }, quit: async () => "OK" } as never,
      agentModel: { respond: async () => { modelTouched = true; throw new Error("model down"); } } as never,
      memoryProvider: {
        add: async () => { modelTouched = true; throw new Error("memory down"); },
        search: async () => { modelTouched = true; throw new Error("memory down"); }
      } as never,
      agentTrace: null
    });

    const live = await app.inject({ method: "GET", url: "/health/live" });
    const ready = await app.inject({ method: "GET", url: "/health" });

    expect(live.statusCode).toBe(200);
    expect(live.json()).toEqual({ status: "ok", service: "api" });
    expect(ready.statusCode).toBe(500);
    expect(modelTouched).toBe(false);
    await app.close();
  });

  it("serves the liveness probe without a product session and without an OAuth service", async () => {
    const app = buildApp({
      pool: { query: async () => { throw new Error("database down"); }, end: async () => undefined } as never,
      redis: { ping: async () => { throw new Error("redis down"); }, quit: async () => "OK" } as never,
      // No session cookie is supplied and no session resolution is exercised: the
      // liveness probe must not participate in the authorization boundary.
      oauth: { getSession: async () => { throw new Error("oauth must not be consulted for liveness"); } } as never,
      agentTrace: null
    });

    const response = await app.inject({ method: "GET", url: "/health/live" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok", service: "api" });

    // The readiness probe also stays reachable without a session; it only reports
    // dependency health and is not gated on the authorization boundary.
    const ready = await app.inject({ method: "GET", url: "/health" });
    expect(ready.statusCode).toBe(500);
    await app.close();
  });

  it("never resolves a session cookie or invokes dependencies even while every dependency is healthy", async () => {
    const poolCalls: string[] = [];
    const redisCalls: string[] = [];
    let modelTouched = false;
    let oauthTouched = false;
    const app = buildApp({
      pool: { query: async (sql: string) => { poolCalls.push(sql); return { rows: [] }; }, end: async () => undefined } as never,
      redis: { ping: async () => { redisCalls.push("ping"); return "PONG"; }, quit: async () => "OK" } as never,
      oauth: { getSession: async () => { oauthTouched = true; return null; } } as never,
      agentModel: { respond: async () => { modelTouched = true; throw new Error("model must not run for liveness"); } } as never,
      memoryProvider: {
        add: async () => { modelTouched = true; throw new Error("memory must not run for liveness"); },
        search: async () => { modelTouched = true; throw new Error("memory must not run for liveness"); }
      } as never,
      agentTrace: null
    });

    // Presenting a valid-looking session cookie must not change the liveness
    // contract: the probe is dependency- and authorization-free.
    const response = await app.inject({
      method: "GET",
      url: "/health/live",
      headers: { cookie: "valorant_session=session-token" }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok", service: "api" });
    expect(poolCalls).toEqual([]);
    expect(redisCalls).toEqual([]);
    expect(oauthTouched).toBe(false);
    expect(modelTouched).toBe(false);

    // The readiness probe still performs its dependency checks when asked.
    const ready = await app.inject({ method: "GET", url: "/health" });
    expect(ready.statusCode).toBe(200);
    expect(poolCalls).toEqual(["SELECT 1"]);
    expect(redisCalls).toEqual(["ping"]);
    await app.close();
  });

  it("keeps the dependency readiness check failing with a non-200 status on a database fault", async () => {
    const app = buildApp({
      pool: { query: async () => { throw new Error("database down"); }, end: async () => undefined } as never,
      redis: { ping: async () => "PONG", quit: async () => "OK" } as never,
      agentTrace: null
    });

    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({ error: "internal" });
    await app.close();
  });

  it("keeps the readiness check failing with a non-200 status on a Redis fault", async () => {
    const app = buildApp({
      pool: { query: async () => ({ rows: [] }), end: async () => undefined } as never,
      redis: { ping: async () => { throw new Error("redis down"); }, quit: async () => "OK" } as never,
      agentTrace: null
    });

    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({ error: "internal" });
    await app.close();
  });

  it("keeps the readiness check reporting ok when database and redis respond", async () => {
    const app = buildApp({
      pool: { query: async () => ({ rows: [] }), end: async () => undefined } as never,
      redis: { ping: async () => "PONG", quit: async () => "OK" } as never,
      agentTrace: null
    });

    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok", service: "api", database: "ok", redis: "ok" });
    await app.close();
  });

  it("keeps protected routes rejecting unauthenticated requests while liveness stays open", async () => {
    const app = buildApp({
      pool: { query: async () => ({ rows: [] }), end: async () => undefined } as never,
      redis: { ping: async () => "PONG", quit: async () => "OK" } as never,
      oauth: { getSession: async () => null } as never,
      agentTrace: null
    });

    const live = await app.inject({ method: "GET", url: "/health/live" });
    expect(live.statusCode).toBe(200);

    // Adding the liveness probe must not loosen the existing authorization
    // boundary: unauthenticated protected requests are still rejected.
    for (const [method, url] of [
      ["GET", "/memory"],
      ["GET", "/matches"],
      ["GET", "/analytics/acts"],
      ["GET", "/benchmark"],
      ["GET", "/coach/sessions"],
      ["GET", "/auth/status"]
    ] as const) {
      const response = await app.inject({ method, url });
      if (url === "/auth/status") {
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ authenticated: false, connected: false });
      } else {
        expect(response.statusCode).toBe(401);
      }
    }
    await app.close();
  });
});
