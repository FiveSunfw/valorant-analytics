import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Pool } from "pg";
import { buildApp } from "./app.js";
import { DeterministicAnalysisModel } from "./agent-runtime.js";

const describeIntegration = process.env.RUN_INTEGRATION_TESTS === "1" ? describe : describe.skip;
const databaseUrl = process.env.DATABASE_URL ?? "postgresql://valorant:valorant_dev@127.0.0.1:15432/valorant";

describeIntegration("fixture analysis agent", () => {
  it("answers a first-death question through HTTP with PostgreSQL evidence", async () => {
    const pool = new Pool({ connectionString: databaseUrl });
    const userId = randomUUID();
    const accountId = randomUUID();
    const matchId = `agent-demo-${randomUUID()}`;
    const app = buildApp({
      pool,
      redis: { quit: async () => "OK" } as never,
      oauth: { getSession: async () => ({ userId, token: "demo-session", expiresAt: new Date(Date.now() + 60_000) }) } as never,
      agentModel: new DeterministicAnalysisModel()
    });

    try {
      await pool.query("INSERT INTO users (id) VALUES ($1)", [userId]);
      await pool.query("INSERT INTO riot_accounts (id,user_id,rso_subject,puuid,platform) VALUES ($1,$2,$3,$4,'ap')", [accountId, userId, `demo-${accountId}`, `puuid-${accountId}`]);
      await pool.query("INSERT INTO matches (match_id,map_id,game_start_millis,queue_id,is_ranked,is_completed,raw_payload) VALUES ($1,'Ascent',1700000000000,'competitive',TRUE,TRUE,'{}'::jsonb)", [matchId]);
      await pool.query("INSERT INTO player_match_stats (match_id,riot_account_id,team_id,score,rounds_played,kills,deaths) VALUES ($1,$2,'Blue',600,3,2,1)", [matchId, accountId]);
      await pool.query("INSERT INTO match_rounds (match_id,round_number,winning_team) VALUES ($1,1,'Red')", [matchId]);
      await pool.query("INSERT INTO player_round_stats (match_id,riot_account_id,round_number,score) VALUES ($1,$2,1,200)", [matchId, accountId]);
      await pool.query("INSERT INTO round_damage (match_id,riot_account_id,round_number,damage_index,damage,headshots,bodyshots,legshots) VALUES ($1,$2,1,0,100,1,1,0)", [matchId, accountId]);
      await pool.query("INSERT INTO round_kills (match_id,riot_account_id,round_number,kill_index,is_killer,is_victim,is_assistant,is_first_death,round_time_millis,finishing_item) VALUES ($1,$2,1,0,FALSE,TRUE,FALSE,TRUE,100,'Vandal')", [matchId, accountId]);

      const response = await app.inject({
        method: "POST",
        url: "/agent/analyze",
        headers: { cookie: "valorant_session=demo-session" },
        payload: { question: "我最近为什么总是先死？" }
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        toolCalls: 2,
        answer: { playerEvidence: expect.arrayContaining([expect.objectContaining({ matchId, roundNumber: 1 })]) }
      });
    } finally {
      await pool.query("DELETE FROM users WHERE id = $1", [userId]);
      await pool.query("DELETE FROM matches WHERE match_id = $1", [matchId]);
      await app.close();
    }
  }, 20_000);
});
