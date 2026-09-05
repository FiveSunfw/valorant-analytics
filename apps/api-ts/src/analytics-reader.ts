import type { Pool } from "pg";
import { COMPETITIVE_QUEUE_ID, calculatePlayerMetrics, type PlayerMetrics } from "@valorant/domain";

export type AnalyticsScope = {
  queue: typeof COMPETITIVE_QUEUE_ID;
  sampleSize: number;
  periodStart?: string;
  periodEnd?: string;
  limitation?: string;
};

export type PlayerSummary = { scope: AnalyticsScope; metrics: PlayerMetrics | null };
export type RoundEvidence = { matchId: string; roundNumber: number; eventType: "first_death" | "death" | "kill" | "assist"; description: string };
export type MatchSummary = { matchId: string; mapName: string; playedAt: string; result: "win" | "loss" };
export type MatchList = { scope: AnalyticsScope; matches: MatchSummary[] };
export type RoundEvidenceResult = { scope: AnalyticsScope; evidence: RoundEvidence[] };

export class AnalyticsReader {
  constructor(private readonly pool: Pool) {}

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
    return {
      scope,
      metrics: calculatePlayerMetrics({
        score: Number(row.score), roundsPlayed: Number(row.rounds_played), kills: Number(row.kills), deaths: Number(row.deaths),
        totalDamage: Number(row.damage), headshots: Number(row.headshots), bodyshots: Number(row.bodyshots),
        legshots: Number(row.legshots), firstDeaths: Number(row.first_deaths)
      })
    };
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
