"""Current-user-scoped queries backing the Agent's read-only tools."""

from __future__ import annotations

import os
from datetime import UTC, datetime
from typing import Any

import psycopg

from app.agent.service import (
    DataScope,
    MatchList,
    MatchSummary,
    Metric,
    PlayerSummary,
    RoundEvidence,
    RoundEvidenceResult,
)


COMPETITIVE_QUEUE_ID = "competitive"


def _database_url() -> str:
    return os.getenv(
        "DATABASE_URL",
        "postgresql+psycopg://valorant:valorant_dev@127.0.0.1:15432/valorant",
    ).replace("postgresql+psycopg://", "postgresql://", 1)


def _iso_time(millis: int | None) -> str | None:
    if millis is None:
        return None
    return datetime.fromtimestamp(millis / 1000, tz=UTC).isoformat()


class PsycopgAnalyticsReader:
    """Read analytics only through the authenticated product-user relationship."""

    def __init__(self, database_url: str | None = None) -> None:
        self._database_url = database_url or _database_url()

    def get_player_summary(self, *, user_id: str) -> PlayerSummary:
        with psycopg.connect(self._database_url) as connection:
            row = connection.execute(
                """
                SELECT
                    COUNT(DISTINCT stats.match_id) AS match_count,
                    MIN(matches.game_start_millis) AS period_start,
                    MAX(matches.game_start_millis) AS period_end,
                    COALESCE(SUM(stats.kills), 0) AS kills,
                    COALESCE(SUM(stats.deaths), 0) AS deaths,
                    COALESCE(SUM(stats.score), 0) AS score,
                    COALESCE(SUM(stats.rounds_played), 0) AS rounds_played,
                    COALESCE(SUM(damage.damage), 0) AS damage,
                    COALESCE(SUM(damage.headshots), 0) AS headshots,
                    COALESCE(SUM(damage.bodyshots), 0) AS bodyshots,
                    COALESCE(SUM(damage.legshots), 0) AS legshots,
                    COALESCE(SUM(first_deaths.count), 0) AS first_deaths
                FROM riot_accounts accounts
                JOIN player_match_stats stats ON stats.riot_account_id = accounts.id
                JOIN matches ON matches.match_id = stats.match_id
                LEFT JOIN LATERAL (
                    SELECT SUM(round_damage.damage) AS damage,
                           SUM(round_damage.headshots) AS headshots,
                           SUM(round_damage.bodyshots) AS bodyshots,
                           SUM(round_damage.legshots) AS legshots
                    FROM round_damage
                    WHERE round_damage.match_id = stats.match_id
                      AND round_damage.riot_account_id = accounts.id
                ) damage ON TRUE
                LEFT JOIN LATERAL (
                    SELECT COUNT(*) AS count
                    FROM round_kills
                    WHERE round_kills.match_id = stats.match_id
                      AND round_kills.riot_account_id = accounts.id
                      AND round_kills.is_first_death = TRUE
                ) first_deaths ON TRUE
                WHERE accounts.user_id = %s
                  AND matches.queue_id = %s
                  AND matches.is_ranked = TRUE
                  AND matches.is_completed = TRUE
                """,
                (user_id, COMPETITIVE_QUEUE_ID),
            ).fetchone()

        assert row is not None
        (sample_size, period_start, period_end, kills, deaths, score, rounds, damage,
         headshots, bodyshots, legshots, first_deaths) = row
        scope = self._scope(sample_size, period_start, period_end)
        if not sample_size or not rounds:
            return PlayerSummary(scope=scope, metrics=[])

        total_hits = headshots + bodyshots + legshots
        metrics = [
            Metric(name="ADR", value=round(damage / rounds, 2), unit="damage/round"),
            Metric(name="ACS", value=round(score / rounds, 2), unit="score/round"),
            Metric(name="K/D", value=round(kills / deaths, 2) if deaths else float(kills), unit="ratio"),
            Metric(
                name="Headshot rate",
                value=round(headshots / total_hits * 100, 2) if total_hits else 0.0,
                unit="%",
            ),
            Metric(
                name="First-death rate",
                value=round(first_deaths / rounds * 100, 2),
                unit="%",
            ),
        ]
        return PlayerSummary(scope=scope, metrics=metrics)

    def get_match_list(self, *, user_id: str, limit: int) -> MatchList:
        with psycopg.connect(self._database_url) as connection:
            rows = connection.execute(
                """
                SELECT matches.match_id, matches.map_id, matches.game_start_millis,
                       stats.team_id,
                       COUNT(rounds.round_number) FILTER (WHERE rounds.winning_team = stats.team_id) AS wins,
                       COUNT(rounds.round_number) FILTER (WHERE rounds.winning_team <> stats.team_id) AS losses,
                       COUNT(*) OVER () AS sample_size,
                       MIN(matches.game_start_millis) OVER () AS period_start,
                       MAX(matches.game_start_millis) OVER () AS period_end
                FROM riot_accounts accounts
                JOIN player_match_stats stats ON stats.riot_account_id = accounts.id
                JOIN matches ON matches.match_id = stats.match_id
                LEFT JOIN match_rounds rounds ON rounds.match_id = matches.match_id
                WHERE accounts.user_id = %s
                  AND matches.queue_id = %s
                  AND matches.is_ranked = TRUE
                  AND matches.is_completed = TRUE
                GROUP BY matches.match_id, matches.map_id, matches.game_start_millis, stats.team_id
                ORDER BY matches.game_start_millis DESC NULLS LAST, matches.match_id
                LIMIT %s
                """,
                (user_id, COMPETITIVE_QUEUE_ID, limit),
            ).fetchall()

        sample_size = rows[0][6] if rows else 0
        period_start = rows[0][7] if rows else None
        period_end = rows[0][8] if rows else None
        matches = [
            MatchSummary(
                match_id=row[0],
                map_name=row[1] or "Unknown map",
                played_at=_iso_time(row[2]) or "Unknown time",
                result="win" if row[4] > row[5] else "loss",
            )
            for row in rows
        ]
        return MatchList(scope=self._scope(sample_size, period_start, period_end), matches=matches)

    def get_round_evidence(
        self, *, user_id: str, match_id: str, round_number: int
    ) -> RoundEvidenceResult:
        with psycopg.connect(self._database_url) as connection:
            rows = connection.execute(
                """
                SELECT kills.is_killer, kills.is_victim, kills.is_assistant,
                       kills.is_first_death, kills.round_time_millis,
                       kills.finishing_item
                FROM riot_accounts accounts
                JOIN player_match_stats stats ON stats.riot_account_id = accounts.id
                JOIN matches ON matches.match_id = stats.match_id
                JOIN round_kills kills ON kills.match_id = stats.match_id
                    AND kills.riot_account_id = accounts.id
                WHERE accounts.user_id = %s
                  AND matches.match_id = %s
                  AND kills.round_number = %s
                  AND matches.queue_id = %s
                  AND matches.is_ranked = TRUE
                  AND matches.is_completed = TRUE
                ORDER BY kills.game_time_millis NULLS LAST, kills.kill_index
                """,
                (user_id, match_id, round_number, COMPETITIVE_QUEUE_ID),
            ).fetchall()

        evidence: list[RoundEvidence] = []
        for is_killer, is_victim, is_assistant, is_first_death, round_time, weapon in rows:
            time_note = f" at {round_time} ms" if round_time is not None else ""
            weapon_note = f" with {weapon}" if weapon else ""
            if is_first_death:
                description = f"You were the first player eliminated{time_note}{weapon_note}."
                event_type = "first_death"
            elif is_victim:
                description = f"You were eliminated{time_note}{weapon_note}."
                event_type = "death"
            elif is_killer:
                description = f"You secured a kill{time_note}{weapon_note}."
                event_type = "kill"
            else:
                description = f"You assisted on a kill{time_note}{weapon_note}."
                event_type = "assist"
            evidence.append(
                RoundEvidence(
                    match_id=match_id,
                    round_number=round_number,
                    event_type=event_type,
                    description=description,
                )
            )
        return RoundEvidenceResult(
            scope=DataScope(queue=COMPETITIVE_QUEUE_ID, sample_size=1 if rows else 0),
            evidence=evidence,
        )

    @staticmethod
    def _scope(sample_size: int, period_start: int | None, period_end: int | None) -> DataScope:
        limitation = None
        if sample_size == 0:
            limitation = "No completed competitive matches are available."
        elif sample_size < 5:
            limitation = "Small sample; use this as a review signal, not a stable trend."
        return DataScope(
            queue=COMPETITIVE_QUEUE_ID,
            sample_size=sample_size,
            period_start=_iso_time(period_start),
            period_end=_iso_time(period_end),
            limitation=limitation,
        )
