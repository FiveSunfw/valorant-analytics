import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { z } from "zod";
import { TokenCipher } from "./token-crypto.js";

const STATE_TTL_MS = 10 * 60 * 1_000;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.number().int().positive().optional(),
  scope: z.string().optional()
}).passthrough();
const accountSchema = z.object({
  puuid: z.string().min(1),
  gameName: z.string().optional(),
  tagLine: z.string().optional()
}).passthrough();
const userinfoSchema = z.object({ sub: z.string().min(1) }).passthrough();

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

export type RiotOAuthSettings = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  authorizeUrl: string;
  tokenUrl: string;
  userinfoUrl: string;
  accountRegion: string;
  platform: string;
  scopes: string;
  encryptionKey: string;
};

export type ProductSession = { userId: string; token: string; expiresAt: Date };
type OAuthState = { userId: string; codeVerifier: string };
export type AuthorizedAccount = {
  userId: string;
  rsoSubject: string;
  puuid: string;
  gameName?: string;
  tagLine?: string;
  platform: string;
  encryptedAccessToken: Buffer;
  encryptedRefreshToken?: Buffer;
  accessTokenExpiresAt?: Date;
  scopes: string[];
};

export interface RiotOAuthStore {
  findSession(token: string): Promise<ProductSession | null>;
  createSession(): Promise<ProductSession>;
  createState(stateHash: string, state: OAuthState, expiresAt: Date): Promise<void>;
  consumeState(stateHash: string): Promise<OAuthState | null>;
  saveAuthorizedAccount(account: AuthorizedAccount): Promise<void>;
  disconnectUser(userId: string): Promise<void>;
}

export class RiotOAuthError extends Error {
  constructor(readonly kind: "configuration" | "invalid_state" | "authorization" | "upstream" | "invalid_response", readonly statusCode: number, message: string) {
    super(message);
    this.name = "RiotOAuthError";
  }
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function base64Url(bytes: number): string {
  return randomBytes(bytes).toString("base64url");
}

function requireSetting(value: string, name: string): string {
  if (!value) throw new RiotOAuthError("configuration", 503, `${name} is not configured`);
  return value;
}

function parseScopes(value: string): string[] {
  return value.split(/\s+/).map((scope) => scope.trim()).filter(Boolean);
}

export class RiotOAuthService {
  constructor(
    private readonly settings: RiotOAuthSettings,
    private readonly store: RiotOAuthStore,
    private readonly fetcher: Fetcher = fetch,
    private readonly now: () => Date = () => new Date()
  ) {}

  async getOrCreateSession(sessionToken?: string): Promise<{ session: ProductSession; created: boolean }> {
    if (sessionToken) {
      const session = await this.store.findSession(sessionToken);
      if (session) return { session, created: false };
    }
    return { session: await this.store.createSession(), created: true };
  }

  async getSession(sessionToken?: string): Promise<ProductSession | null> {
    return sessionToken ? this.store.findSession(sessionToken) : null;
  }

  async begin(userId: string): Promise<string> {
    const authorizeUrl = requireSetting(this.settings.authorizeUrl, "RIOT_RSO_AUTHORIZE_URL");
    const clientId = requireSetting(this.settings.clientId, "RIOT_CLIENT_ID");
    const redirectUri = requireSetting(this.settings.redirectUri, "RIOT_REDIRECT_URI");
    requireSetting(this.settings.tokenUrl, "RIOT_RSO_TOKEN_URL");
    requireSetting(this.settings.userinfoUrl, "RIOT_RSO_USERINFO_URL");
    requireSetting(this.settings.clientSecret, "RIOT_CLIENT_SECRET");
    requireSetting(this.settings.accountRegion, "RIOT_ACCOUNT_REGION");
    requireSetting(this.settings.platform, "RIOT_PLATFORM");
    if (parseScopes(this.settings.scopes).length === 0) throw new RiotOAuthError("configuration", 503, "RIOT_RSO_SCOPES is not configured");
    try {
      TokenCipher.fromBase64(requireSetting(this.settings.encryptionKey, "TOKEN_ENCRYPTION_KEY"));
    } catch {
      throw new RiotOAuthError("configuration", 503, "TOKEN_ENCRYPTION_KEY is invalid");
    }
    const state = base64Url(32);
    const codeVerifier = base64Url(48);
    const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
    await this.store.createState(hash(state), { userId, codeVerifier }, new Date(this.now().getTime() + STATE_TTL_MS));

    let url: URL;
    try {
      url = new URL(authorizeUrl);
    } catch {
      throw new RiotOAuthError("configuration", 503, "RIOT_RSO_AUTHORIZE_URL must be an absolute URL");
    }
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("scope", parseScopes(this.settings.scopes).join(" "));
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
    return url.toString();
  }

  async complete(callback: { state?: string; code?: string; error?: string }, expectedUserId?: string): Promise<{ userId: string; puuid: string }> {
    if (!callback.state) throw new RiotOAuthError("invalid_state", 400, "Missing OAuth state");
    const state = await this.store.consumeState(hash(callback.state));
    if (!state) throw new RiotOAuthError("invalid_state", 400, "OAuth state is invalid or expired");
    if (expectedUserId && state.userId !== expectedUserId) throw new RiotOAuthError("invalid_state", 401, "OAuth session does not match authorization state");
    if (callback.error) throw new RiotOAuthError("authorization", 401, "Riot authorization was not granted");
    if (!callback.code) throw new RiotOAuthError("authorization", 400, "Missing authorization code");

    const tokenUrl = requireSetting(this.settings.tokenUrl, "RIOT_RSO_TOKEN_URL");
    const userinfoUrl = requireSetting(this.settings.userinfoUrl, "RIOT_RSO_USERINFO_URL");
    const clientId = requireSetting(this.settings.clientId, "RIOT_CLIENT_ID");
    const clientSecret = requireSetting(this.settings.clientSecret, "RIOT_CLIENT_SECRET");
    const redirectUri = requireSetting(this.settings.redirectUri, "RIOT_REDIRECT_URI");
    const cipher = TokenCipher.fromBase64(requireSetting(this.settings.encryptionKey, "TOKEN_ENCRYPTION_KEY"));

    const form = new URLSearchParams({
      grant_type: "authorization_code",
      code: callback.code,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: state.codeVerifier
    });
    const basicAuth = Buffer.from(`${clientId}:${clientSecret}`, "utf8").toString("base64");
    const token = tokenResponseSchema.parse(await this.fetchJson(tokenUrl, {
      method: "POST",
      headers: { Authorization: `Basic ${basicAuth}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString()
    }));
    const bearerHeaders = { Authorization: `Bearer ${token.access_token}` };
    const userinfo = userinfoSchema.parse(await this.fetchJson(userinfoUrl, { headers: bearerHeaders }));
    const accountUrl = `https://${requireSetting(this.settings.accountRegion, "RIOT_ACCOUNT_REGION")}.api.riotgames.com/riot/account/v1/accounts/me`;
    const account = accountSchema.parse(await this.fetchJson(accountUrl, { headers: bearerHeaders }));
    const expiresAt = token.expires_in ? new Date(this.now().getTime() + token.expires_in * 1_000) : undefined;

    await this.store.saveAuthorizedAccount({
      userId: state.userId,
      rsoSubject: userinfo.sub,
      puuid: account.puuid,
      gameName: account.gameName,
      tagLine: account.tagLine,
      platform: requireSetting(this.settings.platform, "RIOT_PLATFORM"),
      encryptedAccessToken: cipher.encrypt(token.access_token),
      encryptedRefreshToken: token.refresh_token ? cipher.encrypt(token.refresh_token) : undefined,
      accessTokenExpiresAt: expiresAt,
      scopes: token.scope ? parseScopes(token.scope) : parseScopes(this.settings.scopes)
    });
    return { userId: state.userId, puuid: account.puuid };
  }

  async disconnect(userId: string): Promise<void> {
    await this.store.disconnectUser(userId);
  }

  private async fetchJson(url: string, init: RequestInit): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetcher(url, init);
    } catch {
      throw new RiotOAuthError("upstream", 502, "Riot OAuth request failed");
    }
    if (!response.ok) throw new RiotOAuthError("upstream", 502, "Riot OAuth request was rejected");
    try {
      return await response.json();
    } catch {
      throw new RiotOAuthError("invalid_response", 502, "Riot OAuth returned invalid JSON");
    }
  }
}

export class PostgresRiotOAuthStore implements RiotOAuthStore {
  constructor(private readonly pool: Pool, private readonly now: () => Date = () => new Date()) {}

  async findSession(token: string): Promise<ProductSession | null> {
    const result = await this.pool.query<{ user_id: string; expires_at: Date }>(
      "SELECT user_id, expires_at FROM user_sessions WHERE token_hash = $1 AND expires_at > now()",
      [hash(token)]
    );
    const row = result.rows[0];
    return row ? { userId: row.user_id, token, expiresAt: row.expires_at } : null;
  }

  async createSession(): Promise<ProductSession> {
    const userId = randomUUID();
    const token = base64Url(32);
    const expiresAt = new Date(this.now().getTime() + SESSION_TTL_MS);
    await this.pool.query("INSERT INTO users (id) VALUES ($1)", [userId]);
    await this.pool.query("INSERT INTO user_sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)", [hash(token), userId, expiresAt]);
    return { userId, token, expiresAt };
  }

  async createSessionForUser(userId: string): Promise<ProductSession | null> {
    const account = await this.pool.query("SELECT 1 FROM riot_accounts WHERE user_id = $1", [userId]);
    if (account.rowCount === 0) return null;
    const token = base64Url(32);
    const expiresAt = new Date(this.now().getTime() + SESSION_TTL_MS);
    await this.pool.query("INSERT INTO user_sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)", [hash(token), userId, expiresAt]);
    return { userId, token, expiresAt };
  }

  async createState(stateHash: string, state: OAuthState, expiresAt: Date): Promise<void> {
    await this.pool.query("INSERT INTO riot_oauth_states (state_hash, code_verifier, user_id, expires_at) VALUES ($1, $2, $3, $4)", [stateHash, state.codeVerifier, state.userId, expiresAt]);
  }

  async consumeState(stateHash: string): Promise<OAuthState | null> {
    const result = await this.pool.query<{ user_id: string | null; code_verifier: string }>(
      "DELETE FROM riot_oauth_states WHERE state_hash = $1 AND expires_at > now() RETURNING user_id, code_verifier",
      [stateHash]
    );
    const row = result.rows[0];
    return row?.user_id ? { userId: row.user_id, codeVerifier: row.code_verifier } : null;
  }

  async saveAuthorizedAccount(account: AuthorizedAccount): Promise<void> {
    const riotAccountId = randomUUID();
    const saved = await this.pool.query<{ id: string }>(
      `INSERT INTO riot_accounts (id, user_id, rso_subject, puuid, game_name, tag_line, platform)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (rso_subject) DO UPDATE SET user_id = EXCLUDED.user_id, puuid = EXCLUDED.puuid,
         game_name = EXCLUDED.game_name, tag_line = EXCLUDED.tag_line, platform = EXCLUDED.platform, updated_at = now()
       RETURNING id`,
      [riotAccountId, account.userId, account.rsoSubject, account.puuid, account.gameName ?? null, account.tagLine ?? null, account.platform]
    );
    const accountId = saved.rows[0]?.id;
    if (!accountId) throw new RiotOAuthError("upstream", 500, "Riot account could not be saved");
    await this.pool.query(
      `INSERT INTO riot_tokens (id, riot_account_id, encrypted_access_token, encrypted_refresh_token, access_token_expires_at, scopes)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)
       ON CONFLICT (riot_account_id) DO UPDATE SET encrypted_access_token = EXCLUDED.encrypted_access_token,
         encrypted_refresh_token = EXCLUDED.encrypted_refresh_token, access_token_expires_at = EXCLUDED.access_token_expires_at,
         scopes = EXCLUDED.scopes, updated_at = now()`,
      [randomUUID(), accountId, account.encryptedAccessToken, account.encryptedRefreshToken ?? null, account.accessTokenExpiresAt ?? null, JSON.stringify(account.scopes)]
    );
  }

  async disconnectUser(userId: string): Promise<void> {
    await this.pool.query("DELETE FROM riot_accounts WHERE user_id = $1", [userId]);
  }
}
