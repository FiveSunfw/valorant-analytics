import os
import unittest
from uuid import uuid4

import psycopg

from app.celery_app import sync_fixture_matches_task


DATABASE_URL = os.getenv(
    "DATABASE_URL", "postgresql://valorant:valorant_dev@127.0.0.1:15432/valorant"
).replace("postgresql+psycopg://", "postgresql://", 1)


def _kill(killer: str, victim: str, game_time: int) -> dict[str, object]:
    return {
        "killer": killer,
        "victim": victim,
        "assistants": [],
        "gameTime": game_time,
        "roundTime": game_time,
        "finishingDamage": {"damageType": "Weapon", "damageItem": "Vandal"},
    }


def _fixture_match(match_id: str, *, competitive: bool) -> dict[str, object]:
    me = "fixture-authorized-puuid"
    enemy = "fixture-enemy-puuid"
    teammate = "fixture-teammate-puuid"
    round_events = [
        (_kill(enemy, me, 100), {"damage": 100, "headshots": 1, "bodyshots": 1, "legshots": 0}),
        (_kill(me, enemy, 200), {"damage": 50, "headshots": 0, "bodyshots": 1, "legshots": 0}),
        (_kill(me, enemy, 300), {"damage": 50, "headshots": 1, "bodyshots": 0, "legshots": 0}),
    ]
    rounds = []
    for round_num, (event, damage) in enumerate(round_events):
        # Round two has an earlier unrelated kill, proving first death is global chronology.
        other_kills = [_kill(enemy, teammate, 50)] if round_num == 1 else []
        rounds.append(
            {
                "roundNum": round_num,
                "winningTeam": "Blue",
                "winningTeamRole": "Attack",
                "roundResult": "Elimination",
                "roundResultCode": "Eliminated",
                "playerStats": [
                    {"puuid": me, "score": 200, "economy": {}, "ability": {}, "kills": [event], "damage": [damage]},
                    {"puuid": enemy, "score": 0, "economy": {}, "ability": {}, "kills": other_kills, "damage": []},
                ],
            }
        )
    return {
        "matchInfo": {
            "matchId": match_id,
            "region": "ap",
            "mapId": "/Game/Maps/Ascent/Ascent",
            "gameStartMillis": 1_700_000_000_000,
            "gameLengthMillis": 1_800_000,
            "queueId": "competitive" if competitive else "unrated",
            "gameMode": "Competitive" if competitive else "Unrated",
            "isRanked": competitive,
            "isCompleted": True,
        },
        "players": [
            {
                "puuid": me,
                "teamId": "Blue",
                "characterId": "fixture-agent",
                "stats": {
                    "score": 600,
                    "roundsPlayed": 3,
                    "kills": 2,
                    "deaths": 1,
                    "assists": 0,
                    "playtimeMillis": 1_800_000,
                    "abilityCasts": {},
                },
            }
        ],
        "roundResults": rounds,
    }


class FixtureSyncTests(unittest.TestCase):
    def setUp(self) -> None:
        self.user_id = uuid4()
        self.account_id = uuid4()
        self.match_id = f"fixture-competitive-{self.account_id}"
        self.unrated_id = f"fixture-unrated-{self.account_id}"
        with psycopg.connect(DATABASE_URL) as connection:
            connection.execute("INSERT INTO users (id) VALUES (%s)", (self.user_id,))
            connection.execute(
                """INSERT INTO riot_accounts (id, user_id, rso_subject, puuid, platform)
                   VALUES (%s, %s, %s, %s, %s)""",
                (self.account_id, self.user_id, f"fixture-rso-{self.account_id}", "fixture-authorized-puuid", "ap"),
            )

    def tearDown(self) -> None:
        with psycopg.connect(DATABASE_URL) as connection:
            connection.execute("DELETE FROM users WHERE id = %s", (self.user_id,))
            connection.execute("DELETE FROM matches WHERE match_id IN (%s, %s)", (self.match_id, self.unrated_id))

    def test_filters_non_competitive_and_replaces_personal_evidence_idempotently(self) -> None:
        fixtures = [_fixture_match(self.match_id, competitive=True), _fixture_match(self.unrated_id, competitive=False)]

        self.assertEqual(
            sync_fixture_matches_task.apply(
                kwargs={"riot_account_id": str(self.account_id), "match_payloads": fixtures}
            ).get(),
            {"imported": 1, "skipped": 1},
        )
        self.assertEqual(
            sync_fixture_matches_task.apply(
                kwargs={"riot_account_id": str(self.account_id), "match_payloads": fixtures}
            ).get(),
            {"imported": 1, "skipped": 1},
        )

        with psycopg.connect(DATABASE_URL) as connection:
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM matches WHERE match_id = %s", (self.match_id,)).fetchone()[0], 1)
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM matches WHERE match_id = %s", (self.unrated_id,)).fetchone()[0], 0)
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM player_round_stats WHERE match_id = %s", (self.match_id,)).fetchone()[0], 3)
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM round_kills WHERE match_id = %s", (self.match_id,)).fetchone()[0], 3)
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM round_damage WHERE match_id = %s", (self.match_id,)).fetchone()[0], 3)
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM round_kills WHERE match_id = %s AND is_first_death", (self.match_id,)).fetchone()[0], 1)
            self.assertEqual(connection.execute("SELECT raw_payload->'matchInfo'->>'matchId' FROM matches WHERE match_id = %s", (self.match_id,)).fetchone()[0], self.match_id)


if __name__ == "__main__":
    unittest.main()
