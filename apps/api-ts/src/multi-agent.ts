import { createAnalyticsTools, type AnalyticsTool } from "./agent-tools.js";
import { runAnalysis, unsupportedQuestion, type AgentRunOptions, type AgentRunResult, type ToolObservation } from "./agent-runtime.js";

export const specialistNames = ["stats", "death", "map", "economy", "aim", "memory"] as const;
export type SpecialistName = typeof specialistNames[number];

export type SpecialistExecution = {
  specialist: SpecialistName;
  toolNames: string[];
  observations: ToolObservation[];
  limitations: string[];
};

export type MultiAgentRunResult = AgentRunResult & {
  orchestration: {
    supervisor: "supervisor";
    selectedSpecialists: SpecialistName[];
    maxSpecialists: number;
    maxTotalToolCalls: number;
  };
  specialists: SpecialistExecution[];
};

export type MultiAgentRunOptions = Omit<AgentRunOptions, "tools" | "initialObservations"> & {
  reader: Parameters<typeof createAnalyticsTools>[1];
  maxSpecialists?: number;
  maxTotalToolCalls?: number;
};

type PlannedTool = { name: string; input: (question: string) => unknown; when?: (question: string) => boolean };

const specialistPlans: Record<SpecialistName, PlannedTool[]> = {
  stats: [
    { name: "compare_recent_periods", input: () => ({}) },
    { name: "get_act_performance", input: () => ({}), when: (question) => /(Act|赛季|段位趋势|跨\s*Act)/i.test(question) },
    { name: "get_agent_performance", input: () => ({}), when: (question) => /(英雄|特工|agent)/i.test(question) }
  ],
  death: [{ name: "find_round_evidence", input: () => ({ eventType: "first_death", limit: 5 }) }],
  map: [
    { name: "compare_attack_defense", input: () => ({}) },
    { name: "compare_map_performance", input: () => ({}) },
    { name: "get_map_round_summary", input: (question) => ({ mapName: mapNameFromQuestion(question), limit: 12 }), when: (question) => Boolean(mapNameFromQuestion(question)) },
    { name: "search_knowledge", input: (question) => ({ query: question.slice(0, 200), ...(mapNameFromQuestion(question) ? { mapName: mapNameFromQuestion(question) } : {}), ...(sideFromQuestion(question) ? { side: sideFromQuestion(question) } : {}) }), when: isTeachingQuestion }
  ],
  economy: [{ name: "get_economy_performance", input: () => ({}) }],
  aim: [{ name: "get_agent_performance", input: () => ({}) }],
  memory: [{ name: "get_training_memory", input: (question) => ({ query: question.slice(0, 200) }) }]
};

/**
 * A bounded internal supervisor, inspired by coding agents: it selects only
 * the relevant role workers, each worker can call a fixed tool allowlist, and
 * a single supervisor model synthesizes the resulting observations.
 */
export async function runMultiAgentAnalysis(options: MultiAgentRunOptions): Promise<MultiAgentRunResult> {
  const question = options.question.trim();
  const maxSpecialists = options.maxSpecialists ?? 3;
  const maxTotalToolCalls = options.maxTotalToolCalls ?? 8;
  const tools = createAnalyticsTools(options.user, options.reader);
  const selectedSpecialists = unsupportedQuestion(question) ? [] : selectSpecialists(question, maxSpecialists);
  const toolMap = new Map(tools.map((tool) => [tool.name, tool]));
  const allObservations: ToolObservation[] = [];
  const specialists: SpecialistExecution[] = [];

  if (!unsupportedQuestion(question) && maxTotalToolCalls > 0) {
    const baseline = await executeTool("supervisor", toolMap.get("get_player_summary"), {}, options.toolTimeoutMs ?? 5_000);
    if (baseline.observation) allObservations.push(baseline.observation);
  }

  for (const specialist of selectedSpecialists) {
    const execution: SpecialistExecution = { specialist, toolNames: [], observations: [], limitations: [] };
    for (const planned of specialistPlans[specialist]) {
      if (allObservations.length >= maxTotalToolCalls) {
        execution.limitations.push("Global tool budget reached before this specialist completed.");
        break;
      }
      if (planned.when && !planned.when(question)) continue;
      if (allObservations.some((observation) => observation.toolName === planned.name)) continue;
      const outcome = await executeTool(specialist, toolMap.get(planned.name), planned.input(question), options.toolTimeoutMs ?? 5_000);
      if (outcome.observation) {
        allObservations.push(outcome.observation);
        execution.observations.push(outcome.observation);
        execution.toolNames.push(outcome.observation.toolName);
      }
      if (outcome.limitation) execution.limitations.push(outcome.limitation);
    }
    specialists.push(execution);
  }

  const result = await runAnalysis({
    ...options,
    tools,
    initialObservations: allObservations,
    maxToolCalls: maxTotalToolCalls
  });
  return {
    ...result,
    orchestration: { supervisor: "supervisor", selectedSpecialists, maxSpecialists, maxTotalToolCalls },
    specialists
  };
}

export function selectSpecialists(question: string, maxSpecialists = 3): SpecialistName[] {
  const selected: SpecialistName[] = [];
  const add = (name: SpecialistName) => { if (!selected.includes(name) && selected.length < maxSpecialists) selected.push(name); };
  if (/(训练目标|训练计划|记住|长期记忆|上次分析|我的目标|memory)/i.test(question)) add("memory");
  if (/(经济局|经济表现|经济决策|full buy|半起|eco)/i.test(question)) add("economy");
  if (/(瞄准|枪法|爆头|headshot|aim|准星)/i.test(question)) add("aim");
  if (/(先死|首死|first\s*death|opening\s*death)/i.test(question)) add("death");
  if (/(地图|Haven|Ascent|隐世修所|亚海悬城|攻守|进攻|防守|教学|架枪|点位|爆弹|战术执行|setup|lineup)/i.test(question)) add("map");
  if (/(最近|趋势|状态|变好|变差|Act|赛季|段位|英雄|特工|agent|表现|K\/D|ADR|ACS)/i.test(question) || selected.length === 0) add("stats");
  return selected;
}

async function executeTool(specialist: string, tool: AnalyticsTool<any, any> | undefined, rawInput: unknown, timeoutMs: number): Promise<{ observation?: ToolObservation; limitation?: string }> {
  if (!tool) return { limitation: `Specialist ${specialist} has no registered tool for this task.` };
  const input = tool.inputSchema.safeParse(rawInput);
  if (!input.success) return { limitation: `Specialist ${specialist} produced invalid input for ${tool.name}.` };
  try {
    const result = await withTimeout(tool.execute(input.data), timeoutMs);
    return { observation: { specialist, toolName: tool.name, input: input.data, result } };
  } catch (error) {
    return { limitation: `Specialist ${specialist} could not read ${tool.name}: ${error instanceof Error ? error.message : "unknown failure"}` };
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error("Tool execution timed out")), timeoutMs); })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function mapNameFromQuestion(question: string): "Haven" | "Ascent" | undefined {
  if (/(Haven|隐世修所)/i.test(question)) return "Haven";
  if (/(Ascent|亚海悬城)/i.test(question)) return "Ascent";
  return undefined;
}

function sideFromQuestion(question: string): "attack" | "defense" | undefined {
  if (/(防守|defense)/i.test(question)) return "defense";
  if (/(进攻|attack)/i.test(question)) return "attack";
  return undefined;
}

function isTeachingQuestion(question: string): boolean {
  return /(教学|架枪|点位|爆弹|战术执行|进攻思路|防守思路|teach|setup|lineup)/i.test(question);
}
