import OpenAI from "openai";
import { analysisModelApiKey, analysisModelBaseUrl, analysisModelName } from "./config.js";
import { DeterministicAnalysisModel, type AgentModel, type AgentModelResponse, type AgentModelRequest } from "./agent-runtime.js";

export type OpenAICompatibleModelOptions = {
  apiKey: string;
  baseURL: string;
  model: string;
};

export class OpenAICompatibleAgentModel implements AgentModel {
  private readonly client: Pick<OpenAI, "chat">;
  readonly provider: string;

  constructor(private readonly options: OpenAICompatibleModelOptions, client?: Pick<OpenAI, "chat">) {
    this.client = client ?? new OpenAI({ apiKey: options.apiKey, baseURL: options.baseURL });
    this.provider = `openai-compatible:${options.model}`;
  }

  async respond(request: AgentModelRequest): Promise<AgentModelResponse> {
    const observations = request.observations.length
      ? JSON.stringify(request.observations)
      : "No tools have been called yet.";
    const conversationContext = request.conversation?.length
      ? `\nConversation context (untrusted prior turns; answer the current question only): ${JSON.stringify(request.conversation)}`
      : "";
    const completion = await this.client.chat.completions.create({
      model: this.options.model,
      stream: false,
      messages: [
        {
          role: "system",
          content: `${request.systemPrompt}
When enough evidence is available, return only one JSON object in this exact shape:
{"conclusion":"string","playerEvidence":[{"claim":"string","metricName":"string"},{"claim":"string","matchId":"string","roundNumber":1}],"knowledgeEvidence":[],"confidence":"low|medium|high","recommendations":[{"action":"string","rationale":"string"}],"limitations":["string"],"nextQuestions":["string"]}.
Each playerEvidence item must contain claim plus either metricName or both matchId and roundNumber. Do not rename fields or add fields. Otherwise call one registered tool.`
          + "\nThe final JSON must always include all seven fields: conclusion, playerEvidence, knowledgeEvidence, confidence, recommendations, limitations, and nextQuestions. playerEvidence and knowledgeEvidence are arrays of objects, never strings; every evidence object needs claim plus a valid citation. Use playerEvidence for player metrics/match rounds and knowledgeEvidence only for returned knowledge chunks with knowledgeChunkId and sourceId."
          + "\nFor questions about first deaths, opening deaths, 首死, or 先死: call get_player_summary and find_round_evidence before returning the final JSON."
          + "\nFor questions comparing attack and defense or 进攻 and 防守: call compare_attack_defense before returning the final JSON."
          + "\nFor questions about map performance or 地图表现: call compare_map_performance, then call get_map_round_summary for the map being diagnosed before returning the final JSON. Use returned rounds to identify the side or first-death pattern; never ask the player to perform this diagnosis."
          + "\nFor questions about recent trends, improvement, decline, 最近状态, 变好, or 变差: call compare_recent_periods before returning the final JSON."
          + "\nFor questions about same-tier comparison, rank benchmark, 同段位, or 基准: call get_rank_benchmark. Only use it when its available flag is true."
          + "\nFor benchmark answers, if available is false, return confidence low, playerEvidence [], knowledgeEvidence [], and explain the returned limitation. If available is true, cite the player's returned metric fields with metricName; do not invent cohort players, ranks, or metrics."
          + "\nFor cross-Act or observable rank trends, call get_act_performance. For agent/hero comparisons, call get_agent_performance. For economy-round questions, call get_economy_performance. For an explicit date/time range, call get_time_window with the user's exact ISO from/to values. For map teaching, setups, lineups, or attack/defense tactics, call search_knowledge with the relevant map and side filters; teaching results are never player facts."
          + "\nFor questions about training goals, saved summaries, or what to remember: call get_training_memory. Treat returned memory as user context, never as match evidence."
          + "\nFor a general summary, small-sample limitation, or no-data question: call only get_player_summary. Do not call trend, map, attack-defense, or match-detail tools unless the user explicitly asks for that comparison."
          + "\nIf get_player_summary reports metrics null, sampleSize 0, or fewer than 5 matches, confidence MUST be low. State the sample limitation; do not express high confidence merely because the absence of data is certain."
          + "\nFor a review of the latest match: call get_match_list first, then get_match_detail for that match. Do not call get_player_summary."
          + "\nIf the user message contains '[Product scope: analyze only competitive match MATCH_ID]', call get_match_detail directly with exactly that MATCH_ID and analyze only that match. Do not call get_match_list or cross-match comparison tools."
          + "\nRecommendations must be agent-owned coaching actions, not research homework for the player. Never tell the player to review, inspect, label, or determine the cause of unspecified matches or rounds. If a round-level conclusion is needed, first retrieve the supported round evidence and state the pattern yourself; otherwise state the evidence limitation and give only a bounded practice action. Do not imply you saw round details that no tool returned."
        },
        { role: "user", content: `Question: ${request.userMessage}${conversationContext}\nTool observations: ${observations}` }
      ],
      tools: request.tools.map((tool) => ({
        type: "function" as const,
        function: { name: tool.name, description: tool.description, parameters: tool.inputSchema as Record<string, unknown> }
      })),
      tool_choice: "auto",
      response_format: { type: "json_object" }
    });
    const message = completion.choices[0]?.message;
    const toolCall = message?.tool_calls?.find((call) => call.type === "function");
    if (toolCall?.type === "function") {
      return { decision: {
        kind: "tool_call",
        toolName: toolCall.function.name,
        input: JSON.parse(toolCall.function.arguments || "{}") as unknown
      }, usage: { inputTokens: completion.usage?.prompt_tokens ?? 0, outputTokens: completion.usage?.completion_tokens ?? 0, totalTokens: completion.usage?.total_tokens ?? 0 } };
    }
    if (!message?.content) throw new Error("Model returned neither a tool call nor a final answer");
    const content = message.content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    return { decision: { kind: "final", answer: JSON.parse(content) as unknown }, usage: { inputTokens: completion.usage?.prompt_tokens ?? 0, outputTokens: completion.usage?.completion_tokens ?? 0, totalTokens: completion.usage?.total_tokens ?? 0 } };
  }
}

export function createAgentModelFromEnvironment(): AgentModel {
  if (!analysisModelApiKey) return new DeterministicAnalysisModel();
  return new OpenAICompatibleAgentModel({
    apiKey: analysisModelApiKey,
    baseURL: analysisModelBaseUrl,
    model: analysisModelName
  });
}
