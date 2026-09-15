import type { Pool } from "pg";
import type { AnalysisAnswer } from "./agent-contracts.js";

export type AgentTraceRecord = {
  runId: string;
  userId: string;
  question: string;
  prompt: { id: string; version: string; hash: string };
  modelProvider: string;
  toolCalls: readonly { toolName: string; input: unknown; result: unknown }[];
  answer: AnalysisAnswer;
  status: "completed";
  latencyMs: number;
};

export interface AgentTraceSink {
  save(record: AgentTraceRecord): Promise<void>;
}

export class PostgresAgentTraceSink implements AgentTraceSink {
  constructor(private readonly pool: Pool) {}

  async save(record: AgentTraceRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO agent_runs (
        run_id, user_id, question, prompt_id, prompt_version, prompt_hash,
        model_provider, tool_calls, answer, status, latency_ms
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11)`,
      [record.runId, record.userId, record.question, record.prompt.id, record.prompt.version,
        record.prompt.hash, record.modelProvider, JSON.stringify(record.toolCalls),
        JSON.stringify(record.answer), record.status, record.latencyMs]
    );
  }
}
