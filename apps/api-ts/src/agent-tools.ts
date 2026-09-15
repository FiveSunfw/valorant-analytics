import { z } from "zod";
import type { AnalyticsReader, AttackDefenseResult, MapPerformanceResult, MatchDetailResult, MatchList, PlayerSummary, RoundEvidenceResult } from "./analytics-reader.js";
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
const roundEvidenceInputSchema = z.object({
  matchId: z.string().min(1),
  roundNumber: z.number().int().min(1)
}).strict();
const findRoundEvidenceInputSchema = z.object({
  eventType: z.literal("first_death"),
  limit: z.number().int().min(1).max(10).default(5)
}).strict();

export type { AnalysisAnswer } from "./agent-contracts.js";

export function createAnalyticsTools(
  user: AuthenticatedUser,
  reader: Pick<AnalyticsReader, "getPlayerSummary" | "getMatchList" | "getMatchDetail" | "compareAttackDefense" | "compareMapPerformance" | "getRoundEvidence" | "findRoundEvidence">
): readonly [
  AnalyticsTool<Record<string, never>, PlayerSummary>,
  AnalyticsTool<{ limit: number }, MatchList>,
  AnalyticsTool<{ matchId: string }, MatchDetailResult>,
  AnalyticsTool<Record<string, never>, AttackDefenseResult>,
  AnalyticsTool<Record<string, never>, MapPerformanceResult>,
  AnalyticsTool<{ eventType: "first_death"; limit: number }, RoundEvidenceResult>,
  AnalyticsTool<{ matchId: string; roundNumber: number }, RoundEvidenceResult>
] {
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
      name: "find_round_evidence",
      description: "Find recent evidence-backed rounds for the authenticated player by supported event type.",
      inputSchema: findRoundEvidenceInputSchema,
      modelSchema: {
        type: "object",
        properties: { eventType: { type: "string", enum: ["first_death"] }, limit: { type: "integer", minimum: 1, maximum: 10 } },
        required: ["eventType"],
        additionalProperties: false
      },
      execute: ({ eventType, limit }: { eventType: "first_death"; limit: number }) => reader.findRoundEvidence(user.userId, eventType, limit)
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
    }
  ];
}
