import { randomUUID } from "node:crypto";
import { z } from "zod";
import { analysisAnswerSchema, type AnalysisAnswer, type AuthenticatedUser } from "./agent-contracts.js";
import { createAnalyticsTools, type AnalyticsTool } from "./agent-tools.js";
import { promptRegistry } from "./agent/prompts/registry.js";
import type { AgentTraceSink } from "./agent-trace.js";

export type AgentModelRequest = {
  runId: string;
  userMessage: string;
  systemPrompt: string;
  tools: readonly { name: string; description: string; inputSchema: unknown }[];
  observations: readonly ToolObservation[];
  conversation?: readonly AgentConversationMessage[];
};

export type AgentConversationMessage = {
  role: "user" | "assistant";
  content: string;
};

export type AgentModelDecision =
  | { kind: "tool_call"; toolName: string; input: unknown }
  | { kind: "final"; answer: unknown }
  | { kind: "refusal"; reason: string; message: string };

export type ModelUsage = { inputTokens: number; outputTokens: number; totalTokens: number };
export type AgentModelResponse = { decision: AgentModelDecision; usage: ModelUsage };

export interface AgentModel {
  readonly provider?: string;
  respond(request: AgentModelRequest): Promise<AgentModelResponse>;
}

export type ToolObservation = {
  toolName: string;
  input: unknown;
  result: unknown;
  specialist?: string;
};

export type AgentRunResult = {
  runId: string;
  prompt: { id: string; version: string; hash: string };
  toolCalls: number;
  toolNames: string[];
  answer: AnalysisAnswer;
  usage: ModelUsage & { estimatedCostUsd: number | null };
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
  initialObservations?: readonly ToolObservation[];
  conversation?: readonly AgentConversationMessage[];
  traceSink?: AgentTraceSink | null;
  usageRates?: { inputUsdPerMillion?: number; outputUsdPerMillion?: number };
};

const restrictedRequestPatterns: readonly RegExp[] = [
  /实时指挥|实时对局|赛前侦察|对手信息|其他玩家|另一个用户|所有用户|他人.*puuid|作弊|外挂/i,
  /api[_\s-]?key|access[_\s-]?token|refresh[_\s-]?token|authorization|bearer\s+token|\b(password|secret)\b|\.env\b|环境变量/i,
  /隐藏\s*(mmr|elo)|hidden\s*(mmr|elo)/i,
  /(?:ignore|disregard|override|bypass|reveal|show).{0,80}(?:previous|system|developer|instruction|prompt|message)/i,
  /(?:忽略|无视|绕过|覆盖|泄露|展示).{0,40}(?:之前|上面|系统|开发者|指令|提示词|消息)/i,
  /(?:system|developer|hidden)\s*(?:prompt|instruction|message)|(?:系统|开发者|隐藏).{0,10}(?:提示词|指令|消息)/i,
  /(?:decode|解码).{0,80}(?:instruction|prompt|提示词|指令)/i,
  /(?:chain\s*of\s*thought|reasoning trace|思维链|推理过程)/i,
  /(?:act as|roleplay|pretend|你现在是|扮演).{0,80}(?:system|developer|管理员|系统|开发者|管理员)/i,
  /(?:导出|读取|展示|泄露|dump|export|read|show).{0,40}(?:数据库|db|sql|table|记录|records|配置|config|日志|logs)/i,
  /\b(?:select|insert|update|delete|drop)\b.{0,80}\b(?:from|into|table)\b/i,
  /\b(?:puuid|riot\s*id)\b/i,
  /(?:call|invoke|执行|调用)\s*(?:get_|search_|compare_|find_)[a-z_]+/i
];

export function unsupportedQuestion(question: string): boolean {
  return restrictedRequestPatterns.some((pattern) => pattern.test(question));
}

type RequiredContext = { toolName: "get_match_detail" | "get_rank_benchmark" | "get_training_memory" | "get_act_performance" | "get_agent_performance" | "get_economy_performance" | "get_time_window" | "search_knowledge"; input: unknown };

function requiredContextTool(question: string, observations: readonly ToolObservation[]): RequiredContext | null {
  const scopedMatch = question.match(/\[Product scope: analyze only competitive match ([^\]]+)\]/);
  if (scopedMatch && !observations.some((observation) => observation.toolName === "get_match_detail")) return { toolName: "get_match_detail", input: { matchId: scopedMatch[1] } };
  if (/(同段位|基准|benchmark|中位数)/i.test(question) && !observations.some((observation) => observation.toolName === "get_rank_benchmark")) return { toolName: "get_rank_benchmark", input: {} };
  if (/(训练目标|训练计划|记住|长期记忆|上次分析|我的目标|memory)/i.test(question) && !observations.some((observation) => observation.toolName === "get_training_memory")) return { toolName: "get_training_memory", input: { query: question.slice(0, 200) } };
  if (/(跨\s*Act|段位趋势|赛季表现|act performance)/i.test(question) && !observations.some((observation) => observation.toolName === "get_act_performance")) return { toolName: "get_act_performance", input: {} };
  if (/(英雄维度|英雄表现|agent performance|different agents)/i.test(question) && !observations.some((observation) => observation.toolName === "get_agent_performance")) return { toolName: "get_agent_performance", input: {} };
  if (/(经济局|经济表现|economy|full buy|半起)/i.test(question) && !observations.some((observation) => observation.toolName === "get_economy_performance")) return { toolName: "get_economy_performance", input: {} };
  if (/(时间窗口|时间范围|from .* to |time window)/i.test(question) && !observations.some((observation) => observation.toolName === "get_time_window")) {
    const dates = question.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z/g);
    if (dates?.length && dates.length >= 2) return { toolName: "get_time_window", input: { from: dates[0], to: dates[1] } };
  }
  if (/(教学|架枪|点位|爆弹|战术执行|进攻思路|防守思路|teach|setup|lineup)/i.test(question) && !observations.some((observation) => observation.toolName === "search_knowledge")) {
    return { toolName: "search_knowledge", input: { query: question, ...(/(Haven|隐士修所)/i.test(question) ? { mapName: "Haven" } : {}), ...(/防守|defense/i.test(question) ? { side: "defense" } : /进攻|attack/i.test(question) ? { side: "attack" } : {}) } };
  }
  return null;
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
  const sharedPolicy = promptRegistry.get("agent.shared.policy");
  const runId = options.runId ?? randomUUID();
  const startedAt = Date.now();
  const observations: ToolObservation[] = [...(options.initialObservations ?? [])];
  let toolCalls = observations.length;
  let steps = 0;
  const usage: ModelUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  const estimatedCostUsd = options.usageRates?.inputUsdPerMillion === undefined || options.usageRates?.outputUsdPerMillion === undefined ? null : 0;
  const complete = async (answer: AnalysisAnswer): Promise<AgentRunResult> => {
    const finalUsage = { ...usage, estimatedCostUsd: estimatedCostUsd === null ? null : (usage.inputTokens * options.usageRates!.inputUsdPerMillion! + usage.outputTokens * options.usageRates!.outputUsdPerMillion!) / 1_000_000 };
    const result = { runId, prompt, toolCalls, toolNames: observations.map((observation) => observation.toolName), answer, usage: finalUsage };
    await options.traceSink?.save({
      runId,
      userId: options.user.userId,
      question,
      prompt,
      modelProvider: options.model.provider ?? "unknown",
      toolCalls: observations,
      answer,
      status: "completed",
      latencyMs: Date.now() - startedAt, steps, usage: finalUsage
    });
    return result;
  };
  if (unsupportedQuestion(question)) {
    return complete(analysisAnswerSchema.parse({
        conclusion: "This analysis is outside the supported post-match scope.",
        playerEvidence: [], knowledgeEvidence: [], confidence: "high", recommendations: [],
        limitations: ["The request asks for protected instructions, secrets, private data, prohibited gameplay assistance such as real-time instruction, or direct internal-tool control."],
        nextQuestions: ["Ask about your own completed competitive matches instead."]
      }));
  }

  const maxSteps = options.maxSteps ?? prompt.budget.maxSteps;
  const maxToolCalls = options.maxToolCalls ?? prompt.budget.maxToolCalls;
  const tools = new Map(options.tools.map((tool) => [tool.name, tool]));

  try { for (let step = 0; step < maxSteps; step += 1) {
    let response: AgentModelResponse;
    try {
      response = await options.model.respond({
        runId, userMessage: question, systemPrompt: `${sharedPolicy.template}\n${prompt.template}`,
        tools: options.tools.map(({ name, description, modelSchema }) => ({ name, description, inputSchema: modelSchema })), observations,
        conversation: options.conversation
      });
    } catch (error) {
      throw new AgentRunError("model_failed", error instanceof Error ? error.message : "Model request failed");
    }
    steps += 1;
    usage.inputTokens += response.usage.inputTokens; usage.outputTokens += response.usage.outputTokens; usage.totalTokens += response.usage.totalTokens;
    const forcedContextTool = requiredContextTool(question, observations);
    const decision = response.decision.kind === "final" && forcedContextTool
      ? { kind: "tool_call" as const, toolName: forcedContextTool.toolName, input: forcedContextTool.input }
      : response.decision;
    if (decision.kind === "refusal") {
      return complete(analysisAnswerSchema.parse({
        conclusion: decision.message, playerEvidence: [], knowledgeEvidence: [], confidence: "high",
        recommendations: [], limitations: [decision.reason], nextQuestions: []
      }));
    }
    if (decision.kind === "final") {
      const parsed = analysisAnswerSchema.safeParse(decision.answer);
      if (!parsed.success) {
        const issues = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
        throw new AgentRunError("invalid_output", `Model returned an invalid evidence-bound answer: ${issues}`);
      }
      return complete(parsed.data);
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
  } catch (error) {
    const failure = error instanceof AgentRunError ? error : new AgentRunError("model_failed", "Agent run failed");
    await options.traceSink?.save({ runId, userId: options.user.userId, question, prompt, modelProvider: options.model.provider ?? "unknown", toolCalls: observations, answer: null, status: "failed", errorCode: failure.code, errorMessage: failure.message, latencyMs: Date.now() - startedAt, steps, usage: { ...usage, estimatedCostUsd: null } });
    throw failure;
  }
}

export class DeterministicAnalysisModel implements AgentModel {
  readonly provider = "deterministic";
  async respond(request: AgentModelRequest): Promise<AgentModelResponse> {
    const summary = request.observations.find((observation) => observation.toolName === "get_player_summary");
    if (!summary) return { decision: { kind: "tool_call", toolName: "get_player_summary", input: {} }, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } };
    const data = summary.result as { scope?: { sampleSize?: number; limitation?: string }; metrics?: Record<string, number> | null };
    const metrics = data.metrics;
    const asksAboutMemory = /(训练目标|训练计划|记住|长期记忆|上次分析|我的目标|memory)/i.test(request.userMessage);
    if (asksAboutMemory && !request.observations.some((observation) => observation.toolName === "get_training_memory")) {
      return { decision: { kind: "tool_call", toolName: "get_training_memory", input: { query: request.userMessage.slice(0, 200) } }, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } };
    }
    const asksAboutBenchmark = /(同段位|基准|benchmark|中位数)/i.test(request.userMessage);
    if (asksAboutBenchmark && !request.observations.some((observation) => observation.toolName === "get_rank_benchmark")) {
      return { decision: { kind: "tool_call", toolName: "get_rank_benchmark", input: {} }, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } };
    }
    if (!metrics) return { decision: { kind: "final", answer: {
      conclusion: "There is not enough completed competitive data to identify a stable trend yet.", playerEvidence: [], knowledgeEvidence: [], confidence: "low",
      recommendations: [{ action: "Play and sync more completed competitive matches", rationale: "The current data set has no usable player metrics." }],
      limitations: [data.scope?.limitation ?? "No completed competitive matches are available."], nextQuestions: ["Which recent match should we review after more data is synced?"]
    } }, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } };
    const asksAboutFirstDeaths = /(先死|首死|first\s*death|opening\s*death)/i.test(request.userMessage);
    const foundRounds = request.observations.find((observation) => observation.toolName === "find_round_evidence");
    if (asksAboutFirstDeaths && !foundRounds) {
      return { decision: { kind: "tool_call", toolName: "find_round_evidence", input: { eventType: "first_death", limit: 5 } }, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } };
    }
    const firstDeathRate = metrics.firstDeathRate;
    const metricName = typeof firstDeathRate === "number" ? "first_death_rate" : "adr";
    const value = metrics[metricName === "first_death_rate" ? "firstDeathRate" : "adr"];
    const rounds = (foundRounds?.result as { evidence?: { matchId: string; roundNumber: number }[] } | undefined)?.evidence ?? [];
    const roundCitations = rounds.map((round) => ({
      claim: "This round contains a recorded first-death event.",
      matchId: round.matchId,
      roundNumber: round.roundNumber
    }));
    return { decision: { kind: "final", answer: {
      conclusion: `Your recent competitive sample has ${metricName.replaceAll("_", " ")} at ${value}. Use this as a review signal, not a diagnosis.`,
      playerEvidence: [{ claim: `${metricName} is ${value}.`, metricName }, ...roundCitations], knowledgeEvidence: [], confidence: data.scope?.sampleSize && data.scope.sampleSize >= 5 ? "medium" : "low",
      recommendations: [{ action: "Review the rounds behind this metric", rationale: "A round-level review can separate repeatable patterns from a small-sample fluctuation." }],
      limitations: [data.scope?.limitation ?? "Metrics are limited to completed competitive matches.", ...(asksAboutFirstDeaths && rounds.length === 0 ? ["No concrete first-death rounds were found in the current sample."] : [])], nextQuestions: ["Would you like to inspect a specific round or compare recent matches?"]
    } }, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } };
  }
}

export function createDefaultAnalysis(options: Omit<AgentRunOptions, "tools" | "model"> & { reader: Parameters<typeof createAnalyticsTools>[1]; model?: AgentModel }): Promise<AgentRunResult> {
  return runAnalysis({ ...options, tools: createAnalyticsTools(options.user, options.reader), model: options.model ?? new DeterministicAnalysisModel() });
}
