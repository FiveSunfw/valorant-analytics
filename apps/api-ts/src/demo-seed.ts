import { createHash, randomBytes } from "node:crypto";
import { Pool } from "pg";
import { databaseUrl } from "./config.js";

if (process.env.NODE_ENV === "production") throw new Error("Demo data cannot be seeded in production");

const userId = "10000000-0000-4000-8000-000000000001";
const accountId = "20000000-0000-4000-8000-000000000001";
const sessionToken = randomBytes(32).toString("base64url");
const tokenHash = createHash("sha256").update(sessionToken).digest("hex");
const pool = new Pool({ connectionString: databaseUrl });
const client = await pool.connect();

try {
  await client.query("BEGIN");
  await client.query("INSERT INTO users (id) VALUES ($1) ON CONFLICT (id) DO NOTHING", [userId]);
  await client.query(
    `INSERT INTO riot_accounts (id,user_id,rso_subject,puuid,game_name,tag_line,platform)
     VALUES ($1,$2,'demo-rso-subject','demo-puuid','FixturePlayer','DEMO','ap')
     ON CONFLICT (id) DO UPDATE SET game_name = EXCLUDED.game_name, tag_line = EXCLUDED.tag_line`,
    [accountId, userId]
  );
  await client.query(
    "INSERT INTO user_sessions (token_hash,user_id,expires_at) VALUES ($1,$2,now() + interval '7 days') ON CONFLICT (token_hash) DO NOTHING",
    [tokenHash, userId]
  );

  for (let matchIndex = 1; matchIndex <= 6; matchIndex += 1) {
    const matchId = `demo-competitive-${matchIndex}`;
    const gameStartMillis = 1_789_000_000_000 + matchIndex * 3_600_000;
    await client.query(
      `INSERT INTO matches (match_id,map_id,game_start_millis,queue_id,game_mode,is_ranked,is_completed,raw_payload)
       VALUES ($1,$2,$3,'competitive','Competitive',TRUE,TRUE,'{}'::jsonb)
       ON CONFLICT (match_id) DO UPDATE SET game_start_millis = EXCLUDED.game_start_millis`,
      [matchId, matchIndex % 2 === 0 ? "Haven" : "Ascent", gameStartMillis]
    );
    await client.query(
      `INSERT INTO player_match_stats (match_id,riot_account_id,team_id,score,rounds_played,kills,deaths,assists)
       VALUES ($1,$2,'Blue',$3,12,$4,$5,4)
       ON CONFLICT (match_id,riot_account_id) DO UPDATE SET score=EXCLUDED.score, rounds_played=EXCLUDED.rounds_played, kills=EXCLUDED.kills, deaths=EXCLUDED.deaths, assists=EXCLUDED.assists`,
      [matchId, accountId, 2_400 + matchIndex * 20, 8 + matchIndex, 7 + matchIndex]
    );
    for (let roundNumber = 1; roundNumber <= 12; roundNumber += 1) {
      const playerRole = roundNumber <= 6 ? "Attack" : "Defense";
      const winningTeam = roundNumber <= (matchIndex % 2 === 0 ? 4 : 7) ? "Blue" : "Red";
      const winningTeamRole = winningTeam === "Blue" ? playerRole : playerRole === "Attack" ? "Defense" : "Attack";
      await client.query(
        "INSERT INTO match_rounds (match_id,round_number,winning_team,winning_team_role) VALUES ($1,$2,$3,$4) ON CONFLICT (match_id,round_number) DO UPDATE SET winning_team=EXCLUDED.winning_team, winning_team_role=EXCLUDED.winning_team_role",
        [matchId, roundNumber, winningTeam, winningTeamRole]
      );
      await client.query(
        "INSERT INTO player_round_stats (match_id,riot_account_id,round_number,score) VALUES ($1,$2,$3,200) ON CONFLICT (match_id,riot_account_id,round_number) DO UPDATE SET score=EXCLUDED.score",
        [matchId, accountId, roundNumber]
      );
      await client.query(
        `INSERT INTO round_damage (match_id,riot_account_id,round_number,damage_index,damage,headshots,bodyshots,legshots)
         VALUES ($1,$2,$3,0,120,$4,$5,0)
         ON CONFLICT (match_id,riot_account_id,round_number,damage_index) DO UPDATE SET damage=EXCLUDED.damage, headshots=EXCLUDED.headshots, bodyshots=EXCLUDED.bodyshots`,
        [matchId, accountId, roundNumber, roundNumber % 3 === 0 ? 1 : 0, roundNumber % 3 === 0 ? 0 : 1]
      );
    }
    for (const roundNumber of [1, 5]) {
      await client.query(
        `INSERT INTO round_kills (match_id,riot_account_id,round_number,kill_index,is_killer,is_victim,is_assistant,is_first_death,round_time_millis,finishing_item)
         VALUES ($1,$2,$3,0,FALSE,TRUE,FALSE,TRUE,$4,'Vandal')
         ON CONFLICT (match_id,riot_account_id,round_number,kill_index) DO UPDATE SET is_first_death=TRUE, round_time_millis=EXCLUDED.round_time_millis`,
        [matchId, accountId, roundNumber, 8_000 + roundNumber * 1_000]
      );
    }
  }
  await client.query("COMMIT");
  console.info(JSON.stringify({ userId, cookie: `valorant_session=${sessionToken}`, matches: 6 }, null, 2));
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  client.release();
  await pool.end();
}
