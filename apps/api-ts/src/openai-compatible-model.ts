import OpenAI from "openai";
import { analysisModelApiKey, analysisModelBaseUrl, analysisModelName } from "./config.js";
import { DeterministicAnalysisModel, type AgentModel, type AgentModelDecision, type AgentModelRequest } from "./agent-runtime.js";

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

  async respond(request: AgentModelRequest): Promise<AgentModelDecision> {
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
      return {
        kind: "tool_call",
        toolName: toolCall.function.name,
        input: JSON.parse(toolCall.function.arguments || "{}") as unknown
      };
    }
    if (!message?.content) throw new Error("Model returned neither a tool call nor a final answer");
    const content = message.content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    return { kind: "final", answer: JSON.parse(content) as unknown };
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
