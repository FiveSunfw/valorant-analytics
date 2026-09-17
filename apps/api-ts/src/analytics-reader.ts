import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { COMPETITIVE_QUEUE_ID, calculatePlayerMetrics, type PlayerMetrics } from "@valorant/domain";
import type { KnowledgeRagClient } from "./knowledge-rag.js";
import { mapProviderResultToMemory, type MemoryProvider } from "./mem0-memory.js";

export type AnalyticsScope = {
  queue: typeof COMPETITIVE_QUEUE_ID;
  sampleSize: number;
  periodStart?: string;
  periodEnd?: string;
  limitation?: string;
};

export type PlayerSummary = { scope: AnalyticsScope; metrics: PlayerMetrics | null };
export type TimeWindowResult = { scope: AnalyticsScope; metrics: PlayerMetrics | null };
export type RoundEventType = "first_death" | "death" | "kill" | "assist";
export type RoundEvidence = { matchId: string; roundNumber: number; eventType: RoundEventType; description: string };
export type MatchSummary = { matchId: string; mapName: string; playedAt: string; result: "win" | "loss" };
export type MatchList = { scope: AnalyticsScope; matches: MatchSummary[] };
export type MatchDetailResult = {
  scope: AnalyticsScope;
  match: (MatchSummary & { roundsWon: number; roundsLost: number; kills: number; deaths: number; assists: number; metrics: PlayerMetrics }) | null;
};
export type SidePerformance = { roundsPlayed: number; roundsWon: number; winRate: number };
export type AttackDefenseResult = { scope: AnalyticsScope; attack: SidePerformance; defense: SidePerformance };
export type MapPerformance = {
  mapName: string; matches: number; wins: number; losses: number; winRate: number;
  kd: number; adr: number; acs: number; firstDeathRate: number;
};
export type MapPerformanceResult = { scope: AnalyticsScope; maps: MapPerformance[] };
export type MapRoundSummary = { matchId: string; roundNumber: number; side: "attack" | "defense"; won: boolean; roundResult: string | null; wasFirstDeath: boolean };
export type MapRoundSummaryResult = { scope: AnalyticsScope; mapName: string; matches: number; rounds: MapRoundSummary[] };
export type PeriodPerformance = {
  matches: number; wins: number; losses: number; winRate: number;
  kd: number; adr: number; acs: number; firstDeathRate: number;
  periodStart: string; periodEnd: string;
};
export type RecentPeriodComparisonResult = {
  scope: AnalyticsScope;
  matchesPerPeriod: number;
  recent: PeriodPerformance | null;
  previous: PeriodPerformance | null;
  deltas: Pick<PeriodPerformance, "winRate" | "kd" | "adr" | "acs" | "firstDeathRate"> | null;
};
export type RoundEvidenceResult = { scope: AnalyticsScope; evidence: RoundEvidence[] };
export type SyncJobStatus = "queued" | "running" | "completed" | "failed";
export type SyncJob = {
  jobId: string; status: SyncJobStatus; imported: number; skipped: number;
  failedMatchIds: string[]; errorCode?: string; errorMessage?: string;
  createdAt: string; updatedAt: string; completedAt?: string;
};
export type ActPerformance = { act: string; matches: number; tier: number | null; metrics: PlayerMetrics | null };
export type ActPerformanceResult = { scope: AnalyticsScope; acts: ActPerformance[] };
export type AgentPerformance = { agent: string; matches: number; wins: number; winRate: number; metrics: PlayerMetrics };
export type AgentPerformanceResult = { scope: AnalyticsScope; agents: AgentPerformance[] };
export type EconomyPerformance = { category: string; rounds: number; wins: number; winRate: number };
export type EconomyPerformanceResult = { scope: AnalyticsScope; categories: EconomyPerformance[] };
export type KnowledgeResult = { chunkId: string; sourceId: string; title: string; content: string; evidenceText: string; mapName?: string; side?: string; topics: string[]; patchVersion?: string; sourceTrust: string; sourceUrl: string };
export type TrainingMemory = {
  id: string; kind: "goal" | "summary"; content: string; sourceRunId?: string;
  createdAt: string; updatedAt: string;
  provider?: "mem0" | "postgres"; providerMemoryId?: string;
};
export type RankBenchmark = {
  available: boolean; tier: number | null; cohortPlayers: number; minimumPlayers: number;
  player: PlayerMetrics | null;
  median: Pick<PlayerMetrics, "kd" | "adr" | "acs" | "firstDeathRate"> | null;
  limitation?: string;
};

export class AnalyticsReader {
  constructor(private readonly pool: Pool, private readonly knowledgeRag?: KnowledgeRagClient, private readonly memoryProvider?: MemoryProvider) {}

  async getRiotAccountId(userId: string): Promise<string | null> {
    const result = await this.pool.query<{ id: string }>("SELECT id FROM riot_accounts WHERE user_id = $1 LIMIT 1", [userId]);
    return result.rows[0]?.id ?? null;
  }

  async findActiveSyncJob(userId: string): Promise<SyncJob | null> {
    const result = await this.pool.query<SyncJobRow>(
      "SELECT * FROM sync_jobs WHERE user_id = $1 AND status IN ('queued', 'running') ORDER BY created_at DESC LIMIT 1", [userId]
    );
    return result.rows[0] ? toSyncJob(result.rows[0]) : null;
  }

  async createSyncJob(jobId: string, userId: string, riotAccountId: string): Promise<SyncJob> {
    const result = await this.pool.query<SyncJobRow>(
      `INSERT INTO sync_jobs (job_id, user_id, riot_account_id, status)
       VALUES ($1, $2, $3, 'queued') RETURNING *`, [jobId, userId, riotAccountId]
    );
    return toSyncJob(result.rows[0]);
  }

  async getSyncJob(userId: string, jobId: string): Promise<SyncJob | null> {
    const result = await this.pool.query<SyncJobRow>("SELECT * FROM sync_jobs WHERE user_id = $1 AND job_id = $2", [userId, jobId]);
    return result.rows[0] ? toSyncJob(result.rows[0]) : null;
  }

  async updateSyncJob(jobId: string, patch: {
    status: SyncJobStatus; imported?: number; skipped?: number; failedMatchIds?: string[];
    errorCode?: string | null; errorMessage?: string | null; completed?: boolean;
  }): Promise<void> {
    await this.pool.query(
      `UPDATE sync_jobs SET status = $2, imported = COALESCE($3, imported), skipped = COALESCE($4, skipped),
        failed_match_ids = COALESCE($5::jsonb, failed_match_ids), error_code = $6,
        error_message = $7, updated_at = now(), completed_at = CASE WHEN $8 THEN now() ELSE completed_at END
       WHERE job_id = $1`,
      [jobId, patch.status, patch.imported ?? null, patch.skipped ?? null,
        patch.failedMatchIds ? JSON.stringify(patch.failedMatchIds) : null, patch.errorCode ?? null,
        patch.errorMessage ?? null, patch.completed ?? false]
    );
  }

  async getTrainingMemories(userId: string): Promise<TrainingMemory[]> {
    const result = await this.pool.query<MemoryRow>(
      "SELECT id, kind, content, source_run_id, provider, provider_memory_id, created_at, updated_at FROM training_memories WHERE user_id = $1 ORDER BY updated_at DESC", [userId]
    );
    return result.rows.map(toTrainingMemory);
  }

  async createTrainingMemory(userId: string, kind: "goal" | "summary", content: string, sourceRunId?: string): Promise<TrainingMemory> {
    const id = randomUUID();
    const result = await this.pool.query<MemoryRow>(
      `INSERT INTO training_memories (id, user_id, kind, content, source_run_id, provider)
       VALUES ($1, $2, $3, $4, $5, 'postgres')
       RETURNING id, kind, content, source_run_id, provider, provider_memory_id, created_at, updated_at`,
      [id, userId, kind, content, sourceRunId ?? null]
    );
    const memory = toTrainingMemory(result.rows[0]);
    if (!this.memoryProvider) return memory;
    let providerMemoryId: string | undefined;
    try {
      providerMemoryId = await this.memoryProvider.add({ userId: scopedMemoryUserId(userId), memoryId: id, kind, content, sourceRunId });
      await this.pool.query("UPDATE training_memories SET provider = 'mem0', provider_memory_id = $3, updated_at = now() WHERE user_id = $1 AND id = $2", [userId, id, providerMemoryId]);
      return { ...memory, provider: "mem0", providerMemoryId };
    } catch (error) {
      if (providerMemoryId) await this.memoryProvider.delete(providerMemoryId).catch(() => undefined);
      console.warn("Mem0 add failed; keeping PostgreSQL memory", error instanceof Error ? error.message : error);
      return memory;
    }
  }

  async updateTrainingMemory(userId: string, id: string, kind: "goal" | "summary", content: string): Promise<TrainingMemory | null> {
    const result = await this.pool.query<MemoryRow>(
      `UPDATE training_memories SET kind = $3, content = $4, updated_at = now()
       WHERE user_id = $1 AND id = $2
       RETURNING id, kind, content, source_run_id, provider, provider_memory_id, created_at, updated_at`, [userId, id, kind, content]
    );
    const memory = result.rows[0] ? toTrainingMemory(result.rows[0]) : null;
    if (!memory || !this.memoryProvider || memory.provider !== "mem0" || !memory.providerMemoryId) return memory;
    let nextProviderMemoryId: string | undefined;
    try {
      nextProviderMemoryId = await this.memoryProvider.add({ userId: scopedMemoryUserId(userId), memoryId: id, kind, content, sourceRunId: memory.sourceRunId });
      await this.memoryProvider.delete(memory.providerMemoryId);
      await this.pool.query("UPDATE training_memories SET provider_memory_id = $3, updated_at = now() WHERE user_id = $1 AND id = $2", [userId, id, nextProviderMemoryId]);
      return { ...memory, providerMemoryId: nextProviderMemoryId };
    } catch (error) {
      if (nextProviderMemoryId) await this.memoryProvider.delete(nextProviderMemoryId).catch(() => undefined);
      console.warn("Mem0 update failed; PostgreSQL memory remains available", error instanceof Error ? error.message : error);
      return memory;
    }
  }

  async deleteTrainingMemory(userId: string, id: string): Promise<boolean> {
    const existing = await this.pool.query<MemoryRow>("SELECT id, kind, content, source_run_id, provider, provider_memory_id, created_at, updated_at FROM training_memories WHERE user_id = $1 AND id = $2", [userId, id]);
    const providerMemoryId = existing.rows[0]?.provider === "mem0" ? existing.rows[0].provider_memory_id : null;
    const result = await this.pool.query("DELETE FROM training_memories WHERE user_id = $1 AND id = $2", [userId, id]);
    if (providerMemoryId && this.memoryProvider) {
      try { await this.memoryProvider.delete(providerMemoryId); }
      catch (error) { console.warn("Mem0 delete failed after local deletion", error instanceof Error ? error.message : error); }
    }
    return result.rowCount === 1;
  }

  async deleteAllTrainingMemories(userId: string): Promise<void> {
    await this.pool.query("DELETE FROM training_memories WHERE user_id = $1", [userId]);
    if (this.memoryProvider) {
      try { await this.memoryProvider.deleteAll(scopedMemoryUserId(userId)); }
      catch (error) { console.warn("Mem0 delete-all failed after local deletion", error instanceof Error ? error.message : error); }
    }
  }

  async hasCompletedAgentRun(userId: string, runId: string): Promise<boolean> {
    const result = await this.pool.query(
      "SELECT 1 FROM agent_runs WHERE run_id = $1 AND user_id = $2 AND status = 'completed' LIMIT 1",
      [runId, userId]
    );
    return result.rowCount === 1;
  }

  async getTrainingMemory(userId: string, query?: string): Promise<{ memories: TrainingMemory[]; limitation: string }> {
    const localMemories = await this.getTrainingMemories(userId);
    if (!this.memoryProvider || !query?.trim()) return { memories: localMemories, limitation: "Training memory is user-provided context, not match evidence." };
    try {
      const results = await this.memoryProvider.search(scopedMemoryUserId(userId), query.trim(), 10);
      const byProviderId = new Map(localMemories.filter((memory) => memory.providerMemoryId).map((memory) => [memory.providerMemoryId!, memory]));
      const memories = results.flatMap((result) => {
        const local = byProviderId.get(result.providerMemoryId);
        return local ? [mapProviderResultToMemory(result, local)] : [];
      });
      return { memories, limitation: "Training memory was semantically retrieved for the current account; it is user-provided context, not match evidence." };
    } catch (error) {
      console.warn("Mem0 search failed; using PostgreSQL memories", error instanceof Error ? error.message : error);
      return { memories: localMemories, limitation: "Mem0 was unavailable, so PostgreSQL memory was used; memory is user-provided context, not match evidence." };
    }
  }

  async getActPerformance(userId: string): Promise<ActPerformanceResult> {
    const result = await this.pool.query<{ act: string; matches: string; tier: number | null; kills: string; deaths: string; score: string; rounds: string; damage: string; hs: string; body: string; legs: string; first_deaths: string; first_kills: string; kast: string; start: string | null; end: string | null }>(
      `SELECT COALESCE(matches.season_id, 'unknown') AS act, COUNT(DISTINCT stats.match_id) AS matches,
        MAX(stats.competitive_tier) AS tier, SUM(stats.kills) AS kills, SUM(stats.deaths) AS deaths,
        SUM(stats.score) AS score, SUM(stats.rounds_played) AS rounds, COALESCE(SUM(d.damage),0) AS damage,
        COALESCE(SUM(d.headshots),0) AS hs, COALESCE(SUM(d.bodyshots),0) AS body, COALESCE(SUM(d.legshots),0) AS legs,
        COALESCE(SUM(a.first_deaths),0) AS first_deaths, COALESCE(SUM(a.first_kills),0) AS first_kills,
        COALESCE(SUM(a.kast_rounds),0) AS kast, MIN(matches.game_start_millis) AS start, MAX(matches.game_start_millis) AS end
       FROM riot_accounts accounts JOIN player_match_stats stats ON stats.riot_account_id = accounts.id
       JOIN matches ON matches.match_id = stats.match_id
       LEFT JOIN LATERAL (SELECT SUM(rd.damage) damage, SUM(rd.headshots) headshots, SUM(rd.bodyshots) bodyshots, SUM(rd.legshots) legshots FROM round_damage rd WHERE rd.match_id=stats.match_id AND rd.riot_account_id=accounts.id) d ON TRUE
       LEFT JOIN LATERAL (SELECT COUNT(*) FILTER (WHERE rk.was_first_death) first_deaths, COUNT(*) FILTER (WHERE rk.was_first_kill) first_kills, COUNT(*) FILTER (WHERE NOT rk.was_victim OR rk.was_killer_or_assist) kast_rounds FROM (SELECT prs.round_number, COALESCE(bool_or(k.is_victim),FALSE) was_victim, COALESCE(bool_or(k.is_killer OR k.is_assistant),FALSE) was_killer_or_assist, COALESCE(bool_or(k.is_first_death),FALSE) was_first_death, COALESCE(bool_or(k.is_first_kill),FALSE) was_first_kill FROM player_round_stats prs LEFT JOIN round_kills k ON k.match_id=prs.match_id AND k.riot_account_id=prs.riot_account_id AND k.round_number=prs.round_number WHERE prs.match_id=stats.match_id AND prs.riot_account_id=accounts.id GROUP BY prs.round_number) rk) a ON TRUE
       WHERE accounts.user_id=$1 AND matches.queue_id=$2 AND matches.is_ranked=TRUE AND matches.is_completed=TRUE
       GROUP BY COALESCE(matches.season_id, 'unknown') ORDER BY start DESC`, [userId, COMPETITIVE_QUEUE_ID]
    );
    const timestamps = result.rows.flatMap((row) => [row.start, row.end].filter((value): value is string => value !== null)).map(Number);
    return { scope: makeScope(result.rows.reduce((sum, row) => sum + Number(row.matches), 0), timestamps.length ? String(Math.min(...timestamps)) : null, timestamps.length ? String(Math.max(...timestamps)) : null), acts: result.rows.map((row) => ({ act: row.act, matches: Number(row.matches), tier: row.tier, metrics: Number(row.rounds) ? calculatePlayerMetrics({ score: Number(row.score), roundsPlayed: Number(row.rounds), kills: Number(row.kills), deaths: Number(row.deaths), totalDamage: Number(row.damage), headshots: Number(row.hs), bodyshots: Number(row.body), legshots: Number(row.legs), firstDeaths: Number(row.first_deaths), firstKills: Number(row.first_kills), roundsWithKast: Number(row.kast) }) : null })) };
  }

  async getAgentPerformance(userId: string): Promise<AgentPerformanceResult> {
    const result = await this.pool.query<{ agent: string | null; matches: string; wins: string; kills: string; deaths: string; score: string; rounds: string; damage: string; hs: string; body: string; legs: string; first_deaths: string; start: string | null; end: string | null }>(
      `SELECT COALESCE(stats.character_id,'Unknown agent') agent, COUNT(*) matches,
        COUNT(*) FILTER (WHERE wins.won) wins, SUM(stats.kills) kills, SUM(stats.deaths) deaths, SUM(stats.score) score,
        SUM(stats.rounds_played) rounds, COALESCE(SUM(d.damage),0) damage, COALESCE(SUM(d.headshots),0) hs,
        COALESCE(SUM(d.bodyshots),0) body, COALESCE(SUM(d.legshots),0) legs, COALESCE(SUM(fd.count),0) first_deaths,
        MIN(matches.game_start_millis) start, MAX(matches.game_start_millis) end
       FROM riot_accounts accounts JOIN player_match_stats stats ON stats.riot_account_id=accounts.id
       JOIN matches ON matches.match_id=stats.match_id
       LEFT JOIN LATERAL (SELECT COUNT(*) FILTER (WHERE rounds.winning_team=stats.team_id) > COUNT(*) FILTER (WHERE rounds.winning_team<>stats.team_id) won FROM match_rounds rounds WHERE rounds.match_id=matches.match_id) wins ON TRUE
        LEFT JOIN LATERAL (SELECT SUM(rd.damage) damage, SUM(rd.headshots) headshots, SUM(rd.bodyshots) bodyshots, SUM(rd.legshots) legshots FROM round_damage rd WHERE rd.match_id=stats.match_id AND rd.riot_account_id=accounts.id) d ON TRUE
       LEFT JOIN LATERAL (SELECT COUNT(*) count FROM round_kills rk WHERE rk.match_id=stats.match_id AND rk.riot_account_id=accounts.id AND rk.is_first_death) fd ON TRUE
       WHERE accounts.user_id=$1 AND matches.queue_id=$2 AND matches.is_ranked=TRUE AND matches.is_completed=TRUE
       GROUP BY stats.character_id ORDER BY matches DESC, agent`, [userId, COMPETITIVE_QUEUE_ID]
    );
    const timestamps = result.rows.flatMap((row) => [row.start, row.end].filter((value): value is string => value !== null)).map(Number);
    return { scope: makeScope(result.rows.reduce((sum, row) => sum + Number(row.matches), 0), timestamps.length ? String(Math.min(...timestamps)) : null, timestamps.length ? String(Math.max(...timestamps)) : null), agents: result.rows.map((row) => ({ agent: row.agent ?? "Unknown agent", matches: Number(row.matches), wins: Number(row.wins), winRate: percentage(Number(row.wins), Number(row.matches)), metrics: calculatePlayerMetrics({ score: Number(row.score), roundsPlayed: Number(row.rounds), kills: Number(row.kills), deaths: Number(row.deaths), totalDamage: Number(row.damage), headshots: Number(row.hs), bodyshots: Number(row.body), legshots: Number(row.legs), firstDeaths: Number(row.first_deaths) }) })) };
  }

  async getEconomyPerformance(userId: string): Promise<EconomyPerformanceResult> {
    const result = await this.pool.query<{ match_id: string; round_number: number; winning_team: string | null; team_id: string | null; economy: unknown }>(
      `SELECT prs.match_id, prs.round_number, rounds.winning_team, stats.team_id, prs.economy
       FROM riot_accounts accounts JOIN player_match_stats stats ON stats.riot_account_id=accounts.id
       JOIN matches ON matches.match_id=stats.match_id JOIN player_round_stats prs ON prs.match_id=stats.match_id AND prs.riot_account_id=accounts.id
       JOIN match_rounds rounds ON rounds.match_id=prs.match_id AND rounds.round_number=prs.round_number
       WHERE accounts.user_id=$1 AND matches.queue_id=$2 AND matches.is_ranked=TRUE AND matches.is_completed=TRUE`, [userId, COMPETITIVE_QUEUE_ID]
    );
    const categories = new Map<string, { rounds: number; wins: number; available: boolean }>();
    for (const row of result.rows) {
      const economy = row.economy && typeof row.economy === "object" ? row.economy as Record<string, unknown> : {};
      const value = Number(economy.loadoutValue ?? economy.loadout_value ?? economy.spent ?? economy.spentCredits);
      const category = Number.isFinite(value) && value > 0 ? value >= 3900 ? "full_buy" : value >= 2000 ? "half_buy" : "low_buy" : "unavailable";
      const current = categories.get(category) ?? { rounds: 0, wins: 0, available: category !== "unavailable" };
      current.rounds += 1; current.wins += row.winning_team === row.team_id ? 1 : 0; categories.set(category, current);
    }
    return { scope: makeScope(new Set(result.rows.map((row) => row.match_id)).size, null, null), categories: [...categories].map(([category, value]) => ({ category, ...value, winRate: percentage(value.wins, value.rounds) })) };
  }

  async searchKnowledge(userId: string, query: string, mapName?: string, side?: "attack" | "defense", limit = 5): Promise<{ query: string; results: KnowledgeResult[]; limitation: string }> {
    const hybrid = await this.knowledgeRag?.search(query, { mapName, side }, Math.min(10, Math.max(1, limit)));
    if (hybrid?.hits.length) {
      const ids = hybrid.hits.map((hit) => hit.chunkId);
      const indexed = await this.pool.query<KnowledgeRow>(
        `SELECT c.chunk_id, c.source_id, c.title, c.content, c.evidence_text, c.map_name, c.side, c.topics, c.patch_version, c.source_trust, s.url
         FROM knowledge_chunks c JOIN knowledge_sources s ON s.source_id=c.source_id
         WHERE c.chunk_id = ANY($1::uuid[]) AND c.review_status='approved' AND c.withdrawn_at IS NULL AND (c.stale_at IS NULL OR c.stale_at > now()) AND s.status IN ('reviewed','approved')`, [ids]
      );
      const byId = new Map(indexed.rows.map((row) => [row.chunk_id, toKnowledge(row)]));
      const results = ids.flatMap((id) => byId.get(id) ?? []);
      if (results.length) return { query, results, limitation: `知识内容是通用教学背景，不是当前玩家比赛事实。检索路径：${hybrid.hits[0].path}；索引：${hybrid.indexVersion}${hybrid.limitations.length ? `；限制：${hybrid.limitations.join(" ")}` : ""}` };
    }
    const result = await this.pool.query<KnowledgeRow>(
      `SELECT c.chunk_id, c.source_id, c.title, c.content, c.evidence_text, c.map_name, c.side, c.topics, c.patch_version, c.source_trust, s.url
       FROM knowledge_chunks c JOIN knowledge_sources s ON s.source_id=c.source_id
       WHERE c.review_status='approved' AND c.withdrawn_at IS NULL AND (c.stale_at IS NULL OR c.stale_at > now()) AND s.status IN ('reviewed','approved')
         AND ($1='' OR c.search_vector @@ plainto_tsquery('simple',$1) OR c.content ILIKE '%' || $1 || '%')
         AND ($2::text IS NULL OR c.map_name=$2) AND ($3::text IS NULL OR c.side=$3)
       ORDER BY ts_rank(c.search_vector, plainto_tsquery('simple',$1)) DESC, c.updated_at DESC LIMIT $4`, [query.trim(), mapName ?? null, side ?? null, Math.min(10, Math.max(1, limit))]
    );
    return { query, results: result.rows.map(toKnowledge), limitation: "知识内容是通用教学背景，不是当前玩家比赛事实。当前使用 PostgreSQL 全文降级检索。" };
  }

  async getRankBenchmark(userId: string): Promise<RankBenchmark> {
    const tierResult = await this.pool.query<{ competitive_tier: number | null }>(
      `SELECT stats.competitive_tier FROM riot_accounts accounts
       JOIN player_match_stats stats ON stats.riot_account_id = accounts.id
       JOIN matches ON matches.match_id = stats.match_id
       WHERE accounts.user_id = $1 AND accounts.is_demo = FALSE AND matches.queue_id = $2 AND matches.is_ranked = TRUE AND matches.is_completed = TRUE
       ORDER BY matches.game_start_millis DESC NULLS LAST LIMIT 1`, [userId, COMPETITIVE_QUEUE_ID]
    );
    const tier = tierResult.rows[0]?.competitive_tier ?? null;
    const minimumPlayers = 5;
    if (tier === null) return { available: false, tier, cohortPlayers: 0, minimumPlayers, player: null, median: null, limitation: "No competitive tier is available for the current account." };
    const cohort = await this.pool.query<{ cohort_players: string; kd: number | null; adr: number | null; acs: number | null; first_death_rate: number | null }>(
      `WITH per_user AS (
        SELECT accounts.user_id, COUNT(DISTINCT stats.match_id) AS matches,
          MAX(stats.competitive_tier) AS tier,
          SUM(stats.kills)::numeric / NULLIF(SUM(stats.deaths), 0) AS kd,
          SUM(COALESCE(damage.damage, 0))::numeric / NULLIF(SUM(stats.rounds_played), 0) AS adr,
          SUM(stats.score)::numeric / NULLIF(SUM(stats.rounds_played), 0) AS acs,
          SUM(COALESCE(first_deaths.count, 0))::numeric / NULLIF(SUM(stats.rounds_played), 0) * 100 AS first_death_rate
        FROM riot_accounts accounts JOIN player_match_stats stats ON stats.riot_account_id = accounts.id
        JOIN matches ON matches.match_id = stats.match_id
        LEFT JOIN LATERAL (SELECT SUM(rd.damage) AS damage FROM round_damage rd WHERE rd.match_id = stats.match_id AND rd.riot_account_id = accounts.id) damage ON TRUE
        LEFT JOIN LATERAL (SELECT COUNT(*) AS count FROM round_kills rk WHERE rk.match_id = stats.match_id AND rk.riot_account_id = accounts.id AND rk.is_first_death = TRUE) first_deaths ON TRUE
        WHERE accounts.is_demo = FALSE AND matches.queue_id = $1 AND matches.is_ranked = TRUE AND matches.is_completed = TRUE
        GROUP BY accounts.user_id
      )
      SELECT COUNT(*) FILTER (WHERE matches >= $3 AND tier = $2) AS cohort_players,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY kd) FILTER (WHERE matches >= $3 AND tier = $2) AS kd,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY adr) FILTER (WHERE matches >= $3 AND tier = $2) AS adr,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY acs) FILTER (WHERE matches >= $3 AND tier = $2) AS acs,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY first_death_rate) FILTER (WHERE matches >= $3 AND tier = $2) AS first_death_rate
      FROM per_user`, [COMPETITIVE_QUEUE_ID, tier, minimumPlayers]
    );
    const row = cohort.rows[0];
    const cohortPlayers = Number(row?.cohort_players ?? 0);
    const player = (await this.getPlayerSummary(userId)).metrics;
    if (cohortPlayers < minimumPlayers) return { available: false, tier, cohortPlayers, minimumPlayers, player, median: null, limitation: `Only ${cohortPlayers} eligible same-tier players are available; at least ${minimumPlayers} are required.` };
    return { available: true, tier, cohortPlayers, minimumPlayers, player, median: { kd: Number(row.kd), adr: Number(row.adr), acs: Number(row.acs), firstDeathRate: Number(row.first_death_rate) } };
  }

  private async getActionTotals(userId: string, matchId?: string, from?: string, to?: string): Promise<{ firstKills: number; roundsWithKast: number }> {
    const result = await this.pool.query<{ first_kills: string; kast_rounds: string }>(
      `SELECT COUNT(*) FILTER (WHERE flags.was_first_kill) AS first_kills,
        COUNT(*) FILTER (WHERE NOT flags.was_victim OR flags.was_killer_or_assist) AS kast_rounds
       FROM (SELECT prs.match_id, prs.round_number, COALESCE(bool_or(rk.is_victim), FALSE) AS was_victim,
         COALESCE(bool_or(rk.is_killer OR rk.is_assistant), FALSE) AS was_killer_or_assist,
         COALESCE(bool_or(rk.is_first_kill), FALSE) AS was_first_kill
         FROM riot_accounts accounts JOIN player_round_stats prs ON prs.riot_account_id=accounts.id
         LEFT JOIN round_kills rk ON rk.match_id=prs.match_id AND rk.riot_account_id=prs.riot_account_id AND rk.round_number=prs.round_number
         JOIN matches ON matches.match_id=prs.match_id
         WHERE accounts.user_id=$1 AND matches.queue_id=$2 AND matches.is_ranked=TRUE AND matches.is_completed=TRUE
           AND ($3::varchar IS NULL OR matches.match_id=$3)
           AND ($4::bigint IS NULL OR matches.game_start_millis >= $4)
           AND ($5::bigint IS NULL OR matches.game_start_millis <= $5)
         GROUP BY prs.match_id, prs.round_number) flags`,
      [userId, COMPETITIVE_QUEUE_ID, matchId ?? null, from ? Date.parse(from) : null, to ? Date.parse(to) : null]
    );
    return { firstKills: Number(result.rows[0]?.first_kills ?? 0), roundsWithKast: Number(result.rows[0]?.kast_rounds ?? 0) };
  }

  async getPlayerSummary(userId: string): Promise<PlayerSummary> {
    const result = await this.pool.query<{
      match_count: string; period_start: string | null; period_end: string | null; kills: string; deaths: string;
      score: string; rounds_played: string; damage: string; headshots: string; bodyshots: string; legshots: string; first_deaths: string;
    }>(
      `SELECT COUNT(DISTINCT stats.match_id) AS match_count, MIN(matches.game_start_millis) AS period_start,
        MAX(matches.game_start_millis) AS period_end, COALESCE(SUM(stats.kills), 0) AS kills,
        COALESCE(SUM(stats.deaths), 0) AS deaths, COALESCE(SUM(stats.score), 0) AS score,
        COALESCE(SUM(stats.rounds_played), 0) AS rounds_played, COALESCE(SUM(damage.damage), 0) AS damage,
        COALESCE(SUM(damage.headshots), 0) AS headshots, COALESCE(SUM(damage.bodyshots), 0) AS bodyshots,
        COALESCE(SUM(damage.legshots), 0) AS legshots, COALESCE(SUM(first_deaths.count), 0) AS first_deaths
      FROM riot_accounts accounts
      JOIN player_match_stats stats ON stats.riot_account_id = accounts.id
      JOIN matches ON matches.match_id = stats.match_id
      LEFT JOIN LATERAL (SELECT SUM(round_damage.damage) AS damage, SUM(round_damage.headshots) AS headshots,
        SUM(round_damage.bodyshots) AS bodyshots, SUM(round_damage.legshots) AS legshots FROM round_damage
        WHERE round_damage.match_id = stats.match_id AND round_damage.riot_account_id = accounts.id) damage ON TRUE
      LEFT JOIN LATERAL (SELECT COUNT(*) AS count FROM round_kills WHERE round_kills.match_id = stats.match_id
        AND round_kills.riot_account_id = accounts.id AND round_kills.is_first_death = TRUE) first_deaths ON TRUE
      WHERE accounts.user_id = $1 AND matches.queue_id = $2 AND matches.is_ranked = TRUE AND matches.is_completed = TRUE`,
      [userId, COMPETITIVE_QUEUE_ID]
    );
    const row = result.rows[0];
    const sampleSize = Number(row.match_count);
    const scope = makeScope(sampleSize, row.period_start, row.period_end);
    if (!sampleSize || !Number(row.rounds_played)) return { scope, metrics: null };
    const actionTotals = await this.getActionTotals(userId);
    return {
      scope,
      metrics: calculatePlayerMetrics({
        score: Number(row.score), roundsPlayed: Number(row.rounds_played), kills: Number(row.kills), deaths: Number(row.deaths),
        totalDamage: Number(row.damage), headshots: Number(row.headshots), bodyshots: Number(row.bodyshots),
        legshots: Number(row.legshots), firstDeaths: Number(row.first_deaths), firstKills: actionTotals.firstKills, roundsWithKast: actionTotals.roundsWithKast
      })
    };
  }

  async getTimeWindow(userId: string, from: string, to: string): Promise<TimeWindowResult> {
    const result = await this.pool.query<{ match_count: string; period_start: string | null; period_end: string | null; kills: string; deaths: string; score: string; rounds_played: string; damage: string; headshots: string; bodyshots: string; legshots: string; first_deaths: string }>(
      `SELECT COUNT(DISTINCT stats.match_id) match_count, MIN(matches.game_start_millis) period_start, MAX(matches.game_start_millis) period_end,
        COALESCE(SUM(stats.kills),0) kills, COALESCE(SUM(stats.deaths),0) deaths, COALESCE(SUM(stats.score),0) score, COALESCE(SUM(stats.rounds_played),0) rounds_played,
        COALESCE(SUM(d.damage),0) damage, COALESCE(SUM(d.headshots),0) headshots, COALESCE(SUM(d.bodyshots),0) bodyshots, COALESCE(SUM(d.legshots),0) legshots, COALESCE(SUM(fd.count),0) first_deaths
       FROM riot_accounts accounts JOIN player_match_stats stats ON stats.riot_account_id=accounts.id JOIN matches ON matches.match_id=stats.match_id
       LEFT JOIN LATERAL (SELECT SUM(rd.damage) damage, SUM(rd.headshots) headshots, SUM(rd.bodyshots) bodyshots, SUM(rd.legshots) legshots FROM round_damage rd WHERE rd.match_id=stats.match_id AND rd.riot_account_id=accounts.id) d ON TRUE
       LEFT JOIN LATERAL (SELECT COUNT(*) count FROM round_kills rk WHERE rk.match_id=stats.match_id AND rk.riot_account_id=accounts.id AND rk.is_first_death) fd ON TRUE
       WHERE accounts.user_id=$1 AND matches.queue_id=$2 AND matches.is_ranked=TRUE AND matches.is_completed=TRUE AND matches.game_start_millis BETWEEN $3 AND $4`,
      [userId, COMPETITIVE_QUEUE_ID, Date.parse(from), Date.parse(to)]
    );
    const row = result.rows[0]; const sampleSize = Number(row.match_count); const scope = makeScope(sampleSize, row.period_start, row.period_end);
    if (!sampleSize || !Number(row.rounds_played)) return { scope, metrics: null };
    const actionTotals = await this.getActionTotals(userId, undefined, from, to);
    return { scope, metrics: calculatePlayerMetrics({ score: Number(row.score), roundsPlayed: Number(row.rounds_played), kills: Number(row.kills), deaths: Number(row.deaths), totalDamage: Number(row.damage), headshots: Number(row.headshots), bodyshots: Number(row.bodyshots), legshots: Number(row.legshots), firstDeaths: Number(row.first_deaths), firstKills: actionTotals.firstKills, roundsWithKast: actionTotals.roundsWithKast }) };
  }

  async getRoundEvidence(userId: string, matchId: string, roundNumber: number): Promise<RoundEvidenceResult> {
    const result = await this.pool.query<{
      is_killer: boolean; is_victim: boolean; is_assistant: boolean; is_first_death: boolean;
      round_time_millis: number | null; finishing_item: string | null;
    }>(
      `SELECT kills.is_killer, kills.is_victim, kills.is_assistant, kills.is_first_death, kills.round_time_millis, kills.finishing_item
       FROM riot_accounts accounts JOIN player_match_stats stats ON stats.riot_account_id = accounts.id
       JOIN matches ON matches.match_id = stats.match_id JOIN round_kills kills ON kills.match_id = stats.match_id
         AND kills.riot_account_id = accounts.id
       WHERE accounts.user_id = $1 AND matches.match_id = $2 AND kills.round_number = $3
         AND matches.queue_id = $4 AND matches.is_ranked = TRUE AND matches.is_completed = TRUE
       ORDER BY kills.game_time_millis NULLS LAST, kills.kill_index`,
      [userId, matchId, roundNumber, COMPETITIVE_QUEUE_ID]
    );
    const evidence = result.rows.map((row) => toEvidence(matchId, roundNumber, row));
    return { scope: makeScope(evidence.length ? 1 : 0, null, null), evidence };
  }

  async findRoundEvidence(userId: string, eventType: RoundEventType, limit: number): Promise<RoundEvidenceResult> {
    const result = await this.pool.query<{
      match_id: string; round_number: number; is_killer: boolean; is_victim: boolean; is_assistant: boolean;
      is_first_death: boolean; round_time_millis: number | null; finishing_item: string | null;
    }>(
      `SELECT kills.match_id, kills.round_number, kills.is_killer, kills.is_victim, kills.is_assistant,
        kills.is_first_death, kills.round_time_millis, kills.finishing_item
       FROM riot_accounts accounts
       JOIN player_match_stats stats ON stats.riot_account_id = accounts.id
       JOIN matches ON matches.match_id = stats.match_id
       JOIN round_kills kills ON kills.match_id = stats.match_id AND kills.riot_account_id = accounts.id
       WHERE accounts.user_id = $1 AND matches.queue_id = $2 AND matches.is_ranked = TRUE
         AND matches.is_completed = TRUE AND CASE $3
           WHEN 'first_death' THEN kills.is_first_death
           WHEN 'death' THEN kills.is_victim
           WHEN 'kill' THEN kills.is_killer
           WHEN 'assist' THEN kills.is_assistant
           ELSE FALSE END
       ORDER BY matches.game_start_millis DESC NULLS LAST, kills.round_number DESC
       LIMIT $4`,
      [userId, COMPETITIVE_QUEUE_ID, eventType, limit]
    );
    const evidence = result.rows.map((row) => toEvidence(row.match_id, row.round_number, row));
    return { scope: makeScope(evidence.length, null, null), evidence };
  }

  async getMatchList(userId: string, limit: number): Promise<MatchList> {
    const result = await this.pool.query<{
      match_id: string; map_id: string | null; game_start_millis: string | null; team_id: string | null;
      wins: string; losses: string; sample_size: string; period_start: string | null; period_end: string | null;
    }>(
      `SELECT matches.match_id, matches.map_id, matches.game_start_millis, stats.team_id,
        COUNT(rounds.round_number) FILTER (WHERE rounds.winning_team = stats.team_id) AS wins,
        COUNT(rounds.round_number) FILTER (WHERE rounds.winning_team <> stats.team_id) AS losses,
        COUNT(*) OVER () AS sample_size, MIN(matches.game_start_millis) OVER () AS period_start,
        MAX(matches.game_start_millis) OVER () AS period_end
      FROM riot_accounts accounts
      JOIN player_match_stats stats ON stats.riot_account_id = accounts.id
      JOIN matches ON matches.match_id = stats.match_id
      LEFT JOIN match_rounds rounds ON rounds.match_id = matches.match_id
      WHERE accounts.user_id = $1 AND matches.queue_id = $2 AND matches.is_ranked = TRUE AND matches.is_completed = TRUE
      GROUP BY matches.match_id, matches.map_id, matches.game_start_millis, stats.team_id
      ORDER BY matches.game_start_millis DESC NULLS LAST, matches.match_id
      LIMIT $3`,
      [userId, COMPETITIVE_QUEUE_ID, limit]
    );
    const first = result.rows[0];
    return {
      scope: makeScope(first ? Number(first.sample_size) : 0, first?.period_start ?? null, first?.period_end ?? null),
      matches: result.rows.map((row) => ({
        matchId: row.match_id,
        mapName: row.map_id ?? "Unknown map",
        playedAt: row.game_start_millis ? new Date(Number(row.game_start_millis)).toISOString() : "Unknown time",
        result: Number(row.wins) > Number(row.losses) ? "win" : "loss"
      }))
    };
  }

  async getMatchDetail(userId: string, matchId: string): Promise<MatchDetailResult> {
    const result = await this.pool.query<{
      match_id: string; map_id: string | null; game_start_millis: string | null; team_id: string | null;
      score: string; rounds_played: string; kills: string; deaths: string; assists: string;
      rounds_won: string; rounds_lost: string; damage: string; headshots: string; bodyshots: string; legshots: string; first_deaths: string;
    }>(
      `SELECT matches.match_id, matches.map_id, matches.game_start_millis, stats.team_id, stats.score,
        stats.rounds_played, stats.kills, stats.deaths, stats.assists,
        COUNT(DISTINCT rounds.round_number) FILTER (WHERE rounds.winning_team = stats.team_id) AS rounds_won,
        COUNT(DISTINCT rounds.round_number) FILTER (WHERE rounds.winning_team <> stats.team_id) AS rounds_lost,
        COALESCE(damage.damage, 0) AS damage, COALESCE(damage.headshots, 0) AS headshots,
        COALESCE(damage.bodyshots, 0) AS bodyshots, COALESCE(damage.legshots, 0) AS legshots,
        COALESCE(first_deaths.count, 0) AS first_deaths
       FROM riot_accounts accounts
       JOIN player_match_stats stats ON stats.riot_account_id = accounts.id
       JOIN matches ON matches.match_id = stats.match_id
       LEFT JOIN match_rounds rounds ON rounds.match_id = matches.match_id
       LEFT JOIN LATERAL (SELECT SUM(rd.damage) AS damage, SUM(rd.headshots) AS headshots,
         SUM(rd.bodyshots) AS bodyshots, SUM(rd.legshots) AS legshots FROM round_damage rd
         WHERE rd.match_id = stats.match_id AND rd.riot_account_id = accounts.id) damage ON TRUE
       LEFT JOIN LATERAL (SELECT COUNT(*) AS count FROM round_kills rk WHERE rk.match_id = stats.match_id
         AND rk.riot_account_id = accounts.id AND rk.is_first_death = TRUE) first_deaths ON TRUE
       WHERE accounts.user_id = $1 AND matches.match_id = $2 AND matches.queue_id = $3
         AND matches.is_ranked = TRUE AND matches.is_completed = TRUE
       GROUP BY matches.match_id, stats.team_id, stats.score, stats.rounds_played, stats.kills, stats.deaths,
         stats.assists, damage.damage, damage.headshots, damage.bodyshots, damage.legshots, first_deaths.count`,
      [userId, matchId, COMPETITIVE_QUEUE_ID]
    );
    const row = result.rows[0];
    if (!row) return { scope: makeScope(0, null, null), match: null };
    const roundsWon = Number(row.rounds_won);
    const roundsLost = Number(row.rounds_lost);
    const actionTotals = await this.getActionTotals(userId, matchId);
    return {
      scope: makeScope(1, row.game_start_millis, row.game_start_millis),
      match: {
        matchId: row.match_id,
        mapName: row.map_id ?? "Unknown map",
        playedAt: row.game_start_millis ? new Date(Number(row.game_start_millis)).toISOString() : "Unknown time",
        result: roundsWon > roundsLost ? "win" : "loss",
        roundsWon,
        roundsLost,
        kills: Number(row.kills),
        deaths: Number(row.deaths),
        assists: Number(row.assists),
        metrics: calculatePlayerMetrics({
          score: Number(row.score), roundsPlayed: Number(row.rounds_played), kills: Number(row.kills), deaths: Number(row.deaths),
          totalDamage: Number(row.damage), headshots: Number(row.headshots), bodyshots: Number(row.bodyshots),
          legshots: Number(row.legshots), firstDeaths: Number(row.first_deaths), firstKills: actionTotals.firstKills, roundsWithKast: actionTotals.roundsWithKast
        })
      }
    };
  }

  async compareAttackDefense(userId: string): Promise<AttackDefenseResult> {
    const result = await this.pool.query<{
      match_count: string; period_start: string | null; period_end: string | null;
      attack_played: string; attack_won: string; defense_played: string; defense_won: string;
    }>(
      `WITH classified AS (
        SELECT matches.match_id, matches.game_start_millis,
          rounds.winning_team = stats.team_id AS won,
          CASE
            WHEN rounds.winning_team = stats.team_id THEN rounds.winning_team_role
            WHEN rounds.winning_team_role = 'Attack' THEN 'Defense'
            WHEN rounds.winning_team_role = 'Defense' THEN 'Attack'
          END AS player_role
        FROM riot_accounts accounts
        JOIN player_match_stats stats ON stats.riot_account_id = accounts.id
        JOIN matches ON matches.match_id = stats.match_id
        JOIN match_rounds rounds ON rounds.match_id = matches.match_id
        WHERE accounts.user_id = $1 AND matches.queue_id = $2
          AND matches.is_ranked = TRUE AND matches.is_completed = TRUE
      )
      SELECT COUNT(DISTINCT match_id) AS match_count, MIN(game_start_millis) AS period_start,
        MAX(game_start_millis) AS period_end,
        COUNT(*) FILTER (WHERE player_role = 'Attack') AS attack_played,
        COUNT(*) FILTER (WHERE player_role = 'Attack' AND won) AS attack_won,
        COUNT(*) FILTER (WHERE player_role = 'Defense') AS defense_played,
        COUNT(*) FILTER (WHERE player_role = 'Defense' AND won) AS defense_won
      FROM classified`,
      [userId, COMPETITIVE_QUEUE_ID]
    );
    const row = result.rows[0];
    const attackPlayed = Number(row.attack_played);
    const attackWon = Number(row.attack_won);
    const defensePlayed = Number(row.defense_played);
    const defenseWon = Number(row.defense_won);
    const scope = makeScope(Number(row.match_count), row.period_start, row.period_end);
    if (attackPlayed + defensePlayed === 0 && scope.sampleSize > 0) scope.limitation = "Round side metadata is unavailable for this sample.";
    return {
      scope,
      attack: { roundsPlayed: attackPlayed, roundsWon: attackWon, winRate: percentage(attackWon, attackPlayed) },
      defense: { roundsPlayed: defensePlayed, roundsWon: defenseWon, winRate: percentage(defenseWon, defensePlayed) }
    };
  }

  async compareMapPerformance(userId: string): Promise<MapPerformanceResult> {
    const result = await this.pool.query<{
      map_name: string; match_count: string; wins: string; kills: string; deaths: string; score: string;
      rounds_played: string; damage: string; first_deaths: string; period_start: string | null; period_end: string | null;
    }>(
      `WITH per_match AS (
        SELECT matches.match_id, COALESCE(matches.map_id, 'Unknown map') AS map_name, matches.game_start_millis,
          stats.kills, stats.deaths, stats.score, stats.rounds_played,
          COUNT(rounds.round_number) FILTER (WHERE rounds.winning_team = stats.team_id) >
            COUNT(rounds.round_number) FILTER (WHERE rounds.winning_team <> stats.team_id) AS won,
          COALESCE(damage.damage, 0) AS damage, COALESCE(first_deaths.count, 0) AS first_deaths
        FROM riot_accounts accounts
        JOIN player_match_stats stats ON stats.riot_account_id = accounts.id
        JOIN matches ON matches.match_id = stats.match_id
        LEFT JOIN match_rounds rounds ON rounds.match_id = matches.match_id
        LEFT JOIN LATERAL (SELECT SUM(rd.damage) AS damage FROM round_damage rd
          WHERE rd.match_id = stats.match_id AND rd.riot_account_id = accounts.id) damage ON TRUE
        LEFT JOIN LATERAL (SELECT COUNT(*) AS count FROM round_kills rk WHERE rk.match_id = stats.match_id
          AND rk.riot_account_id = accounts.id AND rk.is_first_death = TRUE) first_deaths ON TRUE
        WHERE accounts.user_id = $1 AND matches.queue_id = $2
          AND matches.is_ranked = TRUE AND matches.is_completed = TRUE
        GROUP BY matches.match_id, stats.team_id, stats.kills, stats.deaths, stats.score, stats.rounds_played,
          damage.damage, first_deaths.count
      )
      SELECT map_name, COUNT(*) AS match_count, COUNT(*) FILTER (WHERE won) AS wins,
        SUM(kills) AS kills, SUM(deaths) AS deaths, SUM(score) AS score, SUM(rounds_played) AS rounds_played,
        SUM(damage) AS damage, SUM(first_deaths) AS first_deaths,
        MIN(game_start_millis) AS period_start, MAX(game_start_millis) AS period_end
      FROM per_match GROUP BY map_name ORDER BY COUNT(*) DESC, map_name`,
      [userId, COMPETITIVE_QUEUE_ID]
    );
    const sampleSize = result.rows.reduce((total, row) => total + Number(row.match_count), 0);
    const periodStarts = result.rows.map((row) => row.period_start).filter((value): value is string => value !== null).map(Number);
    const periodEnds = result.rows.map((row) => row.period_end).filter((value): value is string => value !== null).map(Number);
    return {
      scope: makeScope(sampleSize, periodStarts.length ? String(Math.min(...periodStarts)) : null, periodEnds.length ? String(Math.max(...periodEnds)) : null),
      maps: result.rows.map((row) => {
        const matches = Number(row.match_count);
        const wins = Number(row.wins);
        const metrics = calculatePlayerMetrics({
          score: Number(row.score), roundsPlayed: Number(row.rounds_played), kills: Number(row.kills), deaths: Number(row.deaths),
          totalDamage: Number(row.damage), headshots: 0, bodyshots: 0, legshots: 0, firstDeaths: Number(row.first_deaths)
        });
        return { mapName: row.map_name, matches, wins, losses: matches - wins, winRate: percentage(wins, matches), kd: metrics.kd, adr: metrics.adr, acs: metrics.acs, firstDeathRate: metrics.firstDeathRate };
      })
    };
  }

  async getMapRoundSummary(userId: string, mapName: string, limit: number): Promise<MapRoundSummaryResult> {
    const result = await this.pool.query<{
      match_id: string; round_number: number; player_side: "attack" | "defense"; won: boolean; round_result: string | null;
      was_first_death: boolean; match_count: string; period_start: string | null; period_end: string | null;
    }>(
      `WITH rounds_for_map AS (
        SELECT matches.match_id, matches.game_start_millis, rounds.round_number, rounds.round_result,
          rounds.winning_team = stats.team_id AS won,
          CASE WHEN rounds.winning_team = stats.team_id THEN lower(rounds.winning_team_role)
            WHEN rounds.winning_team_role = 'Attack' THEN 'defense' ELSE 'attack' END AS player_side,
          EXISTS (SELECT 1 FROM round_kills kills WHERE kills.match_id = matches.match_id AND kills.riot_account_id = accounts.id
            AND kills.round_number = rounds.round_number AND kills.is_first_death = TRUE AND kills.is_victim = TRUE) AS was_first_death
        FROM riot_accounts accounts JOIN player_match_stats stats ON stats.riot_account_id = accounts.id
        JOIN matches ON matches.match_id = stats.match_id JOIN match_rounds rounds ON rounds.match_id = matches.match_id
        WHERE accounts.user_id = $1 AND matches.map_id = $2 AND matches.queue_id = $3 AND matches.is_ranked = TRUE AND matches.is_completed = TRUE
      ), map_scope AS (
        SELECT COUNT(DISTINCT match_id) AS match_count, MIN(game_start_millis) AS period_start, MAX(game_start_millis) AS period_end FROM rounds_for_map
      ) SELECT rounds_for_map.*, map_scope.match_count, map_scope.period_start, map_scope.period_end
        FROM rounds_for_map CROSS JOIN map_scope ORDER BY match_id DESC, round_number DESC LIMIT $4`,
      [userId, mapName, COMPETITIVE_QUEUE_ID, limit]
    );
    const first = result.rows[0];
    return { scope: makeScope(first ? Number(first.match_count) : 0, first?.period_start ?? null, first?.period_end ?? null), mapName,
      matches: first ? Number(first.match_count) : 0,
      rounds: result.rows.map((row) => ({ matchId: row.match_id, roundNumber: row.round_number, side: row.player_side, won: row.won, roundResult: row.round_result, wasFirstDeath: row.was_first_death })) };
  }

  async compareRecentPeriods(userId: string, matchesPerPeriod: number): Promise<RecentPeriodComparisonResult> {
    const result = await this.pool.query<{
      game_start_millis: string; won: boolean; kills: string; deaths: string; score: string;
      rounds_played: string; damage: string; first_deaths: string;
    }>(
      `SELECT matches.game_start_millis,
        COUNT(rounds.round_number) FILTER (WHERE rounds.winning_team = stats.team_id) >
          COUNT(rounds.round_number) FILTER (WHERE rounds.winning_team <> stats.team_id) AS won,
        stats.kills, stats.deaths, stats.score, stats.rounds_played,
        COALESCE(damage.damage, 0) AS damage, COALESCE(first_deaths.count, 0) AS first_deaths
      FROM riot_accounts accounts
      JOIN player_match_stats stats ON stats.riot_account_id = accounts.id
      JOIN matches ON matches.match_id = stats.match_id
      LEFT JOIN match_rounds rounds ON rounds.match_id = matches.match_id
      LEFT JOIN LATERAL (SELECT SUM(rd.damage) AS damage FROM round_damage rd
        WHERE rd.match_id = stats.match_id AND rd.riot_account_id = accounts.id) damage ON TRUE
      LEFT JOIN LATERAL (SELECT COUNT(*) AS count FROM round_kills rk WHERE rk.match_id = stats.match_id
        AND rk.riot_account_id = accounts.id AND rk.is_first_death = TRUE) first_deaths ON TRUE
      WHERE accounts.user_id = $1 AND matches.queue_id = $2
        AND matches.is_ranked = TRUE AND matches.is_completed = TRUE
      GROUP BY matches.match_id, stats.team_id, stats.kills, stats.deaths, stats.score, stats.rounds_played,
        damage.damage, first_deaths.count
      ORDER BY matches.game_start_millis DESC NULLS LAST, matches.match_id
      LIMIT $3`,
      [userId, COMPETITIVE_QUEUE_ID, matchesPerPeriod * 2]
    );
    const recentRows = result.rows.slice(0, matchesPerPeriod);
    const previousRows = result.rows.slice(matchesPerPeriod, matchesPerPeriod * 2);
    const recent = aggregatePeriod(recentRows);
    const previous = aggregatePeriod(previousRows);
    const timestamps = result.rows.map((row) => Number(row.game_start_millis));
    const scope = makeScope(result.rows.length, timestamps.length ? String(Math.min(...timestamps)) : null, timestamps.length ? String(Math.max(...timestamps)) : null);
    if (result.rows.length > 0 && previousRows.length < matchesPerPeriod) {
      scope.limitation = `Only ${result.rows.length} completed competitive matches are available; a full ${matchesPerPeriod}-match versus ${matchesPerPeriod}-match comparison is not possible.`;
    }
    return {
      scope,
      matchesPerPeriod,
      recent,
      previous,
      deltas: recent && previous ? {
        winRate: difference(recent.winRate, previous.winRate),
        kd: difference(recent.kd, previous.kd),
        adr: difference(recent.adr, previous.adr),
        acs: difference(recent.acs, previous.acs),
        firstDeathRate: difference(recent.firstDeathRate, previous.firstDeathRate)
      } : null
    };
  }
}

type SyncJobRow = {
  job_id: string; status: SyncJobStatus; imported: number | string; skipped: number | string;
  failed_match_ids: unknown; error_code: string | null; error_message: string | null;
  created_at: Date | string; updated_at: Date | string; completed_at: Date | string | null;
};

type MemoryRow = {
  id: string; kind: "goal" | "summary"; content: string; source_run_id: string | null;
  provider?: "mem0" | "postgres" | null; provider_memory_id?: string | null;
  created_at: Date | string; updated_at: Date | string;
};
type KnowledgeRow = { chunk_id: string; source_id: string; title: string; content: string; evidence_text: string; map_name: string | null; side: string | null; topics: string[] | null; patch_version: string | null; source_trust: string; url: string };

function asIso(value: Date | string | null | undefined): string | undefined {
  return value == null ? undefined : new Date(value).toISOString();
}

function toSyncJob(row: SyncJobRow): SyncJob {
  const failedMatchIds = Array.isArray(row.failed_match_ids)
    ? row.failed_match_ids.map(String)
    : typeof row.failed_match_ids === "string"
      ? (JSON.parse(row.failed_match_ids) as unknown[]).map(String)
      : [];
  return {
    jobId: row.job_id,
    status: row.status,
    imported: Number(row.imported),
    skipped: Number(row.skipped),
    failedMatchIds,
    ...(row.error_code ? { errorCode: row.error_code } : {}),
    ...(row.error_message ? { errorMessage: row.error_message } : {}),
    createdAt: asIso(row.created_at)!,
    updatedAt: asIso(row.updated_at)!,
    ...(row.completed_at ? { completedAt: asIso(row.completed_at) } : {})
  };
}

function toTrainingMemory(row: MemoryRow): TrainingMemory {
  return {
    id: row.id,
    kind: row.kind,
    content: row.content,
    ...(row.source_run_id ? { sourceRunId: row.source_run_id } : {}),
    createdAt: asIso(row.created_at)!,
    updatedAt: asIso(row.updated_at)!,
    provider: row.provider === "mem0" ? "mem0" : "postgres",
    ...(row.provider_memory_id ? { providerMemoryId: row.provider_memory_id } : {})
  };
}

function scopedMemoryUserId(userId: string): string {
  return `valorant-analytics:${userId}`;
}

function toKnowledge(row: KnowledgeRow): KnowledgeResult {
  return { chunkId: row.chunk_id, sourceId: row.source_id, title: row.title, content: row.content, evidenceText: row.evidence_text, ...(row.map_name ? { mapName: row.map_name } : {}), ...(row.side ? { side: row.side } : {}), topics: row.topics ?? [], ...(row.patch_version ? { patchVersion: row.patch_version } : {}), sourceTrust: row.source_trust, sourceUrl: row.url };
}

function aggregatePeriod(rows: Array<{
  game_start_millis: string; won: boolean; kills: string; deaths: string; score: string;
  rounds_played: string; damage: string; first_deaths: string;
}>): PeriodPerformance | null {
  if (!rows.length) return null;
  const total = (field: "kills" | "deaths" | "score" | "rounds_played" | "damage" | "first_deaths") =>
    rows.reduce((sum, row) => sum + Number(row[field]), 0);
  const metrics = calculatePlayerMetrics({
    score: total("score"), roundsPlayed: total("rounds_played"), kills: total("kills"), deaths: total("deaths"),
    totalDamage: total("damage"), headshots: 0, bodyshots: 0, legshots: 0, firstDeaths: total("first_deaths")
  });
  const wins = rows.filter((row) => row.won).length;
  const timestamps = rows.map((row) => Number(row.game_start_millis));
  return {
    matches: rows.length,
    wins,
    losses: rows.length - wins,
    winRate: percentage(wins, rows.length),
    kd: metrics.kd,
    adr: metrics.adr,
    acs: metrics.acs,
    firstDeathRate: metrics.firstDeathRate,
    periodStart: new Date(Math.min(...timestamps)).toISOString(),
    periodEnd: new Date(Math.max(...timestamps)).toISOString()
  };
}

function difference(current: number, previous: number): number {
  return Math.round((current - previous) * 100) / 100;
}

function percentage(won: number, played: number): number {
  return played ? Math.round(won / played * 10_000) / 100 : 0;
}

function makeScope(sampleSize: number, periodStart: string | null, periodEnd: string | null): AnalyticsScope {
  return {
    queue: COMPETITIVE_QUEUE_ID,
    sampleSize,
    periodStart: periodStart ? new Date(Number(periodStart)).toISOString() : undefined,
    periodEnd: periodEnd ? new Date(Number(periodEnd)).toISOString() : undefined,
    limitation: sampleSize === 0 ? "No completed competitive matches are available." : sampleSize < 5 ? "Small sample; use this as a review signal, not a stable trend." : undefined
  };
}

function toEvidence(matchId: string, roundNumber: number, row: {
  is_killer: boolean; is_victim: boolean; is_assistant: boolean; is_first_death: boolean;
  round_time_millis: number | null; finishing_item: string | null;
}): RoundEvidence {
  const time = row.round_time_millis === null ? "" : ` at ${row.round_time_millis} ms`;
  const weapon = row.finishing_item ? ` with ${row.finishing_item}` : "";
  if (row.is_first_death) return { matchId, roundNumber, eventType: "first_death", description: `You were the first player eliminated${time}${weapon}.` };
  if (row.is_victim) return { matchId, roundNumber, eventType: "death", description: `You were eliminated${time}${weapon}.` };
  if (row.is_killer) return { matchId, roundNumber, eventType: "kill", description: `You secured a kill${time}${weapon}.` };
  return { matchId, roundNumber, eventType: "assist", description: `You assisted on a kill${time}${weapon}.` };
}
