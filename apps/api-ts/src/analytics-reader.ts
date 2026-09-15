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

  async findRoundEvidence(userId: string, eventType: "first_death", limit: number): Promise<RoundEvidenceResult> {
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
         AND matches.is_completed = TRUE AND kills.is_first_death = ($3 = 'first_death')
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
          legshots: Number(row.legshots), firstDeaths: Number(row.first_deaths)
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
