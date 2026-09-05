"""Persistence model for authorized VALORANT match analysis.

Full Riot responses remain in ``matches.raw_payload``. The normalized tables
contain only the authorized account's queryable match and round evidence.
"""

from __future__ import annotations

from datetime import datetime
from uuid import UUID

from sqlalchemy import BigInteger, Boolean, DateTime, ForeignKey, ForeignKeyConstraint, Integer, String, Text
from sqlalchemy.dialects.postgresql import JSONB, UUID as PG_UUID
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column
from sqlalchemy.sql import func


class Base(DeclarativeBase):
    """Base metadata used by Alembic."""


class Timestamped:
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )


class User(Timestamped, Base):
    __tablename__ = "users"

    id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), primary_key=True)


class RiotAccount(Timestamped, Base):
    __tablename__ = "riot_accounts"

    id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), primary_key=True)
    user_id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    rso_subject: Mapped[str] = mapped_column(String(255), unique=True, nullable=False)
    puuid: Mapped[str] = mapped_column(String(128), unique=True, nullable=False)
    game_name: Mapped[str | None] = mapped_column(String(64))
    tag_line: Mapped[str | None] = mapped_column(String(16))
    platform: Mapped[str] = mapped_column(String(16), nullable=False)


class RiotToken(Timestamped, Base):
    __tablename__ = "riot_tokens"

    id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), primary_key=True)
    riot_account_id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), ForeignKey("riot_accounts.id", ondelete="CASCADE"), unique=True, nullable=False)
    encrypted_access_token: Mapped[bytes] = mapped_column(nullable=False)
    encrypted_refresh_token: Mapped[bytes | None] = mapped_column()
    access_token_expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    scopes: Mapped[list[str]] = mapped_column(JSONB, nullable=False, server_default="'[]'::jsonb")


class Match(Base):
    __tablename__ = "matches"

    match_id: Mapped[str] = mapped_column(String(128), primary_key=True)
    region: Mapped[str | None] = mapped_column(String(16))
    map_id: Mapped[str | None] = mapped_column(Text)
    game_version: Mapped[str | None] = mapped_column(String(64))
    game_length_millis: Mapped[int | None] = mapped_column(BigInteger)
    game_start_millis: Mapped[int | None] = mapped_column(BigInteger, index=True)
    provisioning_flow_id: Mapped[str | None] = mapped_column(String(64))
    is_completed: Mapped[bool | None] = mapped_column(Boolean)
    custom_game_name: Mapped[str | None] = mapped_column(Text)
    queue_id: Mapped[str | None] = mapped_column(String(64), index=True)
    game_mode: Mapped[str | None] = mapped_column(String(64))
    is_ranked: Mapped[bool | None] = mapped_column(Boolean)
    season_id: Mapped[str | None] = mapped_column(String(128))
    premier_match_info: Mapped[dict | None] = mapped_column(JSONB)
    raw_payload: Mapped[dict] = mapped_column(JSONB, nullable=False)
    fetched_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())


class MatchRound(Base):
    __tablename__ = "match_rounds"

    match_id: Mapped[str] = mapped_column(String(128), ForeignKey("matches.match_id", ondelete="CASCADE"), primary_key=True)
    round_number: Mapped[int] = mapped_column(Integer, primary_key=True)
    winning_team: Mapped[str | None] = mapped_column(String(32))
    winning_team_role: Mapped[str | None] = mapped_column(String(32))
    round_result: Mapped[str | None] = mapped_column(String(64))
    round_result_code: Mapped[str | None] = mapped_column(String(64))
    plant_round_time: Mapped[int | None] = mapped_column(Integer)
    plant_location: Mapped[dict | None] = mapped_column(JSONB)
    plant_site: Mapped[str | None] = mapped_column(String(16))


class PlayerMatchStats(Base):
    __tablename__ = "player_match_stats"

    match_id: Mapped[str] = mapped_column(String(128), ForeignKey("matches.match_id", ondelete="CASCADE"), primary_key=True)
    riot_account_id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), ForeignKey("riot_accounts.id", ondelete="CASCADE"), primary_key=True)
    team_id: Mapped[str | None] = mapped_column(String(32))
    party_id: Mapped[str | None] = mapped_column(String(128))
    character_id: Mapped[str | None] = mapped_column(String(128))
    score: Mapped[int | None] = mapped_column(Integer)
    rounds_played: Mapped[int | None] = mapped_column(Integer)
    kills: Mapped[int | None] = mapped_column(Integer)
    deaths: Mapped[int | None] = mapped_column(Integer)
    assists: Mapped[int | None] = mapped_column(Integer)
    playtime_millis: Mapped[int | None] = mapped_column(BigInteger)
    ability_casts: Mapped[dict | None] = mapped_column(JSONB)
    competitive_tier: Mapped[int | None] = mapped_column(Integer)
    account_level: Mapped[int | None] = mapped_column(Integer)


class PlayerRoundStats(Base):
    __tablename__ = "player_round_stats"
    __table_args__ = (
        ForeignKeyConstraint(
            ["match_id", "riot_account_id"],
            ["player_match_stats.match_id", "player_match_stats.riot_account_id"],
            ondelete="CASCADE",
        ),
        ForeignKeyConstraint(
            ["match_id", "round_number"],
            ["match_rounds.match_id", "match_rounds.round_number"],
            ondelete="CASCADE",
        ),
    )

    match_id: Mapped[str] = mapped_column(String(128), primary_key=True)
    riot_account_id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), primary_key=True)
    round_number: Mapped[int] = mapped_column(Integer, primary_key=True)
    score: Mapped[int | None] = mapped_column(Integer)
    economy: Mapped[dict | None] = mapped_column(JSONB)
    ability: Mapped[dict | None] = mapped_column(JSONB)


class RoundKill(Base):
    __tablename__ = "round_kills"
    __table_args__ = (
        ForeignKeyConstraint(
            ["match_id", "riot_account_id", "round_number"],
            ["player_round_stats.match_id", "player_round_stats.riot_account_id", "player_round_stats.round_number"],
            ondelete="CASCADE",
        ),
    )

    match_id: Mapped[str] = mapped_column(String(128), primary_key=True)
    riot_account_id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), primary_key=True)
    round_number: Mapped[int] = mapped_column(Integer, primary_key=True)
    kill_index: Mapped[int] = mapped_column(Integer, primary_key=True)
    is_killer: Mapped[bool] = mapped_column(Boolean, nullable=False)
    is_victim: Mapped[bool] = mapped_column(Boolean, nullable=False)
    is_assistant: Mapped[bool] = mapped_column(Boolean, nullable=False)
    is_first_death: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default="false")
    game_time_millis: Mapped[int | None] = mapped_column(Integer)
    round_time_millis: Mapped[int | None] = mapped_column(Integer)
    finishing_damage_type: Mapped[str | None] = mapped_column(String(64))
    finishing_item: Mapped[str | None] = mapped_column(String(128))
    is_secondary_fire_mode: Mapped[bool | None] = mapped_column(Boolean)


class RoundDamage(Base):
    __tablename__ = "round_damage"
    __table_args__ = (
        ForeignKeyConstraint(
            ["match_id", "riot_account_id", "round_number"],
            ["player_round_stats.match_id", "player_round_stats.riot_account_id", "player_round_stats.round_number"],
            ondelete="CASCADE",
        ),
    )

    match_id: Mapped[str] = mapped_column(String(128), primary_key=True)
    riot_account_id: Mapped[UUID] = mapped_column(PG_UUID(as_uuid=True), primary_key=True)
    round_number: Mapped[int] = mapped_column(Integer, primary_key=True)
    damage_index: Mapped[int] = mapped_column(Integer, primary_key=True)
    damage: Mapped[int | None] = mapped_column(Integer)
    headshots: Mapped[int | None] = mapped_column(Integer)
    bodyshots: Mapped[int | None] = mapped_column(Integer)
    legshots: Mapped[int | None] = mapped_column(Integer)
