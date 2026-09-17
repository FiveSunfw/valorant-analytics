import { z } from "zod";
import type { AnalyticsReader, AttackDefenseResult, MapPerformanceResult, MapRoundSummaryResult, MatchDetailResult, MatchList, PlayerSummary, RecentPeriodComparisonResult, RankBenchmark, RoundEvidenceResult, TrainingMemory, KnowledgeResult } from "./analytics-reader.js";
import { analysisAnswerSchema, type AuthenticatedUser } from "./agent-contracts.js";
export { analysisAnswerSchema } from "./agent-contracts.js";

export type AnalyticsTool<Input, Output> = {
  name: string;
  description: string;
  inputSchema: z.ZodType<Input, z.ZodTypeDef, unknown>;
  modelSchema: Record<string, unknown>;
  execute(input: Input): Promise<Output>;
};

const emptyInputSchema = z.object({}).strict();
const matchListInputSchema = z.object({ limit: z.number().int().min(1).max(10).default(5) }).strict();
const matchDetailInputSchema = z.object({ matchId: z.string().min(1) }).strict();
const recentPeriodInputSchema = z.object({ matchesPerPeriod: z.number().int().min(2).max(5).default(3) }).strict();
const roundEvidenceInputSchema = z.object({
  matchId: z.string().min(1),
  roundNumber: z.number().int().min(1)
}).strict();
const findRoundEvidenceInputSchema = z.object({
  eventType: z.enum(["first_death", "death", "kill", "assist"]),
  limit: z.number().int().min(1).max(10).default(5)
}).strict();
const mapRoundSummaryInputSchema = z.object({ mapName: z.string().min(1), limit: z.number().int().min(1).max(30).default(20) }).strict();
const knowledgeInputSchema = z.object({ query: z.string().trim().min(2).max(200), mapName: z.string().trim().min(1).max(64).optional(), side: z.enum(["attack", "defense"]).optional(), limit: z.number().int().min(1).max(5).default(5) }).strict();
const trainingMemoryInputSchema = z.object({ query: z.string().trim().min(1).max(200).optional() }).strict();
const timeWindowInputSchema = z.object({ from: z.string().datetime(), to: z.string().datetime() }).strict().refine((value) => Date.parse(value.to) >= Date.parse(value.from), "to must be after from");

export type { AnalysisAnswer } from "./agent-contracts.js";

export function createAnalyticsTools(
  user: AuthenticatedUser,
  reader: Pick<AnalyticsReader, "getPlayerSummary" | "getMatchList" | "getMatchDetail" | "compareAttackDefense" | "compareMapPerformance" | "compareRecentPeriods" | "getRoundEvidence" | "findRoundEvidence"> & Partial<Pick<AnalyticsReader, "getMapRoundSummary" | "getRankBenchmark" | "getTrainingMemory" | "searchKnowledge" | "getActPerformance" | "getAgentPerformance" | "getEconomyPerformance" | "getTimeWindow">>
): readonly AnalyticsTool<any, any>[] {
  return [
    {
      name: "get_player_summary",
      description: "Read deterministic metrics from the authenticated player's completed competitive matches.",
      inputSchema: emptyInputSchema,
      modelSchema: { type: "object", properties: {}, additionalProperties: false },
      execute: () => reader.getPlayerSummary(user.userId)
    },
    {
      name: "get_match_list",
      description: "List up to ten recent completed competitive matches for the authenticated player.",
      inputSchema: matchListInputSchema,
      modelSchema: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 10 } }, additionalProperties: false },
      execute: ({ limit }: { limit: number }) => reader.getMatchList(user.userId, limit)
    },
    {
      name: "get_match_detail",
      description: "Read one owned completed competitive match with scoreline, combat totals, and deterministic metrics.",
      inputSchema: matchDetailInputSchema,
      modelSchema: {
        type: "object",
        properties: { matchId: { type: "string", minLength: 1 } },
        required: ["matchId"],
        additionalProperties: false
      },
      execute: ({ matchId }: { matchId: string }) => reader.getMatchDetail(user.userId, matchId)
    },
    {
      name: "compare_attack_defense",
      description: "Compare authenticated-player round win rates on attack and defense in completed competitive matches.",
      inputSchema: emptyInputSchema,
      modelSchema: { type: "object", properties: {}, additionalProperties: false },
      execute: () => reader.compareAttackDefense(user.userId)
    },
    {
      name: "compare_map_performance",
      description: "Compare win rate and deterministic combat metrics by map for the authenticated player's competitive matches.",
      inputSchema: emptyInputSchema,
      modelSchema: { type: "object", properties: {}, additionalProperties: false },
      execute: () => reader.compareMapPerformance(user.userId)
    },
    {
      name: "compare_recent_periods",
      description: "Compare the authenticated player's latest competitive matches with the immediately preceding matches using deterministic performance metrics.",
      inputSchema: recentPeriodInputSchema,
      modelSchema: {
        type: "object",
        properties: { matchesPerPeriod: { type: "integer", minimum: 2, maximum: 5, default: 3 } },
        additionalProperties: false
      },
      execute: ({ matchesPerPeriod }: { matchesPerPeriod: number }) => reader.compareRecentPeriods(user.userId, matchesPerPeriod)
    },
    {
      name: "find_round_evidence",
      description: "Find recent evidence-backed rounds for the authenticated player by supported event type.",
      inputSchema: findRoundEvidenceInputSchema,
      modelSchema: {
        type: "object",
        properties: { eventType: { type: "string", enum: ["first_death", "death", "kill", "assist"] }, limit: { type: "integer", minimum: 1, maximum: 10 } },
        required: ["eventType"],
        additionalProperties: false
      },
      execute: ({ eventType, limit }: { eventType: "first_death" | "death" | "kill" | "assist"; limit: number }) => reader.findRoundEvidence(user.userId, eventType, limit)
    },
    {
      name: "get_map_round_summary",
      description: "Read concrete completed-round outcomes, side, and first-death flags for one owned competitive map. Use after map comparison to diagnose a map-level loss pattern.",
      inputSchema: mapRoundSummaryInputSchema,
      modelSchema: { type: "object", properties: { mapName: { type: "string", minLength: 1 }, limit: { type: "integer", minimum: 1, maximum: 30, default: 20 } }, required: ["mapName"], additionalProperties: false },
      execute: ({ mapName, limit }: { mapName: string; limit: number }) => reader.getMapRoundSummary!(user.userId, mapName, limit)
    },
    {
      name: "get_round_evidence",
      description: "Read concrete events for one completed competitive match round owned by the authenticated player.",
      inputSchema: roundEvidenceInputSchema,
      modelSchema: {
        type: "object",
        properties: { matchId: { type: "string", minLength: 1 }, roundNumber: { type: "integer", minimum: 1 } },
        required: ["matchId", "roundNumber"],
        additionalProperties: false
      },
      execute: ({ matchId, roundNumber }: { matchId: string; roundNumber: number }) => reader.getRoundEvidence(user.userId, matchId, roundNumber)
    },
    {
      name: "get_rank_benchmark",
      description: "Read an anonymized same-tier benchmark only when the authorized cohort meets the minimum sample threshold.",
      inputSchema: emptyInputSchema,
      modelSchema: { type: "object", properties: {}, additionalProperties: false },
      execute: () => reader.getRankBenchmark!(user.userId) as Promise<RankBenchmark>
    },
    {
      name: "get_training_memory",
      description: "Semantically retrieve the authenticated player's user-provided training goals and analysis summaries. This is context, not match evidence.",
      inputSchema: trainingMemoryInputSchema,
      modelSchema: { type: "object", properties: { query: { type: "string", minLength: 1, maxLength: 200 } }, additionalProperties: false },
      execute: ({ query }: { query?: string }) => reader.getTrainingMemory!(user.userId, query) as Promise<{ memories: TrainingMemory[]; limitation: string }>
    },
    {
      name: "search_knowledge",
      description: "Search approved, versioned general coaching knowledge. Results are background evidence, never proof of the player's actions.",
      inputSchema: knowledgeInputSchema,
      modelSchema: { type: "object", properties: { query: { type: "string", minLength: 2, maxLength: 200 }, mapName: { type: "string" }, side: { type: "string", enum: ["attack", "defense"] }, limit: { type: "integer", minimum: 1, maximum: 5 } }, required: ["query"], additionalProperties: false },
      execute: ({ query, mapName, side, limit }: { query: string; mapName?: string; side?: "attack" | "defense"; limit: number }) => reader.searchKnowledge!(user.userId, query, mapName, side, limit) as Promise<{ query: string; results: KnowledgeResult[]; limitation: string }>
    },
    {
      name: "get_act_performance",
      description: "Compare the authenticated player's observable tier and metrics by Riot season/Act.",
      inputSchema: emptyInputSchema,
      modelSchema: { type: "object", properties: {}, additionalProperties: false },
      execute: () => reader.getActPerformance!(user.userId)
    },
    {
      name: "get_agent_performance",
      description: "Compare the authenticated player's own completed competitive performance by agent.",
      inputSchema: emptyInputSchema,
      modelSchema: { type: "object", properties: {}, additionalProperties: false },
      execute: () => reader.getAgentPerformance!(user.userId)
    },
    {
      name: "get_economy_performance",
      description: "Analyze the authenticated player's own round outcomes by available economy category.",
      inputSchema: emptyInputSchema,
      modelSchema: { type: "object", properties: {}, additionalProperties: false },
      execute: () => reader.getEconomyPerformance!(user.userId)
    },
    {
      name: "get_time_window",
      description: "Read deterministic metrics for an explicit time window within the authenticated player's completed competitive history.",
      inputSchema: timeWindowInputSchema,
      modelSchema: { type: "object", properties: { from: { type: "string", format: "date-time" }, to: { type: "string", format: "date-time" } }, required: ["from", "to"], additionalProperties: false },
      execute: ({ from, to }: { from: string; to: string }) => reader.getTimeWindow!(user.userId, from, to)
    }
  ];
}
