import { describe, expect, it } from "vitest";
import {
  agentEventSchema,
  analysisAnswerSchema,
  analysisSessionStateSchema,
  specialistFindingSchema,
  toolResultSchema
} from "./agent-contracts.js";

describe("agent contracts", () => {
  it("validates a persisted multi-turn session state", () => {
    const state = analysisSessionStateSchema.parse({
      sessionId: "session-1",
      userId: "user-1",
      activeQuestion: "Why am I losing recently?",
      dataScopes: [{ label: "recent matches", matchCount: 20 }],
      activeHypotheses: [],
      findings: [],
      evidenceIds: [],
      unresolvedQuestions: [],
      lastPromptId: "agent.supervisor.system",
      lastPromptVersion: "1.0.0"
    });
    expect(state.dataScopes[0].matchCount).toBe(20);
  });

  it("requires evidence for specialist claims", () => {
    expect(() => specialistFindingSchema.parse({
      specialist: "death",
      conclusion: "You die too early.",
      confidence: "medium",
      claims: [{ text: "You die too early." }],
      recommendations: [],
      limitations: []
    })).toThrow();
  });

  it("validates tool results and typed runtime events", () => {
    expect(toolResultSchema.parse({
      ok: true,
      data: { sampleSize: 20 },
      sampleSize: 20,
      evidenceIds: [],
      limitations: []
    }).ok).toBe(true);

    expect(agentEventSchema.parse({
      type: "clarification_request",
      runId: "run-1",
      question: "Which match period should I compare?"
    }).type).toBe("clarification_request");
  });

  it("keeps the final answer contract evidence-bound", () => {
    expect(analysisAnswerSchema.parse({
      conclusion: "Review opening duels.",
      playerEvidence: [{ claim: "First-death rate was elevated.", metricName: "first_death_rate" }],
      knowledgeEvidence: [],
      confidence: "low",
      recommendations: [],
      limitations: ["Small sample."],
      nextQuestions: []
    }).confidence).toBe("low");
  });
});
