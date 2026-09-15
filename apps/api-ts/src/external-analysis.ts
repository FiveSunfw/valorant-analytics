import { z } from "zod";
import type { AuthenticatedUser } from "./agent-contracts.js";

export const externalAnalysisResultSchema = z.object({
  provider: z.enum(["opgg", "upforge", "insights", "other"]),
  source: z.enum(["uploaded-replay", "recorded-vod", "public-profile"]),
  generatedAt: z.string().datetime(),
  gameVersion: z.string().min(1).optional(),
  metrics: z.record(z.union([z.number(), z.string(), z.null()])),
  evidenceRefs: z.array(z.string().min(1)),
  limitations: z.array(z.string().min(1)).min(1)
}).strict();

export type ExternalAnalysisResult = z.infer<typeof externalAnalysisResultSchema>;

export type ExternalAnalysisRequest = {
  user: AuthenticatedUser;
  assetId: string;
  source: Exclude<ExternalAnalysisResult["source"], "public-profile">;
};

/** Adapter boundary for existing replay/VOD services; implementations must enforce user ownership. */
export interface ExternalAnalysisProvider {
  readonly provider: ExternalAnalysisResult["provider"];
  analyze(request: ExternalAnalysisRequest): Promise<ExternalAnalysisResult>;
}

export function validateExternalResult(result: unknown): ExternalAnalysisResult {
  const parsed = externalAnalysisResultSchema.parse(result);
  if (parsed.source === "public-profile") {
    throw new Error("Public profile results cannot be used as authenticated player evidence");
  }
  return parsed;
}
