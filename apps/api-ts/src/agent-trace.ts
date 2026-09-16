import type { Pool } from "pg";
import type { AnalysisAnswer } from "./agent-contracts.js";

export type AgentTraceRecord = {
  runId: string;
  userId: string;
  question: string;
  prompt: { id: string; version: string; hash: string };
  modelProvider: string;
  toolCalls: readonly { toolName: string; input: unknown; result: unknown }[];
  answer: AnalysisAnswer | null;
  status: "completed" | "failed";
  errorCode?: string;
  errorMessage?: string;
  latencyMs: number;
  steps: number;
  usage: { inputTokens: number; outputTokens: number; totalTokens: number; estimatedCostUsd: number | null };
};

export interface AgentTraceSink {
  save(record: AgentTraceRecord): Promise<void>;
}

export type PublicAgentRun = {
  runId: string; status: string; errorCode: string | null; errorMessage: string | null;
  steps: number; toolNames: string[]; usage: { inputTokens: number | null; outputTokens: number | null; totalTokens: number | null; estimatedCostUsd: number | null };
  answer: AnalysisAnswer | null; createdAt: string;
};

export class PostgresAgentTraceSink implements AgentTraceSink {
  constructor(private readonly pool: Pool) {}

  async save(record: AgentTraceRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO agent_runs (
        run_id, user_id, question, prompt_id, prompt_version, prompt_hash,
        model_provider, tool_calls, answer, status, latency_ms, error_code, error_message, steps, input_tokens, output_tokens, total_tokens, estimated_cost_usd
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
      [record.runId, record.userId, record.question, record.prompt.id, record.prompt.version,
        record.prompt.hash, record.modelProvider, JSON.stringify(record.toolCalls),
        JSON.stringify(record.answer), record.status, record.latencyMs, record.errorCode ?? null, record.errorMessage ?? null, record.steps, record.usage.inputTokens, record.usage.outputTokens, record.usage.totalTokens, record.usage.estimatedCostUsd]
    );
  }

  async findForUser(runId: string, userId: string): Promise<PublicAgentRun | null> {
    const result = await this.pool.query(`SELECT run_id, status, error_code, error_message, steps, tool_calls, input_tokens, output_tokens, total_tokens, estimated_cost_usd, answer, created_at FROM agent_runs WHERE run_id = $1 AND user_id = $2`, [runId, userId]);
    const row = result.rows[0];
    if (!row) return null;
    return { runId: row.run_id, status: row.status, errorCode: row.error_code, errorMessage: row.error_message, steps: row.steps, toolNames: row.tool_calls.map((call: { toolName: string }) => call.toolName), usage: { inputTokens: row.input_tokens, outputTokens: row.output_tokens, totalTokens: row.total_tokens, estimatedCostUsd: row.estimated_cost_usd === null ? null : Number(row.estimated_cost_usd) }, answer: row.answer, createdAt: row.created_at.toISOString() };
  }
}
