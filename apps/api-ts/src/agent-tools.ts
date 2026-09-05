import { z } from "zod";
import type { AnalyticsReader, MatchList, PlayerSummary, RoundEvidenceResult } from "./analytics-reader.js";

export type AuthenticatedUser = { userId: string };

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

export const analysisAnswerSchema = z.object({
  conclusion: z.string().min(1),
  evidence: z.array(z.object({
    claim: z.string().min(1),
    metricName: z.string().min(1).optional(),
    matchId: z.string().min(1).optional(),
    roundNumber: z.number().int().min(1).optional()
  }).strict().refine(
    (citation) => Boolean(citation.metricName) || Boolean(citation.matchId && citation.roundNumber),
    "Each claim must cite a metric or a specific match round."
  )),
  confidence: z.enum(["low", "medium", "high"]),
  recommendations: z.array(z.object({ action: z.string().min(1), rationale: z.string().min(1) }).strict()),
  limitations: z.array(z.string().min(1))
}).strict();

export type AnalysisAnswer = z.infer<typeof analysisAnswerSchema>;

export function createAnalyticsTools(
  user: AuthenticatedUser,
  reader: Pick<AnalyticsReader, "getPlayerSummary" | "getMatchList" | "getRoundEvidence">
): readonly [AnalyticsTool<Record<string, never>, PlayerSummary>, AnalyticsTool<{ limit: number }, MatchList>, AnalyticsTool<{ matchId: string; roundNumber: number }, RoundEvidenceResult>] {
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
      execute: ({ limit }) => reader.getMatchList(user.userId, limit)
    },
    {
      name: "get_round_evidence",
      description: "Read concrete events for one completed competitive match round owned by the authenticated player.",
      inputSchema: roundEvidenceInputSchema,
      execute: ({ matchId, roundNumber }) => reader.getRoundEvidence(user.userId, matchId, roundNumber)
    }
  ];
}
