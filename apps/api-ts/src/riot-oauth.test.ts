import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { RiotOAuthService, type AuthorizedAccount, type ProductSession, type RiotOAuthStore } from "./riot-oauth.js";

class MemoryStore implements RiotOAuthStore {
  sessions = new Map<string, ProductSession>();
  states = new Map<string, { userId: string; codeVerifier: string }>();
  saved: AuthorizedAccount[] = [];
  disconnected: string[] = [];

  async findSession(token: string) { return this.sessions.get(token) ?? null; }
  async createSession() {
    const session = { userId: "user-1", token: "product-session", expiresAt: new Date("2030-01-01T00:00:00.000Z") };
    this.sessions.set(session.token, session);
    return session;
  }
  async createState(stateHash: string, state: { userId: string; codeVerifier: string }) { this.states.set(stateHash, state); }
  async consumeState(stateHash: string) {
    const state = this.states.get(stateHash) ?? null;
    this.states.delete(stateHash);
    return state;
  }
  async saveAuthorizedAccount(account: AuthorizedAccount) { this.saved.push(account); }
  async disconnectUser(userId: string) { this.disconnected.push(userId); }
}

const settings = {
  clientId: "client-id", clientSecret: "client-secret", redirectUri: "http://localhost:8000/auth/riot/callback",
  authorizeUrl: "https://rso.example.test/authorize", tokenUrl: "https://rso.example.test/token", userinfoUrl: "https://rso.example.test/userinfo",
  accountRegion: "asia", platform: "ap", scopes: "openid offline_access", encryptionKey: randomBytes(32).toString("base64")
};

describe("RiotOAuthService", () => {
  it("uses PKCE, consumes state once, and encrypts server-side tokens", async () => {
    const store = new MemoryStore();
    const requests: { url: string; init?: RequestInit }[] = [];
    const service = new RiotOAuthService(settings, store, async (url, init) => {
      requests.push({ url, init });
      if (url.endsWith("/token")) return Response.json({ access_token: "access-token", refresh_token: "refresh-token", expires_in: 3600, scope: "openid" });
      if (url.endsWith("/userinfo")) return Response.json({ sub: "rso-user" });
      return Response.json({ puuid: "player-puuid", gameName: "Player", tagLine: "APAC" });
    }, () => new Date("2026-09-06T00:00:00.000Z"));

    const authorizationUrl = new URL(await service.begin("user-1"));
    expect(authorizationUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorizationUrl.searchParams.get("state")).toBeTruthy();
    const state = authorizationUrl.searchParams.get("state")!;
    await expect(service.complete({ state, code: "authorization-code" }, "user-1")).resolves.toEqual({ userId: "user-1", puuid: "player-puuid" });
    await expect(service.complete({ state, code: "authorization-code" }, "user-1")).rejects.toMatchObject({ kind: "invalid_state" });
    expect(requests[0]?.init?.headers).toMatchObject({ "Content-Type": "application/x-www-form-urlencoded" });
    expect(String(requests[0]?.init?.body)).toContain("code_verifier=");
    expect(store.saved).toHaveLength(1);
    expect(store.saved[0]?.encryptedAccessToken.toString("utf8")).not.toContain("access-token");
    expect(store.saved[0]?.encryptedRefreshToken?.toString("utf8")).not.toContain("refresh-token");
  });

  it("rejects a callback that is not bound to the initiating product session", async () => {
    const store = new MemoryStore();
    const service = new RiotOAuthService(settings, store);
    const state = new URL(await service.begin("user-1")).searchParams.get("state")!;
    await expect(service.complete({ state, code: "authorization-code" }, "user-2")).rejects.toMatchObject({ kind: "invalid_state", statusCode: 401 });
  });

  it("fails before persisting state when RSO configuration is incomplete", async () => {
    const store = new MemoryStore();
    const service = new RiotOAuthService({ ...settings, tokenUrl: "" }, store);
    await expect(service.begin("user-1")).rejects.toMatchObject({ kind: "configuration" });
    expect(store.states.size).toBe(0);
  });
});
