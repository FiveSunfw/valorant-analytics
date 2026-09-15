import { describe, expect, it } from "vitest";
import { analysisAnswerSchema, createAnalyticsTools } from "./agent-tools.js";

describe("analysis tools", () => {
  it("keeps each query scoped to the authenticated internal user", async () => {
    const calls: unknown[][] = [];
    const reader = {
      getPlayerSummary: async (...args: unknown[]) => { calls.push(args); return { scope: { queue: "competitive" as const, sampleSize: 0 }, metrics: null }; },
      getMatchList: async (...args: unknown[]) => { calls.push(args); return { scope: { queue: "competitive" as const, sampleSize: 0 }, matches: [] }; },
      getMatchDetail: async (...args: unknown[]) => { calls.push(args); return { scope: { queue: "competitive" as const, sampleSize: 0 }, match: null }; },
      findRoundEvidence: async (...args: unknown[]) => { calls.push(args); return { scope: { queue: "competitive" as const, sampleSize: 0 }, evidence: [] }; },
      getRoundEvidence: async (...args: unknown[]) => { calls.push(args); return { scope: { queue: "competitive" as const, sampleSize: 0 }, evidence: [] }; }
    };
    const tools = createAnalyticsTools({ userId: "a28f4545-1443-4e7b-b456-1d1c1e65f9c0" }, reader);
    await tools[0].execute({});
    await tools[1].execute({ limit: 5 });
    await tools[2].execute({ matchId: "match-1" });
    await tools[3].execute({ eventType: "first_death", limit: 2 });
    await tools[4].execute({ matchId: "match-1", roundNumber: 1 });
    expect(calls).toEqual([
      ["a28f4545-1443-4e7b-b456-1d1c1e65f9c0"],
      ["a28f4545-1443-4e7b-b456-1d1c1e65f9c0", 5],
      ["a28f4545-1443-4e7b-b456-1d1c1e65f9c0", "match-1"],
      ["a28f4545-1443-4e7b-b456-1d1c1e65f9c0", "first_death", 2],
      ["a28f4545-1443-4e7b-b456-1d1c1e65f9c0", "match-1", 1]
    ]);
    expect(tools.map((tool) => tool.name).join(" ")).not.toContain("puuid");
  });

  it("requires every final claim to be traceable", () => {
    expect(() => analysisAnswerSchema.parse({
      conclusion: "Review the opening duels.", evidence: [{ claim: "Opening deaths were frequent." }],
      confidence: "low", recommendations: [], limitations: ["Small sample."]
    })).toThrow();
    expect(analysisAnswerSchema.parse({
      conclusion: "Review the opening duels.",
      playerEvidence: [{ claim: "Round one ended in a first death.", matchId: "match-1", roundNumber: 1 }],
      knowledgeEvidence: [],
      confidence: "low",
      recommendations: [{ action: "Review the round.", rationale: "It contains the cited first death." }],
      limitations: ["Small sample."],
      nextQuestions: []
    }).confidence).toBe("low");
  });
});
