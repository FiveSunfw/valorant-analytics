import { describe, expect, it, vi } from "vitest";
import { RiotMatchApiError, RiotMatchClient } from "./riot-match-client.js";

const match = (matchId: string, options: { ranked?: boolean; completed?: boolean; queueId?: string } = {}) => ({
  matchInfo: {
    matchId,
    queueId: options.queueId ?? "competitive",
    isRanked: options.ranked ?? true,
    isCompleted: options.completed ?? true
  },
  players: [],
  roundResults: []
});

describe("RiotMatchClient", () => {
  it("uses the server-side key and filters match history to competitive entries", async () => {
    const fetch = vi.fn(async (input: string, init: RequestInit) => {
      expect(input).toBe("https://ap.api.riotgames.com/val/match/v1/matchlists/by-puuid/account-1");
      expect(new Headers(init.headers).get("X-Riot-Token")).toBe("server-only-key");
      return Response.json({ history: [{ matchId: "competitive-1", queueId: "competitive" }, { matchId: "unrated-1", queueId: "unrated" }] });
    });
    const client = new RiotMatchClient({ apiKey: "server-only-key", platform: "ap", fetch });

    await expect(client.getCompetitiveMatchIds("account-1")).resolves.toEqual(["competitive-1"]);
  });

  it("retries 429 using Retry-After, then returns a validated match", async () => {
    const sleep = vi.fn(async () => undefined);
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 429, headers: { "Retry-After": "0" } }))
      .mockResolvedValueOnce(Response.json(match("competitive-1")));
    const client = new RiotMatchClient({ apiKey: "key", platform: "ap", fetch, sleep, random: () => 0.5 });

    await expect(client.getMatch("competitive-1")).resolves.toEqual(match("competitive-1"));
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(0);
  });

  it("does not retry rejected requests", async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 401 }));
    const client = new RiotMatchClient({ apiKey: "key", platform: "ap", fetch });

    await expect(client.getMatch("private-match")).rejects.toMatchObject({ category: "rejected", statusCode: 401 } satisfies Partial<RiotMatchApiError>);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("continues after a single match-detail failure and applies the final competitive filter", async () => {
    const fetch = vi.fn(async (input: string) => {
      if (input.includes("matchlists")) return Response.json({ history: [
        { matchId: "kept", queueId: "competitive" },
        { matchId: "discarded", queueId: "competitive" },
        { matchId: "missing", queueId: "competitive" }
      ] });
      if (input.endsWith("/kept")) return Response.json(match("kept"));
      if (input.endsWith("/discarded")) return Response.json(match("discarded", { ranked: false }));
      return new Response(null, { status: 404 });
    });
    const client = new RiotMatchClient({ apiKey: "key", platform: "ap", fetch });

    await expect(client.getCompletedCompetitiveMatches("account-1")).resolves.toEqual({
      matches: [match("kept")],
      failedMatchIds: ["missing"]
    });
  });
});
