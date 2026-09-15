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

  constructor(private readonly options: OpenAICompatibleModelOptions, client?: Pick<OpenAI, "chat">) {
    this.client = client ?? new OpenAI({ apiKey: options.apiKey, baseURL: options.baseURL });
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
          content: `${request.systemPrompt}\nWhen enough evidence is available, return only one JSON object with conclusion, playerEvidence, knowledgeEvidence, confidence, recommendations, limitations, and nextQuestions. Otherwise call one registered tool.`
        },
        { role: "user", content: `Question: ${request.userMessage}\nTool observations: ${observations}` }
      ],
      tools: request.tools.map((tool) => ({
        type: "function" as const,
        function: { name: tool.name, description: tool.description, parameters: tool.inputSchema as Record<string, unknown> }
      })),
      tool_choice: "auto"
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
    return { kind: "final", answer: JSON.parse(message.content) as unknown };
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
