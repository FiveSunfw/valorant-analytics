import { z } from "zod";
import { COMPETITIVE_QUEUE_ID, isCompletedCompetitiveMatch, rawMatchSchema, type RawMatch } from "@valorant/domain";
import { riotApiKey, riotPlatform } from "./config.js";

const matchHistoryEntrySchema = z.object({
    matchId: z.string().min(1),
    queueId: z.string().optional()
});
const matchHistorySchema = z.union([
  z.array(matchHistoryEntrySchema),
  z.object({ history: z.array(matchHistoryEntrySchema).default([]) })
]);

export type RiotErrorCategory = "configuration" | "network" | "rate-limit" | "upstream" | "rejected" | "invalid-response";

export class RiotMatchApiError extends Error {
  constructor(
    readonly category: RiotErrorCategory,
    readonly statusCode: number,
    message: string
  ) {
    super(message);
    this.name = "RiotMatchApiError";
  }
}

type Fetcher = (input: string, init: RequestInit) => Promise<Response>;
type Sleep = (milliseconds: number) => Promise<void>;

export type RiotMatchClientOptions = {
  apiKey: string;
  platform: string;
  maxAttempts?: number;
  fetch?: Fetcher;
  sleep?: Sleep;
  random?: () => number;
};

export type CompetitiveMatchFetch = {
  matches: RawMatch[];
  failedMatchIds: string[];
};
type MatchHistory = { history: Array<{ matchId: string; queueId?: string }> };

export class RiotMatchClient {
  private readonly baseUrl: string;
  private readonly maxAttempts: number;
  private readonly fetcher: Fetcher;
  private readonly sleep: Sleep;
  private readonly random: () => number;

  constructor(private readonly options: RiotMatchClientOptions) {
    if (!options.apiKey) throw new RiotMatchApiError("configuration", 500, "RIOT_API_KEY is required for Riot Match API calls");
    if (!options.platform) throw new RiotMatchApiError("configuration", 500, "RIOT_PLATFORM is required for Riot Match API calls");
    this.maxAttempts = options.maxAttempts ?? 3;
    if (this.maxAttempts < 1) throw new RiotMatchApiError("configuration", 500, "maxAttempts must be at least 1");
    this.baseUrl = `https://${options.platform.toLowerCase()}.api.riotgames.com`;
    this.fetcher = options.fetch ?? ((input, init) => fetch(input, init));
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.random = options.random ?? Math.random;
  }

  static fromEnvironment(): RiotMatchClient {
    return new RiotMatchClient({ apiKey: riotApiKey, platform: riotPlatform });
  }

  async getMatchHistory(puuid: string): Promise<MatchHistory> {
    const payload = await this.getJson(`/val/match/v1/matchlists/by-puuid/${encodeURIComponent(puuid)}`);
    const parsed = matchHistorySchema.safeParse(payload);
    if (!parsed.success) throw new RiotMatchApiError("invalid-response", 502, "Riot Match API returned an invalid match history");
    return { history: Array.isArray(parsed.data) ? parsed.data : parsed.data.history };
  }

  async getMatch(matchId: string): Promise<RawMatch> {
    const payload = await this.getJson(`/val/match/v1/matches/${encodeURIComponent(matchId)}`);
    const parsed = rawMatchSchema.safeParse(payload);
    if (!parsed.success) throw new RiotMatchApiError("invalid-response", 502, "Riot Match API returned an invalid match payload");
    return {
      ...parsed.data,
      players: parsed.data.players ?? [],
      roundResults: parsed.data.roundResults ?? []
    } as RawMatch;
  }

  async getCompetitiveMatchIds(puuid: string): Promise<string[]> {
    const history = await this.getMatchHistory(puuid);
    return history.history
      .filter((entry) => entry.queueId === COMPETITIVE_QUEUE_ID)
      .map((entry) => entry.matchId);
  }

  async getCompletedCompetitiveMatches(puuid: string): Promise<CompetitiveMatchFetch> {
    const matches: RawMatch[] = [];
    const failedMatchIds: string[] = [];
    for (const matchId of await this.getCompetitiveMatchIds(puuid)) {
      try {
        const match = await this.getMatch(matchId);
        if (isCompletedCompetitiveMatch(match)) matches.push(match);
      } catch (error) {
        if (error instanceof RiotMatchApiError) {
          failedMatchIds.push(matchId);
          continue;
        }
        throw error;
      }
    }
    return { matches, failedMatchIds };
  }

  private async getJson(path: string): Promise<unknown> {
    for (let attempt = 0; attempt < this.maxAttempts; attempt += 1) {
      let response: Response;
      try {
        response = await this.fetcher(`${this.baseUrl}${path}`, { headers: { "X-Riot-Token": this.options.apiKey } });
      } catch {
        if (attempt + 1 === this.maxAttempts) throw new RiotMatchApiError("network", 502, "Riot Match API request failed");
        await this.backoff(attempt);
        continue;
      }

      if (response.status === 429) {
        if (attempt + 1 === this.maxAttempts) throw new RiotMatchApiError("rate-limit", 429, "Riot Match API rate limit exhausted");
        await this.backoff(attempt, response.headers.get("Retry-After"));
        continue;
      }
      if (response.status >= 500) {
        if (attempt + 1 === this.maxAttempts) throw new RiotMatchApiError("upstream", response.status, "Riot Match API server error");
        await this.backoff(attempt);
        continue;
      }
      if (response.status === 401 || response.status === 403 || response.status === 404) {
        throw new RiotMatchApiError("rejected", response.status, "Riot Match API rejected the request");
      }
      if (!response.ok) throw new RiotMatchApiError("upstream", response.status, "Riot Match API returned an unexpected error");
      try {
        return await response.json();
      } catch {
        throw new RiotMatchApiError("invalid-response", 502, "Riot Match API returned invalid JSON");
      }
    }
    throw new RiotMatchApiError("upstream", 502, "Riot Match API request exhausted unexpectedly");
  }

  private async backoff(attempt: number, retryAfter: string | null = null): Promise<void> {
    const retryAfterSeconds = retryAfter === null ? Number.NaN : Number(retryAfter);
    const baseMilliseconds = Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0
      ? retryAfterSeconds * 1_000
      : 500 * 2 ** attempt;
    await this.sleep(Math.round(baseMilliseconds * (0.5 + this.random())));
  }
}
