import { describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import type { CoachMessage, CoachSession, CoachSessionService } from "./coach-session.js";

const expiresAt = new Date("2030-01-01T00:00:00.000Z");
const sessionId = "11111111-1111-4111-8111-111111111111";
const messageId = "22222222-2222-4222-8222-222222222222";
const inertDependencies = { pool: { end: async () => undefined } as never, redis: { quit: async () => "OK" } as never, agentTrace: null };

function makeCoachService() {
  const sessions: CoachSession[] = [];
  const service: CoachSessionService = {
    list: async () => sessions,
    get: async (_userId, id) => sessions.find((session) => session.id === id) ?? null,
    create: async (_userId, input) => {
      if (input.matchId === "foreign-match") return null;
      const timestamp = new Date("2030-01-01T00:00:00.000Z");
      const session: CoachSession = { id: sessionId, title: input.title ?? "新的复盘会话", ...(input.matchId ? { matchId: input.matchId } : {}), messages: [], createdAt: timestamp, updatedAt: timestamp };
      sessions.unshift(session);
      return session;
    },
    update: async (_userId, id, input) => {
      const session = sessions.find((item) => item.id === id);
      if (!session || input.matchId === "foreign-match") return null;
      Object.assign(session, input.matchId === null ? { matchId: undefined } : input, { updatedAt: new Date() });
      return session;
    },
    appendMessage: async (_userId, id, input) => {
      const session = sessions.find((item) => item.id === id);
      if (!session) return null;
      const message: CoachMessage = { id: messageId, ...input, createdAt: new Date("2030-01-01T00:00:00.000Z") };
      session.messages.push(message);
      return message;
    },
    delete: async (_userId, id) => {
      const index = sessions.findIndex((session) => session.id === id);
      if (index < 0) return false;
      sessions.splice(index, 1);
      return true;
    }
  };
  return service;
}

describe("Coach session routes", () => {
  it("requires the product session and persists bounded sessions and messages", async () => {
    const coachSessions = makeCoachService();
    const app = buildApp({
      ...inertDependencies,
      oauth: { getSession: async (token?: string) => token === "session-token" ? { userId: "user-1", token, expiresAt } : null } as never,
      coachSessions
    });

    expect((await app.inject({ method: "GET", url: "/coach/sessions" })).statusCode).toBe(401);
    const created = await app.inject({ method: "POST", url: "/coach/sessions", headers: { cookie: "valorant_session=session-token" }, payload: { title: "Ascent 复盘", matchId: "owned-match" } });
    const message = await app.inject({ method: "POST", url: `/coach/sessions/${sessionId}/messages`, headers: { cookie: "valorant_session=session-token" }, payload: { role: "user", content: "为什么首死？" } });
    const listed = await app.inject({ method: "GET", url: "/coach/sessions", headers: { cookie: "valorant_session=session-token" } });

    expect(created.statusCode).toBe(201);
    expect(created.json().session).toMatchObject({ id: sessionId, matchId: "owned-match" });
    expect(message.statusCode).toBe(201);
    expect(listed.json().sessions[0].messages).toHaveLength(1);
    await app.close();
  });

  it("rejects foreign match context, invalid session ids, and oversized messages", async () => {
    const app = buildApp({
      ...inertDependencies,
      oauth: { getSession: async (token?: string) => token === "session-token" ? { userId: "user-1", token, expiresAt } : null } as never,
      coachSessions: makeCoachService()
    });
    const foreign = await app.inject({ method: "POST", url: "/coach/sessions", headers: { cookie: "valorant_session=session-token" }, payload: { matchId: "foreign-match" } });
    const invalidId = await app.inject({ method: "GET", url: "/coach/sessions/not-a-uuid", headers: { cookie: "valorant_session=session-token" } });
    const oversized = await app.inject({ method: "POST", url: `/coach/sessions/${sessionId}/messages`, headers: { cookie: "valorant_session=session-token" }, payload: { role: "user", content: "x".repeat(4_001) } });

    expect(foreign.statusCode).toBe(404);
    expect(invalidId.statusCode).toBe(400);
    expect(oversized.statusCode).toBe(400);
    await app.close();
  });
});
