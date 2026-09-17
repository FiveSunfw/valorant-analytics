import { describe, expect, it } from "vitest";
import { runMultiAgentAnalysis, selectSpecialists } from "./multi-agent.js";
import type { AgentModel } from "./agent-runtime.js";

const user = { userId: "user-1" };
const reader = {
  getPlayerSummary: async () => ({ scope: { queue: "competitive" as const, sampleSize: 6 }, metrics: { adr: 135, firstDeathRate: 18 } as any }),
  getMatchList: async () => ({ scope: { queue: "competitive" as const, sampleSize: 0 }, matches: [] }),
  getMatchDetail: async () => ({ scope: { queue: "competitive" as const, sampleSize: 0 }, match: null }),
  compareAttackDefense: async () => ({ scope: { queue: "competitive" as const, sampleSize: 6 }, attack: { roundsPlayed: 30, roundsWon: 16, winRate: 53.33 }, defense: { roundsPlayed: 30, roundsWon: 14, winRate: 46.67 } }),
  compareMapPerformance: async () => ({ scope: { queue: "competitive" as const, sampleSize: 6 }, maps: [] }),
  compareRecentPeriods: async () => ({ scope: { queue: "competitive" as const, sampleSize: 6 }, matchesPerPeriod: 3, recent: null, previous: null, deltas: null }),
  findRoundEvidence: async () => ({ scope: { queue: "competitive" as const, sampleSize: 2 }, evidence: [{ matchId: "match-1", roundNumber: 4, eventType: "first_death" as const, description: "Recorded first death" }] }),
  getRoundEvidence: async () => ({ scope: { queue: "competitive" as const, sampleSize: 0 }, evidence: [] }),
  getMapRoundSummary: async () => ({ scope: { queue: "competitive" as const, sampleSize: 1 }, mapName: "Haven", matches: 1, rounds: [] }),
  getTrainingMemory: async () => ({ memories: [], limitation: "Memory is context, not evidence." }),
  getAgentPerformance: async () => ({ scope: { queue: "competitive" as const, sampleSize: 6 }, agents: [] }),
  getEconomyPerformance: async () => ({ scope: { queue: "competitive" as const, sampleSize: 6 }, categories: [] }),
  searchKnowledge: async (_userId: string, query: string) => ({ query, results: [], limitation: "Teaching is background only." })
};

const finalAnswer = {
  conclusion: "Use the returned metrics as review signals.", playerEvidence: [{ claim: "ADR is 135.", metricName: "adr" }], knowledgeEvidence: [], confidence: "medium" as const,
  recommendations: [{ action: "Practice disciplined opening-duel timing", rationale: "The answer remains bounded by the retrieved metrics." }], limitations: [], nextQuestions: []
};

class FinalModel implements AgentModel {
  async respond() { return { decision: { kind: "final" as const, answer: finalAnswer }, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } }; }
}

describe("internal multi-agent orchestration", () => {
  it("routes only the minimum relevant specialists and respects the expert cap", () => {
    expect(selectSpecialists("我在 Haven 防守教学和经济局应该怎么练？")).toEqual(["economy", "map"]);
    expect(selectSpecialists("我的首死、枪法和训练目标怎么一起改？", 2)).toEqual(["memory", "aim"]);
  });

  it("collects scoped specialist observations before Supervisor synthesis", async () => {
    const result = await runMultiAgentAnalysis({ user, question: "我为什么经常首死，枪法怎么改善？", reader: reader as never, model: new FinalModel(), maxTotalToolCalls: 5 });

    expect(result.orchestration).toMatchObject({ supervisor: "supervisor", selectedSpecialists: ["aim", "death"] });
    expect(result.specialists.map((item) => item.specialist)).toEqual(["aim", "death"]);
    expect(result.toolNames).toEqual(expect.arrayContaining(["get_player_summary", "get_agent_performance", "find_round_evidence"]));
    expect(result.toolCalls).toBe(3);
  });

  it("does not run specialist tools for unsupported real-time requests", async () => {
    const result = await runMultiAgentAnalysis({ user, question: "给我实时指挥", reader: reader as never, model: new FinalModel() });
    expect(result.orchestration.selectedSpecialists).toEqual([]);
    expect(result.toolCalls).toBe(0);
    expect(result.answer.limitations[0]).toContain("real-time");
  });
});
