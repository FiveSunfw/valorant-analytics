import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { connect, type Channel, type ChannelModel } from "amqplib";
import { Pool } from "pg";
import { databaseUrl, rabbitMqUrl } from "./config.js";
import { ensureFixtureSyncTopology, fixtureSyncTopology, publishFixtureSync } from "./jobs.js";
import { createFixtureSyncWorker, type FixtureSyncWorker } from "./worker.js";

const runIntegration = process.env.RUN_INTEGRATION_TESTS === "1";
const describeIntegration = runIntegration ? describe : describe.skip;

function fixture(matchId: string, competitive: boolean, accountPuuid: string) {
  return {
    matchInfo: { matchId, region: "ap", mapId: "Ascent", gameStartMillis: 1_700_000_000_000, queueId: competitive ? "competitive" : "unrated", gameMode: competitive ? "Competitive" : "Unrated", isRanked: competitive, isCompleted: true },
    players: [{ puuid: accountPuuid, teamId: "Blue", characterId: "agent", stats: { score: 600, roundsPlayed: 3, kills: 2, deaths: 1, assists: 0, playtimeMillis: 180000 } }],
    roundResults: [0, 1, 2].map((roundNum) => ({
      roundNum, winningTeam: "Blue", winningTeamRole: "Attack", roundResult: "Elimination", roundResultCode: "Eliminated",
      playerStats: [{
        puuid: accountPuuid, score: 200, economy: {}, ability: {},
        kills: roundNum === 0 ? [{ killer: "enemy", victim: accountPuuid, gameTime: 100, roundTime: 100, finishingDamage: { damageType: "Weapon", damageItem: "Vandal" } }] : [{ killer: accountPuuid, victim: "enemy", gameTime: 200, roundTime: 200 }],
        damage: [{ damage: roundNum === 0 ? 100 : 50, headshots: roundNum === 1 ? 1 : 0, bodyshots: roundNum === 2 ? 1 : 0, legshots: 0 }]
      }]
    }))
  };
}

async function waitForEvidence(pool: Pool, matchId: string): Promise<{ matches: string; rounds: string; kills: string; damage: string; first_deaths: string }> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const counts = await pool.query<{ matches: string; rounds: string; kills: string; damage: string; first_deaths: string }>(
      `SELECT (SELECT COUNT(*) FROM matches WHERE match_id = $1) AS matches,
        (SELECT COUNT(*) FROM player_round_stats WHERE match_id = $1) AS rounds,
        (SELECT COUNT(*) FROM round_kills WHERE match_id = $1) AS kills,
        (SELECT COUNT(*) FROM round_damage WHERE match_id = $1) AS damage,
        (SELECT COUNT(*) FROM round_kills WHERE match_id = $1 AND is_first_death) AS first_deaths`, [matchId]
    );
    if (counts.rows[0]?.matches === "1") return counts.rows[0];
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("fixture job was not persisted before timeout");
}

async function waitForQueueDrain(channel: Channel, queueName: string, worker: FixtureSyncWorker): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if ((await channel.checkQueue(queueName)).messageCount === 0) {
      await worker.idle();
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("fixture queue did not drain before timeout");
}

describeIntegration("fixture sync through RabbitMQ", () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const id = randomUUID();
  const userId = randomUUID();
  const accountId = randomUUID();
  const puuid = `fixture-${id}`;
  const matchId = `competitive-${id}`;
  const unratedId = `unrated-${id}`;
  const queueName = `fixture-integration-${id}`;
  const topology = fixtureSyncTopology(queueName);
  const worker: FixtureSyncWorker = createFixtureSyncWorker({ queueName, url: rabbitMqUrl });
  let connection: ChannelModel | undefined;
  let channel: Channel | undefined;

  afterEach(async () => {
    await worker.close();
    if (channel) {
      await channel.deleteQueue(topology.queueName);
      await channel.deleteQueue(topology.retryQueueName);
      await channel.deleteQueue(topology.deadLetterQueueName);
      await channel.close();
    }
    if (connection) await connection.close();
    await pool.query("DELETE FROM users WHERE id = $1", [userId]);
    await pool.query("DELETE FROM matches WHERE match_id = ANY($1)", [[matchId, unratedId]]);
    await pool.end();
  });

  it("filters non-competitive matches and persists evidence idempotently", async () => {
    await pool.query("INSERT INTO users (id) VALUES ($1)", [userId]);
    await pool.query("INSERT INTO riot_accounts (id, user_id, rso_subject, puuid, platform) VALUES ($1,$2,$3,$4,'ap')", [accountId, userId, `rso-${id}`, puuid]);
    await worker.start();
    const publisherConnection = await connect(rabbitMqUrl);
    const publisherChannel = await publisherConnection.createChannel();
    connection = publisherConnection;
    channel = publisherChannel;
    await ensureFixtureSyncTopology(publisherChannel, topology);
    const job = { riotAccountId: accountId, matchPayloads: [fixture(matchId, true, puuid), fixture(unratedId, false, puuid)] };
    publishFixtureSync(publisherChannel, job, topology);
    publishFixtureSync(publisherChannel, job, topology);

    await waitForEvidence(pool, matchId);
    await waitForQueueDrain(publisherChannel, topology.queueName, worker);
    expect(await waitForEvidence(pool, matchId)).toEqual({ matches: "1", rounds: "3", kills: "3", damage: "3", first_deaths: "1" });
    expect((await pool.query("SELECT 1 FROM matches WHERE match_id = $1", [unratedId])).rowCount).toBe(0);
  }, 20_000);
});
