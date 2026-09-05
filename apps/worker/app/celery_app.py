import json
import os
from collections.abc import Iterable
from typing import Any
from uuid import UUID

import psycopg
from celery import Celery

COMPETITIVE_QUEUE_ID = "competitive"

celery = Celery("valorant_worker", broker=os.getenv("REDIS_URL", "redis://localhost:6379/0"))

@celery.task
def health_task() -> str:
    return "ok"


def _database_url() -> str:
    return os.getenv(
        "DATABASE_URL",
        "postgresql+psycopg://valorant:valorant_dev@127.0.0.1:15432/valorant",
    ).replace("postgresql+psycopg://", "postgresql://", 1)


def _is_completed_competitive_match(match: dict[str, Any]) -> bool:
    info = match.get("matchInfo")
    return bool(
        isinstance(info, dict)
        and info.get("queueId") == COMPETITIVE_QUEUE_ID
        and info.get("isRanked") is True
        and info.get("isCompleted") is True
    )


def _json(value: Any) -> str:
    return json.dumps(value, separators=(",", ":"))


def _kill_identity(kill: dict[str, Any]) -> tuple[Any, ...]:
    """Return a stable match-local identity for duplicated round kill records."""

    return (
        kill.get("killer"),
        kill.get("victim"),
        kill.get("gameTime"),
        kill.get("roundTime"),
        _json(kill.get("finishingDamage")),
    )


def _first_kill_identity(round_data: dict[str, Any]) -> tuple[Any, ...] | None:
    """Find the first global elimination without persisting other players' events."""

    unique_kills: dict[tuple[Any, ...], dict[str, Any]] = {}
    for player_round in round_data.get("playerStats", []):
        if not isinstance(player_round, dict):
            continue
        for kill in player_round.get("kills", []):
            if isinstance(kill, dict) and kill.get("victim"):
                unique_kills.setdefault(_kill_identity(kill), kill)
    if not unique_kills:
        return None
    return min(
        unique_kills,
        key=lambda identity: (
            unique_kills[identity].get("gameTime") or 0,
            unique_kills[identity].get("roundTime") or 0,
        ),
    )


def persist_fixture_matches(
    *, riot_account_id: str, match_payloads: Iterable[dict[str, Any]]
) -> dict[str, int]:
    """Persist offline Match-v1 fixtures for one authorized Riot account."""

    account_id = UUID(riot_account_id)
    imported = 0
    skipped = 0
    with psycopg.connect(_database_url()) as connection:
        with connection.cursor() as cursor:
            cursor.execute("SELECT puuid FROM riot_accounts WHERE id = %s", (account_id,))
            account = cursor.fetchone()
            if account is None:
                raise ValueError("authorized Riot account was not found")
            puuid = account[0]

            for match in match_payloads:
                if not _is_completed_competitive_match(match):
                    skipped += 1
                    continue
                info = match["matchInfo"]
                match_id = info.get("matchId")
                if not isinstance(match_id, str) or not match_id:
                    raise ValueError("fixture match is missing matchInfo.matchId")
                player = next(
                    (
                        candidate for candidate in match.get("players", [])
                        if isinstance(candidate, dict) and candidate.get("puuid") == puuid
                    ),
                    None,
                )
                if player is None:
                    skipped += 1
                    continue

                cursor.execute(
                    """
                    INSERT INTO matches (
                        match_id, region, map_id, game_version, game_length_millis,
                        game_start_millis, provisioning_flow_id, is_completed,
                        custom_game_name, queue_id, game_mode, is_ranked, season_id,
                        premier_match_info, raw_payload
                    ) VALUES (
                        %(match_id)s, %(region)s, %(map_id)s, %(game_version)s,
                        %(game_length_millis)s, %(game_start_millis)s,
                        %(provisioning_flow_id)s, %(is_completed)s,
                        %(custom_game_name)s, %(queue_id)s, %(game_mode)s,
                        %(is_ranked)s, %(season_id)s, %(premier_match_info)s::jsonb,
                        %(raw_payload)s::jsonb
                    ) ON CONFLICT (match_id) DO UPDATE SET
                        raw_payload = EXCLUDED.raw_payload, fetched_at = now()
                    """,
                    {
                        "match_id": match_id,
                        "region": info.get("region"),
                        "map_id": info.get("mapId"),
                        "game_version": info.get("gameVersion"),
                        "game_length_millis": info.get("gameLengthMillis"),
                        "game_start_millis": info.get("gameStartMillis"),
                        "provisioning_flow_id": info.get("provisioningFlowId"),
                        "is_completed": info.get("isCompleted"),
                        "custom_game_name": info.get("customGameName"),
                        "queue_id": info.get("queueId"),
                        "game_mode": info.get("gameMode"),
                        "is_ranked": info.get("isRanked"),
                        "season_id": info.get("seasonId"),
                        "premier_match_info": _json(info.get("premierMatchInfo")),
                        "raw_payload": _json(match),
                    },
                )
                for round_data in match.get("roundResults", []):
                    if not isinstance(round_data, dict) or not isinstance(round_data.get("roundNum"), int):
                        continue
                    cursor.execute(
                        """
                        INSERT INTO match_rounds (
                            match_id, round_number, winning_team, winning_team_role,
                            round_result, round_result_code, plant_round_time,
                            plant_location, plant_site
                        ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s::jsonb, %s)
                        ON CONFLICT (match_id, round_number) DO UPDATE SET
                            winning_team = EXCLUDED.winning_team,
                            winning_team_role = EXCLUDED.winning_team_role,
                            round_result = EXCLUDED.round_result,
                            round_result_code = EXCLUDED.round_result_code,
                            plant_round_time = EXCLUDED.plant_round_time,
                            plant_location = EXCLUDED.plant_location,
                            plant_site = EXCLUDED.plant_site
                        """,
                        (
                            match_id, round_data["roundNum"] + 1,
                            round_data.get("winningTeam"), round_data.get("winningTeamRole"),
                            round_data.get("roundResult"), round_data.get("roundResultCode"),
                            round_data.get("plantRoundTime"), _json(round_data.get("plantLocation")),
                            round_data.get("plantSite"),
                        ),
                    )

                cursor.execute(
                    "DELETE FROM player_match_stats WHERE match_id = %s AND riot_account_id = %s",
                    (match_id, account_id),
                )
                stats = player.get("stats", {})
                cursor.execute(
                    """
                    INSERT INTO player_match_stats (
                        match_id, riot_account_id, team_id, party_id, character_id,
                        score, rounds_played, kills, deaths, assists,
                        playtime_millis, ability_casts, competitive_tier, account_level
                    ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb, %s, %s)
                    """,
                    (
                        match_id, account_id, player.get("teamId"), player.get("partyId"),
                        player.get("characterId"), stats.get("score"),
                        stats.get("roundsPlayed"), stats.get("kills"), stats.get("deaths"),
                        stats.get("assists"), stats.get("playtimeMillis"),
                        _json(stats.get("abilityCasts")), player.get("competitiveTier"),
                        player.get("accountLevel"),
                    ),
                )
                _insert_player_round_evidence(cursor, match_id, account_id, puuid, match)
                imported += 1
    return {"imported": imported, "skipped": skipped}


def _insert_player_round_evidence(
    cursor: psycopg.Cursor[Any], match_id: str, account_id: UUID, puuid: str,
    match: dict[str, Any],
) -> None:
    for round_data in match.get("roundResults", []):
        if not isinstance(round_data, dict) or not isinstance(round_data.get("roundNum"), int):
            continue
        player_round = next(
            (item for item in round_data.get("playerStats", [])
             if isinstance(item, dict) and item.get("puuid") == puuid),
            None,
        )
        if player_round is None:
            continue
        round_number = round_data["roundNum"] + 1
        first_kill = _first_kill_identity(round_data)
        cursor.execute(
            """
            INSERT INTO player_round_stats (
                match_id, riot_account_id, round_number, score, economy, ability
            ) VALUES (%s, %s, %s, %s, %s::jsonb, %s::jsonb)
            """,
            (match_id, account_id, round_number, player_round.get("score"),
             _json(player_round.get("economy")), _json(player_round.get("ability"))),
        )
        for index, kill in enumerate(player_round.get("kills", [])):
            if not isinstance(kill, dict):
                continue
            assistants = kill.get("assistants") or []
            is_killer = kill.get("killer") == puuid
            is_victim = kill.get("victim") == puuid
            is_assistant = puuid in assistants
            if not (is_killer or is_victim or is_assistant):
                continue
            finishing_damage = kill.get("finishingDamage") or {}
            cursor.execute(
                """
                INSERT INTO round_kills (
                    match_id, riot_account_id, round_number, kill_index,
                    is_killer, is_victim, is_assistant, game_time_millis,
                    is_first_death, round_time_millis, finishing_damage_type, finishing_item,
                    is_secondary_fire_mode
                ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                """,
                (
                    match_id, account_id, round_number, index, is_killer, is_victim,
                    is_assistant, kill.get("gameTime"),
                    bool(is_victim and first_kill == _kill_identity(kill)), kill.get("roundTime"),
                    finishing_damage.get("damageType"), finishing_damage.get("damageItem"),
                    finishing_damage.get("isSecondaryFireMode"),
                ),
            )
        for index, damage in enumerate(player_round.get("damage", [])):
            if not isinstance(damage, dict):
                continue
            cursor.execute(
                """
                INSERT INTO round_damage (
                    match_id, riot_account_id, round_number, damage_index, damage,
                    headshots, bodyshots, legshots
                ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                """,
                (
                    match_id, account_id, round_number, index, damage.get("damage"),
                    damage.get("headshots"), damage.get("bodyshots"), damage.get("legshots"),
                ),
            )


@celery.task(name="valorant.sync_fixture_matches")
def sync_fixture_matches_task(
    riot_account_id: str, match_payloads: list[dict[str, Any]]
) -> dict[str, int]:
    """Run fixture ingestion in the Worker, not in an HTTP request."""

    return persist_fixture_matches(
        riot_account_id=riot_account_id, match_payloads=match_payloads
    )
