import { randomUUID } from "node:crypto";
import type { Pool } from "pg";

export type CoachMessageRole = "user" | "assistant";

export type CoachMessage = {
  id: string;
  role: CoachMessageRole;
  content: string;
  answer?: Record<string, unknown>;
  runId?: string;
  createdAt: Date;
};

export type CoachSession = {
  id: string;
  title: string;
  matchId?: string;
  messages: CoachMessage[];
  createdAt: Date;
  updatedAt: Date;
};

export type CoachSessionInput = { title?: string; matchId?: string | null };
export type CoachMessageInput = { role: CoachMessageRole; content: string; answer?: Record<string, unknown>; runId?: string };

export interface CoachSessionService {
  list(userId: string): Promise<CoachSession[]>;
  get(userId: string, sessionId: string): Promise<CoachSession | null>;
  create(userId: string, input: CoachSessionInput): Promise<CoachSession | null>;
  update(userId: string, sessionId: string, input: CoachSessionInput): Promise<CoachSession | null>;
  appendMessage(userId: string, sessionId: string, input: CoachMessageInput): Promise<CoachMessage | null>;
  delete(userId: string, sessionId: string): Promise<boolean>;
}

type SessionRow = { id: string; title: string; match_id: string | null; created_at: Date; updated_at: Date };
type MessageRow = { id: string; session_id: string; role: CoachMessageRole; content: string; answer: Record<string, unknown> | null; run_id: string | null; created_at: Date };

function toMessage(row: MessageRow): CoachMessage {
  return {
    id: row.id,
    role: row.role,
    content: row.content,
    ...(row.answer ? { answer: row.answer } : {}),
    ...(row.run_id ? { runId: row.run_id } : {}),
    createdAt: row.created_at
  };
}

function toSession(row: SessionRow, messages: CoachMessage[] = []): CoachSession {
  return {
    id: row.id,
    title: row.title,
    ...(row.match_id ? { matchId: row.match_id } : {}),
    messages,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export class PostgresCoachSessionStore implements CoachSessionService {
  constructor(private readonly pool: Pool) {}

  async list(userId: string): Promise<CoachSession[]> {
    const sessions = await this.pool.query<SessionRow>(
      "SELECT id, title, match_id, created_at, updated_at FROM coach_sessions WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 20",
      [userId]
    );
    if (!sessions.rows.length) return [];
    const messages = await this.pool.query<MessageRow>(
      "SELECT id, session_id, role, content, answer, run_id, created_at FROM coach_messages WHERE session_id = ANY($1::uuid[]) ORDER BY created_at ASC",
      [sessions.rows.map((session) => session.id)]
    );
    const bySession = new Map<string, CoachMessage[]>();
    for (const message of messages.rows) bySession.set(message.session_id, [...(bySession.get(message.session_id) ?? []), toMessage(message)]);
    return sessions.rows.map((session) => toSession(session, bySession.get(session.id) ?? []));
  }

  async get(userId: string, sessionId: string): Promise<CoachSession | null> {
    const result = await this.pool.query<SessionRow>(
      "SELECT id, title, match_id, created_at, updated_at FROM coach_sessions WHERE id = $1 AND user_id = $2",
      [sessionId, userId]
    );
    const row = result.rows[0];
    if (!row) return null;
    const messages = await this.pool.query<MessageRow>(
      "SELECT id, session_id, role, content, answer, run_id, created_at FROM coach_messages WHERE session_id = $1 ORDER BY created_at ASC",
      [sessionId]
    );
    return toSession(row, messages.rows.map(toMessage));
  }

  async create(userId: string, input: CoachSessionInput): Promise<CoachSession | null> {
    if (input.matchId && !(await this.ownsMatch(userId, input.matchId))) return null;
    const result = await this.pool.query<SessionRow>(
      "INSERT INTO coach_sessions (id, user_id, title, match_id) VALUES ($1, $2, $3, $4) RETURNING id, title, match_id, created_at, updated_at",
      [randomUUID(), userId, input.title ?? "新的复盘会话", input.matchId ?? null]
    );
    return result.rows[0] ? toSession(result.rows[0]) : null;
  }

  async update(userId: string, sessionId: string, input: CoachSessionInput): Promise<CoachSession | null> {
    if (input.matchId && !(await this.ownsMatch(userId, input.matchId))) return null;
    const current = await this.pool.query<{ id: string }>("SELECT id FROM coach_sessions WHERE id = $1 AND user_id = $2", [sessionId, userId]);
    if (!current.rows[0]) return null;
    const fields: string[] = [];
    const values: unknown[] = [];
    if (input.title !== undefined) { fields.push(`title = $${values.length + 1}`); values.push(input.title); }
    if (input.matchId !== undefined) { fields.push(`match_id = $${values.length + 1}`); values.push(input.matchId); }
    if (!fields.length) return this.get(userId, sessionId);
    values.push(sessionId, userId);
    const result = await this.pool.query<SessionRow>(
      `UPDATE coach_sessions SET ${fields.join(", ")}, updated_at = now() WHERE id = $${values.length - 1} AND user_id = $${values.length} RETURNING id, title, match_id, created_at, updated_at`,
      values
    );
    return result.rows[0] ? this.get(userId, sessionId) : null;
  }

  async appendMessage(userId: string, sessionId: string, input: CoachMessageInput): Promise<CoachMessage | null> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const session = await client.query<{ id: string }>("SELECT id FROM coach_sessions WHERE id = $1 AND user_id = $2 FOR UPDATE", [sessionId, userId]);
      if (!session.rows[0]) {
        await client.query("ROLLBACK");
        return null;
      }
      const result = await client.query<MessageRow>(
        "INSERT INTO coach_messages (id, session_id, role, content, answer, run_id) VALUES ($1, $2, $3, $4, $5::jsonb, $6) RETURNING id, session_id, role, content, answer, run_id, created_at",
        [randomUUID(), sessionId, input.role, input.content, input.answer ? JSON.stringify(input.answer) : null, input.runId ?? null]
      );
      await client.query("UPDATE coach_sessions SET updated_at = now() WHERE id = $1 AND user_id = $2", [sessionId, userId]);
      await client.query("COMMIT");
      return result.rows[0] ? toMessage(result.rows[0]) : null;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async delete(userId: string, sessionId: string): Promise<boolean> {
    const result = await this.pool.query("DELETE FROM coach_sessions WHERE id = $1 AND user_id = $2", [sessionId, userId]);
    return Boolean(result.rowCount);
  }

  private async ownsMatch(userId: string, matchId: string): Promise<boolean> {
    const result = await this.pool.query(
      "SELECT 1 FROM player_match_stats pms JOIN riot_accounts ra ON ra.id = pms.riot_account_id WHERE pms.match_id = $1 AND ra.user_id = $2 LIMIT 1",
      [matchId, userId]
    );
    return Boolean(result.rowCount);
  }
}
