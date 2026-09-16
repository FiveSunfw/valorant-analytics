import { Pool } from "pg";
import { databaseUrl } from "./config.js";
import { DEMO_FIXTURES } from "./demo-fixtures.js";

if (process.env.NODE_ENV === "production") throw new Error("Demo data cannot be seeded in production");
const pool = new Pool({ connectionString: databaseUrl });
const client = await pool.connect();
try {
  await client.query("BEGIN");
  for (const [profile, fixture] of Object.entries(DEMO_FIXTURES)) {
    await client.query("INSERT INTO users (id) VALUES ($1) ON CONFLICT (id) DO NOTHING", [fixture.userId]);
    await client.query(`INSERT INTO riot_accounts (id,user_id,rso_subject,puuid,game_name,tag_line,platform,is_demo) VALUES ($1,$2,$3,$4,$5,'DEMO','ap',TRUE) ON CONFLICT (id) DO UPDATE SET game_name=EXCLUDED.game_name,is_demo=TRUE`, [fixture.accountId, fixture.userId, `demo-rso-${profile}`, `demo-puuid-${profile}`, `Fixture${profile}`]);
    for (let matchIndex = 1; matchIndex <= fixture.matches; matchIndex += 1) {
      const matchId = `demo-${profile}-${matchIndex}`;
      await client.query(`INSERT INTO matches (match_id,map_id,game_start_millis,queue_id,game_mode,is_ranked,is_completed,raw_payload) VALUES ($1,$2,$3,'competitive','Competitive',TRUE,TRUE,'{}'::jsonb) ON CONFLICT (match_id) DO UPDATE SET game_start_millis=EXCLUDED.game_start_millis`, [matchId, matchIndex % 2 === 0 ? "Haven" : "Ascent", 1_789_000_000_000 + matchIndex * 3_600_000]);
      await client.query(`INSERT INTO player_match_stats (match_id,riot_account_id,team_id,score,rounds_played,kills,deaths,assists) VALUES ($1,$2,'Blue',$3,12,$4,$5,4) ON CONFLICT (match_id,riot_account_id) DO UPDATE SET score=EXCLUDED.score,rounds_played=EXCLUDED.rounds_played,kills=EXCLUDED.kills,deaths=EXCLUDED.deaths,assists=EXCLUDED.assists`, [matchId, fixture.accountId, 2_400 + matchIndex * 20, 8 + matchIndex, 7 + matchIndex]);
      for (let roundNumber = 1; roundNumber <= 12; roundNumber += 1) {
        const role = roundNumber <= 6 ? "Attack" : "Defense"; const won = roundNumber <= (matchIndex % 2 === 0 ? 4 : 7);
        await client.query("INSERT INTO match_rounds (match_id,round_number,winning_team,winning_team_role) VALUES ($1,$2,$3,$4) ON CONFLICT (match_id,round_number) DO UPDATE SET winning_team=EXCLUDED.winning_team,winning_team_role=EXCLUDED.winning_team_role", [matchId, roundNumber, won ? "Blue" : "Red", won ? role : role === "Attack" ? "Defense" : "Attack"]);
        await client.query("INSERT INTO player_round_stats (match_id,riot_account_id,round_number,score) VALUES ($1,$2,$3,200) ON CONFLICT (match_id,riot_account_id,round_number) DO UPDATE SET score=EXCLUDED.score", [matchId, fixture.accountId, roundNumber]);
        await client.query(`INSERT INTO round_damage (match_id,riot_account_id,round_number,damage_index,damage,headshots,bodyshots,legshots) VALUES ($1,$2,$3,0,120,$4,$5,0) ON CONFLICT (match_id,riot_account_id,round_number,damage_index) DO UPDATE SET damage=EXCLUDED.damage,headshots=EXCLUDED.headshots,bodyshots=EXCLUDED.bodyshots`, [matchId, fixture.accountId, roundNumber, roundNumber % 3 === 0 ? 1 : 0, roundNumber % 3 === 0 ? 0 : 1]);
      }
      if (fixture.includeFirstDeaths) for (const roundNumber of [1, 5]) await client.query(`INSERT INTO round_kills (match_id,riot_account_id,round_number,kill_index,is_killer,is_victim,is_assistant,is_first_death,round_time_millis,finishing_item) VALUES ($1,$2,$3,0,FALSE,TRUE,FALSE,TRUE,$4,'Vandal') ON CONFLICT (match_id,riot_account_id,round_number,kill_index) DO UPDATE SET is_first_death=TRUE,round_time_millis=EXCLUDED.round_time_millis`, [matchId, fixture.accountId, roundNumber, 8_000 + roundNumber * 1_000]);
    }
  }
  await client.query("COMMIT"); console.info(JSON.stringify({ profiles: Object.fromEntries(Object.entries(DEMO_FIXTURES).map(([name, fixture]) => [name, fixture.matches])) }, null, 2));
} catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); await pool.end(); }
