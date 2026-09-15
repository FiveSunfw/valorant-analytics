import { describe, expect, it } from "vitest";
import { createAnalyticsTools } from "./agent-tools.js";
import { AgentRunError, DeterministicAnalysisModel, runAnalysis, type AgentModel, type AgentModelRequest } from "./agent-runtime.js";

const user = { userId: "user-1" };
const reader = {
  getPlayerSummary: async () => ({ scope: { queue: "competitive" as const, sampleSize: 5 }, metrics: { adr: 120, firstDeathRate: 20 } as any }),
  getMatchList: async () => ({ scope: { queue: "competitive" as const, sampleSize: 0 }, matches: [] }),
  getMatchDetail: async () => ({ scope: { queue: "competitive" as const, sampleSize: 0 }, match: null }),
  compareAttackDefense: async () => ({ scope: { queue: "competitive" as const, sampleSize: 0 }, attack: { roundsPlayed: 0, roundsWon: 0, winRate: 0 }, defense: { roundsPlayed: 0, roundsWon: 0, winRate: 0 } }),
  findRoundEvidence: async () => ({ scope: { queue: "competitive" as const, sampleSize: 0 }, evidence: [] }),
  getRoundEvidence: async () => ({ scope: { queue: "competitive" as const, sampleSize: 0 }, evidence: [] })
};

class ScriptedModel implements AgentModel {
  constructor(private readonly decisions: AgentModelRequest extends never ? never : any[]) {}
  async respond(): Promise<any> { return this.decisions.shift(); }
}

describe("minimal analysis agent", () => {
  it("runs a registered tool and returns an evidence-bound answer", async () => {
    const result = await runAnalysis({ user, question: "Why am I losing?", tools: createAnalyticsTools(user, reader), model: new ScriptedModel([
      { kind: "tool_call", toolName: "get_player_summary", input: {} },
      { kind: "final", answer: {
        conclusion: "Review opening duels.", playerEvidence: [{ claim: "ADR is 120.", metricName: "adr" }], knowledgeEvidence: [], confidence: "medium",
        recommendations: [], limitations: [], nextQuestions: []
      } }
    ]) });
    expect(result.toolCalls).toBe(1);
    expect(result.prompt.hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("finds concrete first-death rounds for an opening-death question", async () => {
    const result = await runAnalysis({ user, question: "我最近为什么总是先死？", tools: createAnalyticsTools(user, {
      ...reader,
      findRoundEvidence: async () => ({ scope: { queue: "competitive" as const, sampleSize: 1 }, evidence: [{ matchId: "match-1", roundNumber: 2, eventType: "first_death" as const, description: "First death" }] })
    }), model: new DeterministicAnalysisModel() });
    expect(result.toolCalls).toBe(2);
    expect(result.answer.playerEvidence).toContainEqual(expect.objectContaining({ matchId: "match-1", roundNumber: 2 }));
  });

  it("rejects an unregistered tool before execution", async () => {
    await expect(runAnalysis({ user, question: "Analyze my matches", tools: createAnalyticsTools(user, reader), model: new ScriptedModel([
      { kind: "tool_call", toolName: "read_all_players", input: {} }
    ]) })).rejects.toMatchObject({ code: "tool_not_allowed" } satisfies Partial<AgentRunError>);
  });

  it("refuses unsupported real-time or scouting requests without tools", async () => {
    const result = await runAnalysis({ user, question: "给我实时指挥", tools: [], model: new ScriptedModel([]) });
    expect(result.toolCalls).toBe(0);
    expect(result.answer.limitations[0]).toContain("real-time");
  });

  it("enforces the tool-call budget", async () => {
    await expect(runAnalysis({ user, question: "Analyze", tools: createAnalyticsTools(user, reader), maxToolCalls: 1, model: new ScriptedModel([
      { kind: "tool_call", toolName: "get_player_summary", input: {} },
      { kind: "tool_call", toolName: "get_match_list", input: { limit: 5 } }
    ]) })).rejects.toMatchObject({ code: "budget_exceeded" } satisfies Partial<AgentRunError>);
  });
});
