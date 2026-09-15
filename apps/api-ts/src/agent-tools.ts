import { z } from "zod";
import type { AnalyticsReader, MatchList, PlayerSummary, RoundEvidenceResult } from "./analytics-reader.js";
import { analysisAnswerSchema, type AuthenticatedUser } from "./agent-contracts.js";
export { analysisAnswerSchema } from "./agent-contracts.js";

export type AnalyticsTool<Input, Output> = {
  name: string;
  description: string;
  inputSchema: z.ZodType<Input, z.ZodTypeDef, unknown>;
  execute(input: Input): Promise<Output>;
};

const emptyInputSchema = z.object({}).strict();
const matchListInputSchema = z.object({ limit: z.number().int().min(1).max(10).default(5) }).strict();
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
  reader: Pick<AnalyticsReader, "getPlayerSummary" | "getMatchList" | "getRoundEvidence" | "findRoundEvidence">
): readonly [
  AnalyticsTool<Record<string, never>, PlayerSummary>,
  AnalyticsTool<{ limit: number }, MatchList>,
  AnalyticsTool<{ eventType: "first_death"; limit: number }, RoundEvidenceResult>,
  AnalyticsTool<{ matchId: string; roundNumber: number }, RoundEvidenceResult>
] {
  return [
    {
      name: "get_player_summary",
      description: "Read deterministic metrics from the authenticated player's completed competitive matches.",
      inputSchema: emptyInputSchema,
      execute: () => reader.getPlayerSummary(user.userId)
    },
    {
      name: "get_match_list",
      description: "List up to ten recent completed competitive matches for the authenticated player.",
      inputSchema: matchListInputSchema,
      execute: ({ limit }: { limit: number }) => reader.getMatchList(user.userId, limit)
    },
    {
      name: "find_round_evidence",
      description: "Find recent evidence-backed rounds for the authenticated player by supported event type.",
      inputSchema: findRoundEvidenceInputSchema,
      execute: ({ eventType, limit }: { eventType: "first_death"; limit: number }) => reader.findRoundEvidence(user.userId, eventType, limit)
    },
    {
      name: "get_round_evidence",
      description: "Read concrete events for one completed competitive match round owned by the authenticated player.",
      inputSchema: roundEvidenceInputSchema,
      execute: ({ matchId, roundNumber }: { matchId: string; roundNumber: number }) => reader.getRoundEvidence(user.userId, matchId, roundNumber)
    }
  ];
}
