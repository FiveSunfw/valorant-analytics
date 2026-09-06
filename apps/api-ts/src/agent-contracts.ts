import { z } from "zod";

export const confidenceSchema = z.enum(["low", "medium", "high"]);
export type Confidence = z.infer<typeof confidenceSchema>;

export const authenticatedUserSchema = z.object({ userId: z.string().min(1) }).strict();
export type AuthenticatedUser = z.infer<typeof authenticatedUserSchema>;

export const analysisScopeSchema = z.object({
  label: z.string().min(1),
  fromMatchId: z.string().min(1).optional(),
  toMatchId: z.string().min(1).optional(),
  matchCount: z.number().int().nonnegative(),
  fromTime: z.string().datetime().optional(),
  toTime: z.string().datetime().optional()
}).strict();
export type AnalysisScope = z.infer<typeof analysisScopeSchema>;

const evidenceCitationSchema = z.object({
  claim: z.string().min(1),
  metricName: z.string().min(1).optional(),
  matchId: z.string().min(1).optional(),
  roundNumber: z.number().int().min(1).optional(),
  knowledgeChunkId: z.string().min(1).optional(),
  sourceId: z.string().min(1).optional(),
  location: z.string().min(1).optional()
}).strict().refine(
  (citation) => Boolean(citation.metricName)
    || Boolean(citation.matchId && citation.roundNumber)
    || Boolean(citation.knowledgeChunkId && citation.sourceId),
  "Each claim must cite a metric, a specific match round, or a knowledge source chunk."
);
export type EvidenceCitation = z.infer<typeof evidenceCitationSchema>;

export const recommendationSchema = z.object({
  action: z.string().min(1),
  rationale: z.string().min(1)
}).strict();

export const analysisAnswerSchema = z.object({
  conclusion: z.string().min(1),
  playerEvidence: z.array(evidenceCitationSchema),
  knowledgeEvidence: z.array(evidenceCitationSchema),
  confidence: confidenceSchema,
  recommendations: z.array(recommendationSchema),
  limitations: z.array(z.string().min(1)),
  nextQuestions: z.array(z.string().min(1))
}).strict();
export type AnalysisAnswer = z.infer<typeof analysisAnswerSchema>;

export const specialistFindingSchema = z.object({
  specialist: z.string().min(1),
  conclusion: z.string().min(1),
  confidence: confidenceSchema,
  claims: z.array(evidenceCitationSchema),
  recommendations: z.array(recommendationSchema),
  limitations: z.array(z.string().min(1))
}).strict();
export type SpecialistFinding = z.infer<typeof specialistFindingSchema>;

export const toolResultSchema = z.object({
  ok: z.boolean(),
  data: z.unknown().optional(),
  sampleSize: z.number().int().nonnegative(),
  timeRange: z.object({
    from: z.string().datetime(),
    to: z.string().datetime()
  }).strict().optional(),
  evidenceIds: z.array(z.string().min(1)),
  limitations: z.array(z.string().min(1)),
  error: z.object({
    code: z.string().min(1),
    retryable: z.boolean(),
    message: z.string().min(1)
  }).strict().optional()
}).strict();
export type ToolResult = z.infer<typeof toolResultSchema>;

export const analysisSessionStateSchema = z.object({
  sessionId: z.string().min(1),
  userId: z.string().min(1),
  activeQuestion: z.string().min(1),
  dataScopes: z.array(analysisScopeSchema),
  activeHypotheses: z.array(z.object({
    text: z.string().min(1),
    status: z.enum(["open", "supported", "rejected"]),
    evidenceIds: z.array(z.string().min(1))
  }).strict()),
  findings: z.array(specialistFindingSchema),
  evidenceIds: z.array(z.string().min(1)),
  unresolvedQuestions: z.array(z.string().min(1)),
  lastPromptId: z.string().min(1),
  lastPromptVersion: z.string().min(1)
}).strict();
export type AnalysisSessionState = z.infer<typeof analysisSessionStateSchema>;

export const agentEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("tool_call"),
    runId: z.string().min(1),
    toolName: z.string().min(1),
    input: z.unknown()
  }).strict(),
  z.object({
    type: z.literal("specialist_request"),
    runId: z.string().min(1),
    specialists: z.array(z.string().min(1)).min(1).max(4),
    reason: z.string().min(1)
  }).strict(),
  z.object({
    type: z.literal("clarification_request"),
    runId: z.string().min(1),
    question: z.string().min(1)
  }).strict(),
  z.object({
    type: z.literal("final_answer"),
    runId: z.string().min(1),
    answer: analysisAnswerSchema
  }).strict(),
  z.object({
    type: z.literal("refusal"),
    runId: z.string().min(1),
    reason: z.string().min(1),
    message: z.string().min(1)
  }).strict(),
  z.object({
    type: z.literal("error"),
    runId: z.string().min(1),
    code: z.string().min(1),
    retryable: z.boolean(),
    message: z.string().min(1)
  }).strict()
]);
export type AgentEvent = z.infer<typeof agentEventSchema>;
