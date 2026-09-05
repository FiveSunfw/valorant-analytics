import { Pool, type PoolClient } from "pg";
import {
  firstKillIdentity,
  firstKillInRound,
  isCompletedCompetitiveMatch,
  rawMatchSchema,
  type RawMatch
} from "@valorant/domain";
import { databaseUrl } from "./config.js";

export type SyncResult = { imported: number; skipped: number };

export async function persistFixtureMatches(
  riotAccountId: string,
  matchPayloads: unknown[],
  pool?: Pool
): Promise<SyncResult> {
  const ownsPool = pool === undefined;
  const activePool = pool ?? new Pool({ connectionString: databaseUrl });
  const client = await activePool.connect();
  try {
    const account = await client.query<{ puuid: string }>(
      "SELECT puuid FROM riot_accounts WHERE id = $1", [riotAccountId]
    );
    if (!account.rowCount) throw new Error("authorized Riot account was not found");
    let imported = 0;
    let skipped = 0;
    for (const payload of matchPayloads) {
      const match = rawMatchSchema.parse(payload);
      if (!isCompletedCompetitiveMatch(match) || !match.players.some((player) => player.puuid === account.rows[0].puuid)) {
        skipped += 1;
        continue;
      }
      await client.query("BEGIN");
      try {
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [match.matchInfo.matchId]);
        await persistMatch(client, riotAccountId, account.rows[0].puuid, match);
        await client.query("COMMIT");
        imported += 1;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
    return { imported, skipped };
  } finally {
    client.release();
    if (ownsPool) await activePool.end();
  }
}

async function persistMatch(client: PoolClient, riotAccountId: string, puuid: string, match: RawMatch): Promise<void> {
  const { matchInfo: info } = match;
  const player = match.players.find((candidate) => candidate.puuid === puuid);
  if (!player) return;
  await client.query(
    `INSERT INTO matches (match_id, region, map_id, game_version, game_length_millis, game_start_millis,
      provisioning_flow_id, is_completed, custom_game_name, queue_id, game_mode, is_ranked, season_id,
      premier_match_info, raw_payload)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15::jsonb)
     ON CONFLICT (match_id) DO UPDATE SET raw_payload = EXCLUDED.raw_payload, fetched_at = now()`,
    [info.matchId, info.region, info.mapId, info.gameVersion, info.gameLengthMillis, info.gameStartMillis,
      info.provisioningFlowId, info.isCompleted, info.customGameName, info.queueId, info.gameMode, info.isRanked,
      info.seasonId, JSON.stringify(info.premierMatchInfo ?? null), JSON.stringify(match)]
  );
  await client.query("DELETE FROM player_match_stats WHERE match_id = $1 AND riot_account_id = $2", [info.matchId, riotAccountId]);
  for (const round of match.roundResults) {
    const roundNumber = round.roundNum + 1;
    await client.query(
      `INSERT INTO match_rounds (match_id, round_number, winning_team, winning_team_role, round_result,
        round_result_code, plant_round_time, plant_location, plant_site)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)
       ON CONFLICT (match_id, round_number) DO UPDATE SET winning_team = EXCLUDED.winning_team,
       winning_team_role = EXCLUDED.winning_team_role, round_result = EXCLUDED.round_result,
       round_result_code = EXCLUDED.round_result_code, plant_round_time = EXCLUDED.plant_round_time,
       plant_location = EXCLUDED.plant_location, plant_site = EXCLUDED.plant_site`,
      [info.matchId, roundNumber, round.winningTeam, round.winningTeamRole, round.roundResult,
        round.roundResultCode, round.plantRoundTime, JSON.stringify(round.plantLocation ?? null), round.plantSite]
    );
  }
  await client.query(
    `INSERT INTO player_match_stats (match_id, riot_account_id, team_id, party_id, character_id, score,
      rounds_played, kills, deaths, assists, playtime_millis, ability_casts, competitive_tier, account_level)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14)`,
    [info.matchId, riotAccountId, player.teamId, player.partyId, player.characterId, player.stats.score,
      player.stats.roundsPlayed, player.stats.kills, player.stats.deaths, player.stats.assists,
      player.stats.playtimeMillis, JSON.stringify(player.stats.abilityCasts ?? null), player.competitiveTier, player.accountLevel]
  );
  for (const round of match.roundResults) await persistRoundEvidence(client, info.matchId, riotAccountId, puuid, round);
}

async function persistRoundEvidence(
  client: PoolClient, matchId: string, riotAccountId: string, puuid: string, round: RawMatch["roundResults"][number]
): Promise<void> {
  const player = round.playerStats.find((candidate) => candidate.puuid === puuid);
  if (!player) return;
  const roundNumber = round.roundNum + 1;
  await client.query(
    "INSERT INTO player_round_stats (match_id, riot_account_id, round_number, score, economy, ability) VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb)",
    [matchId, riotAccountId, roundNumber, player.score, JSON.stringify(player.economy ?? null), JSON.stringify(player.ability ?? null)]
  );
  const firstKill = firstKillInRound(round);
  for (const [index, kill] of player.kills.entries()) {
    const assistant = kill.assistants?.includes(puuid) ?? false;
    const killer = kill.killer === puuid;
    const victim = kill.victim === puuid;
    if (!killer && !victim && !assistant) continue;
    await client.query(
      `INSERT INTO round_kills (match_id, riot_account_id, round_number, kill_index, is_killer, is_victim,
        is_assistant, game_time_millis, is_first_death, round_time_millis, finishing_damage_type,
        finishing_item, is_secondary_fire_mode)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [matchId, riotAccountId, roundNumber, index, killer, victim, assistant, kill.gameTime,
        victim && firstKill === firstKillIdentity(kill), kill.roundTime, kill.finishingDamage?.damageType,
        kill.finishingDamage?.damageItem, kill.finishingDamage?.isSecondaryFireMode]
    );
  }
  for (const [index, damage] of player.damage.entries()) {
    await client.query(
      `INSERT INTO round_damage (match_id, riot_account_id, round_number, damage_index, damage, headshots, bodyshots, legshots)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [matchId, riotAccountId, roundNumber, index, damage.damage, damage.headshots, damage.bodyshots, damage.legshots]
    );
  }
}
