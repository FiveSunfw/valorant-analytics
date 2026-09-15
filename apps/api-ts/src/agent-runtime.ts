import { randomUUID } from "node:crypto";
import { z } from "zod";
import { analysisAnswerSchema, type AnalysisAnswer, type AuthenticatedUser } from "./agent-contracts.js";
import { createAnalyticsTools, type AnalyticsTool } from "./agent-tools.js";
import { promptRegistry } from "./agent/prompts/registry.js";

export type AgentModelRequest = {
  runId: string;
  userMessage: string;
  systemPrompt: string;
  tools: readonly { name: string; description: string; inputSchema: unknown }[];
  observations: readonly ToolObservation[];
};

export type AgentModelDecision =
  | { kind: "tool_call"; toolName: string; input: unknown }
  | { kind: "final"; answer: unknown }
  | { kind: "refusal"; reason: string; message: string };

export interface AgentModel {
  respond(request: AgentModelRequest): Promise<AgentModelDecision>;
}

export type ToolObservation = {
  toolName: string;
  input: unknown;
  result: unknown;
};

export type AgentRunResult = {
  runId: string;
  prompt: { id: string; version: string; hash: string };
  toolCalls: number;
  answer: AnalysisAnswer;
};

export class AgentRunError extends Error {
  constructor(readonly code: "invalid_input" | "tool_not_allowed" | "tool_failed" | "model_failed" | "budget_exceeded" | "invalid_output", message: string) {
    super(message);
    this.name = "AgentRunError";
  }
}

export type AgentRunOptions = {
  runId?: string;
  user: AuthenticatedUser;
  question: string;
  tools: readonly AnalyticsTool<any, any>[];
  model: AgentModel;
  maxSteps?: number;
  maxToolCalls?: number;
  toolTimeoutMs?: number;
};

function unsupportedQuestion(question: string): boolean {
  return /(实时指挥|实时对局|赛前侦察|对手信息|作弊|外挂|隐藏\s*(mmr|elo)|hidden\s*(mmr|elo))/i.test(question);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new AgentRunError("tool_failed", "Tool execution timed out")), timeoutMs); })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function runAnalysis(options: AgentRunOptions): Promise<AgentRunResult> {
  const question = options.question.trim();
  if (!question) throw new AgentRunError("invalid_input", "A question is required");
  const prompt = promptRegistry.get("agent.supervisor.system");
  if (unsupportedQuestion(question)) {
    return {
      runId: options.runId ?? randomUUID(), prompt, toolCalls: 0,
      answer: analysisAnswerSchema.parse({
        conclusion: "This analysis is outside the supported post-match scope.",
        playerEvidence: [], knowledgeEvidence: [], confidence: "high", recommendations: [],
        limitations: ["The product does not provide pre-match scouting, real-time instructions, cheat assistance, or hidden MMR/ELO claims."],
        nextQuestions: ["Ask about your own completed competitive matches instead."]
      })
    };
  }

  const runId = options.runId ?? randomUUID();
  const maxSteps = options.maxSteps ?? prompt.budget.maxSteps;
  const maxToolCalls = options.maxToolCalls ?? prompt.budget.maxToolCalls;
  const observations: ToolObservation[] = [];
  const tools = new Map(options.tools.map((tool) => [tool.name, tool]));
  let toolCalls = 0;

  for (let step = 0; step < maxSteps; step += 1) {
    let decision: AgentModelDecision;
    try {
      decision = await options.model.respond({
        runId, userMessage: question, systemPrompt: prompt.template,
        tools: options.tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })), observations
      });
    } catch (error) {
      throw new AgentRunError("model_failed", error instanceof Error ? error.message : "Model request failed");
    }
    if (decision.kind === "refusal") {
      return { runId, prompt, toolCalls, answer: analysisAnswerSchema.parse({
        conclusion: decision.message, playerEvidence: [], knowledgeEvidence: [], confidence: "high",
        recommendations: [], limitations: [decision.reason], nextQuestions: []
      }) };
    }
    if (decision.kind === "final") {
      const parsed = analysisAnswerSchema.safeParse(decision.answer);
      if (!parsed.success) throw new AgentRunError("invalid_output", "Model returned an invalid evidence-bound answer");
      return { runId, prompt, toolCalls, answer: parsed.data };
    }
    if (toolCalls >= maxToolCalls) throw new AgentRunError("budget_exceeded", "Tool-call budget exceeded");
    const tool = tools.get(decision.toolName);
    if (!tool) throw new AgentRunError("tool_not_allowed", `Tool is not registered: ${decision.toolName}`);
    const input = tool.inputSchema.safeParse(decision.input);
    if (!input.success) throw new AgentRunError("invalid_input", `Invalid input for tool ${tool.name}`);
    try {
      const result = await withTimeout(tool.execute(input.data), options.toolTimeoutMs ?? 5_000);
      observations.push({ toolName: tool.name, input: input.data, result });
      toolCalls += 1;
    } catch (error) {
      if (error instanceof AgentRunError) throw error;
      throw new AgentRunError("tool_failed", error instanceof Error ? error.message : `Tool ${tool.name} failed`);
    }
  }
  throw new AgentRunError("budget_exceeded", "Agent step budget exceeded");
}

export class DeterministicAnalysisModel implements AgentModel {
  async respond(request: AgentModelRequest): Promise<AgentModelDecision> {
    const summary = request.observations.find((observation) => observation.toolName === "get_player_summary");
    if (!summary) return { kind: "tool_call", toolName: "get_player_summary", input: {} };
    const data = summary.result as { scope?: { sampleSize?: number; limitation?: string }; metrics?: Record<string, number> | null };
    const metrics = data.metrics;
    if (!metrics) return { kind: "final", answer: {
      conclusion: "There is not enough completed competitive data to identify a stable trend yet.", playerEvidence: [], knowledgeEvidence: [], confidence: "low",
      recommendations: [{ action: "Play and sync more completed competitive matches", rationale: "The current data set has no usable player metrics." }],
      limitations: [data.scope?.limitation ?? "No completed competitive matches are available."], nextQuestions: ["Which recent match should we review after more data is synced?"]
    } };
    const firstDeathRate = metrics.firstDeathRate;
    const metricName = typeof firstDeathRate === "number" ? "first_death_rate" : "adr";
    const value = metrics[metricName === "first_death_rate" ? "firstDeathRate" : "adr"];
    return { kind: "final", answer: {
      conclusion: `Your recent competitive sample has ${metricName.replaceAll("_", " ")} at ${value}. Use this as a review signal, not a diagnosis.`,
      playerEvidence: [{ claim: `${metricName} is ${value}.`, metricName }], knowledgeEvidence: [], confidence: data.scope?.sampleSize && data.scope.sampleSize >= 5 ? "medium" : "low",
      recommendations: [{ action: "Review the rounds behind this metric", rationale: "A round-level review can separate repeatable patterns from a small-sample fluctuation." }],
      limitations: [data.scope?.limitation ?? "Metrics are limited to completed competitive matches."], nextQuestions: ["Would you like to inspect a specific round or compare recent matches?"]
    } };
  }
}

export function createDefaultAnalysis(options: Omit<AgentRunOptions, "tools" | "model"> & { reader: Parameters<typeof createAnalyticsTools>[1] }): Promise<AgentRunResult> {
  return runAnalysis({ ...options, tools: createAnalyticsTools(options.user, options.reader), model: new DeterministicAnalysisModel() });
}
