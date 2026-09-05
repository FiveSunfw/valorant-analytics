import os
import unittest
from uuid import uuid4

import psycopg

from app.analytics.reader import PsycopgAnalyticsReader


DATABASE_URL = os.getenv(
    "DATABASE_URL", "postgresql://valorant:valorant_dev@127.0.0.1:15432/valorant"
).replace("postgresql+psycopg://", "postgresql://", 1)


class AnalyticsReaderTests(unittest.TestCase):
    def setUp(self) -> None:
        self.user_id = uuid4()
        self.account_id = uuid4()
        self.match_id = f"reader-fixture-{self.account_id}"
        with psycopg.connect(DATABASE_URL) as connection:
            connection.execute("INSERT INTO users (id) VALUES (%s)", (self.user_id,))
            connection.execute(
                "INSERT INTO riot_accounts (id, user_id, rso_subject, puuid, platform) VALUES (%s, %s, %s, %s, %s)",
                (self.account_id, self.user_id, f"reader-rso-{self.account_id}", f"reader-puuid-{self.account_id}", "ap"),
            )
            connection.execute(
                """INSERT INTO matches (match_id, map_id, game_start_millis, queue_id, is_ranked, is_completed, raw_payload)
                   VALUES (%s, %s, %s, 'competitive', TRUE, TRUE, '{}'::jsonb)""",
                (self.match_id, "Ascent", 1_700_000_000_000),
            )
            connection.execute(
                """INSERT INTO player_match_stats (match_id, riot_account_id, team_id, score, rounds_played, kills, deaths, assists)
                   VALUES (%s, %s, 'Blue', 600, 3, 2, 1, 0)""",
                (self.match_id, self.account_id),
            )
            for number in range(1, 4):
                connection.execute("INSERT INTO match_rounds (match_id, round_number, winning_team) VALUES (%s, %s, %s)", (self.match_id, number, "Blue" if number != 2 else "Red"))
                connection.execute("INSERT INTO player_round_stats (match_id, riot_account_id, round_number, score) VALUES (%s, %s, %s, 200)", (self.match_id, self.account_id, number))
            connection.execute("INSERT INTO round_damage (match_id, riot_account_id, round_number, damage_index, damage, headshots, bodyshots, legshots) VALUES (%s, %s, 1, 0, 100, 1, 1, 0)", (self.match_id, self.account_id))
            connection.execute("INSERT INTO round_damage (match_id, riot_account_id, round_number, damage_index, damage, headshots, bodyshots, legshots) VALUES (%s, %s, 2, 0, 50, 0, 1, 0)", (self.match_id, self.account_id))
            connection.execute("INSERT INTO round_damage (match_id, riot_account_id, round_number, damage_index, damage, headshots, bodyshots, legshots) VALUES (%s, %s, 3, 0, 50, 1, 0, 0)", (self.match_id, self.account_id))
            connection.execute("INSERT INTO round_kills (match_id, riot_account_id, round_number, kill_index, is_killer, is_victim, is_assistant, is_first_death, round_time_millis, finishing_item) VALUES (%s, %s, 1, 0, FALSE, TRUE, FALSE, TRUE, 100, 'Vandal')", (self.match_id, self.account_id))

    def tearDown(self) -> None:
        with psycopg.connect(DATABASE_URL) as connection:
            connection.execute("DELETE FROM users WHERE id = %s", (self.user_id,))
            connection.execute("DELETE FROM matches WHERE match_id = %s", (self.match_id,))

    def test_summary_and_evidence_are_limited_to_current_user_competitive_matches(self) -> None:
        reader = PsycopgAnalyticsReader(DATABASE_URL)

        summary = reader.get_player_summary(user_id=str(self.user_id))
        metrics = {metric.name: metric.value for metric in summary.metrics}
        self.assertEqual(summary.scope.queue, "competitive")
        self.assertEqual(summary.scope.sample_size, 1)
        self.assertEqual(metrics, {"ADR": 66.67, "ACS": 200.0, "K/D": 2.0, "Headshot rate": 50.0, "First-death rate": 33.33})

        match_list = reader.get_match_list(user_id=str(self.user_id), limit=5)
        self.assertEqual(match_list.matches[0].match_id, self.match_id)
        self.assertEqual(match_list.matches[0].result, "win")

        evidence = reader.get_round_evidence(user_id=str(self.user_id), match_id=self.match_id, round_number=1)
        self.assertEqual(evidence.evidence[0].event_type, "first_death")
        self.assertIn("first player eliminated", evidence.evidence[0].description)
        self.assertEqual(reader.get_round_evidence(user_id=str(uuid4()), match_id=self.match_id, round_number=1).evidence, [])


if __name__ == "__main__":
    unittest.main()
