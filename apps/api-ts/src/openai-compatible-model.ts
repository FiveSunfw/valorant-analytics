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
          + "\nFor questions about first deaths, opening deaths, 首死, or 先死: call get_player_summary and find_round_evidence before returning the final JSON."
          + "\nFor questions comparing attack and defense or 进攻 and 防守: call compare_attack_defense before returning the final JSON."
          + "\nFor questions about map performance or 地图表现: call compare_map_performance before returning the final JSON."
          + "\nFor questions about recent trends, improvement, decline, 最近状态, 变好, or 变差: call compare_recent_periods before returning the final JSON."
          + "\nFor a general summary, small-sample limitation, or no-data question: call only get_player_summary. Do not call trend, map, attack-defense, or match-detail tools unless the user explicitly asks for that comparison."
          + "\nIf get_player_summary reports metrics null, sampleSize 0, or fewer than 5 matches, confidence MUST be low. State the sample limitation; do not express high confidence merely because the absence of data is certain."
          + "\nFor a review of the latest match: call get_match_list first, then get_match_detail for that match. Do not call get_player_summary."
        },
        { role: "user", content: `Question: ${request.userMessage}\nTool observations: ${observations}` }
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
