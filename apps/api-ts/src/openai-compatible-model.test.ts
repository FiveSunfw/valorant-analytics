import { describe, expect, it, vi } from "vitest";
import { OpenAICompatibleAgentModel } from "./openai-compatible-model.js";

describe("OpenAI-compatible analysis model", () => {
  it("maps model tool calls and structured final answers into agent decisions", async () => {
    const create = vi.fn()
      .mockResolvedValueOnce({ choices: [{ message: { content: null, tool_calls: [{ type: "function", function: { name: "get_player_summary", arguments: "{}" } }] } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify({
        conclusion: "Review opening duels.",
        playerEvidence: [{ claim: "First-death rate is 20%.", metricName: "first_death_rate" }],
        knowledgeEvidence: [],
        confidence: "medium",
        recommendations: [],
        limitations: [],
        nextQuestions: []
      }), tool_calls: [] } }] });
    const model = new OpenAICompatibleAgentModel(
      { apiKey: "test", baseURL: "https://model.example.test/v1", model: "test-model" },
      { chat: { completions: { create } } } as never
    );
    const request = {
      runId: "run-1",
      userMessage: "分析最近表现",
      systemPrompt: "Use evidence.",
      tools: [{ name: "get_player_summary", description: "Summary", inputSchema: { type: "object", properties: {} } }],
      observations: []
    };

    await expect(model.respond(request)).resolves.toEqual({ kind: "tool_call", toolName: "get_player_summary", input: {} });
    await expect(model.respond({ ...request, observations: [{ toolName: "get_player_summary", input: {}, result: { metrics: { firstDeathRate: 20 } } }] })).resolves.toMatchObject({ kind: "final", answer: { confidence: "medium" } });
  });
});
