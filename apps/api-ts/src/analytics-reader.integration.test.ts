import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { AnalyticsReader } from "./analytics-reader.js";

const runIntegration = process.env.RUN_INTEGRATION_TESTS === "1";
const describeIntegration = runIntegration ? describe : describe.skip;
const databaseUrl = process.env.DATABASE_URL ?? "postgresql://valorant:valorant_dev@127.0.0.1:15432/valorant";

describeIntegration("AnalyticsReader against PostgreSQL", () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const userId = randomUUID();
  const accountId = randomUUID();
  const matchId = `reader-${randomUUID()}`;

  afterEach(async () => {
    await pool.query("DELETE FROM users WHERE id = $1", [userId]);
    await pool.query("DELETE FROM matches WHERE match_id = $1", [matchId]);
    await pool.end();
  });

  it("returns only completed competitive data with concrete round evidence", async () => {
    await pool.query("INSERT INTO users (id) VALUES ($1)", [userId]);
    await pool.query("INSERT INTO riot_accounts (id,user_id,rso_subject,puuid,platform) VALUES ($1,$2,$3,$4,'ap')", [accountId, userId, `rso-${accountId}`, `account-${accountId}`]);
    await pool.query("INSERT INTO matches (match_id,map_id,game_start_millis,queue_id,is_ranked,is_completed,raw_payload) VALUES ($1,'Ascent',1700000000000,'competitive',TRUE,TRUE,'{}'::jsonb)", [matchId]);
    await pool.query("INSERT INTO player_match_stats (match_id,riot_account_id,team_id,score,rounds_played,kills,deaths) VALUES ($1,$2,'Blue',600,3,2,1)", [matchId, accountId]);
    for (const round of [1, 2, 3]) {
      await pool.query("INSERT INTO match_rounds (match_id,round_number,winning_team) VALUES ($1,$2,$3)", [matchId, round, round === 2 ? "Red" : "Blue"]);
      await pool.query("INSERT INTO player_round_stats (match_id,riot_account_id,round_number,score) VALUES ($1,$2,$3,200)", [matchId, accountId, round]);
      await pool.query("INSERT INTO round_damage (match_id,riot_account_id,round_number,damage_index,damage,headshots,bodyshots,legshots) VALUES ($1,$2,$3,0,$4,$5,$6,0)", [matchId, accountId, round, round === 1 ? 100 : 50, round === 1 || round === 3 ? 1 : 0, round === 1 || round === 2 ? 1 : 0]);
    }
    await pool.query("INSERT INTO round_kills (match_id,riot_account_id,round_number,kill_index,is_killer,is_victim,is_assistant,is_first_death,round_time_millis,finishing_item) VALUES ($1,$2,1,0,FALSE,TRUE,FALSE,TRUE,100,'Vandal')", [matchId, accountId]);

    const reader = new AnalyticsReader(pool);
    expect(await reader.getPlayerSummary(userId)).toMatchObject({ scope: { queue: "competitive", sampleSize: 1 }, metrics: { adr: 66.67, acs: 200, kd: 2, headshotRate: 50, firstDeathRate: 33.33 } });
    expect(await reader.getMatchList(userId, 5)).toMatchObject({ matches: [{ matchId, result: "win" }] });
    expect(await reader.getRoundEvidence(userId, matchId, 1)).toMatchObject({ scope: { queue: "competitive", sampleSize: 1 }, evidence: [{ matchId, roundNumber: 1, eventType: "first_death" }] });
    expect((await reader.getRoundEvidence(randomUUID(), matchId, 1)).evidence).toEqual([]);
  }, 20_000);
});
