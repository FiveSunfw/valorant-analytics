"""Create the authorized VALORANT match-analysis schema.

Columns map to Riot VAL Match-v1's MatchInfoDto, PlayerDto/PlayerStatsDto,
RoundResultDto, PlayerRoundStatsDto, KillDto, and DamageDto. The full DTO is
also retained in ``matches.raw_payload`` for forward compatibility.
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision = "20260905_0001"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    uuid = postgresql.UUID(as_uuid=True)
    jsonb = postgresql.JSONB(astext_type=sa.Text())
    timestamp = sa.DateTime(timezone=True)

    op.create_table(
        "users",
        sa.Column("id", uuid, primary_key=True),
        sa.Column("created_at", timestamp, nullable=False, server_default=sa.text("now()")),
        sa.Column("updated_at", timestamp, nullable=False, server_default=sa.text("now()")),
    )
    op.create_table(
        "riot_accounts",
        sa.Column("id", uuid, primary_key=True),
        sa.Column("user_id", uuid, sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("rso_subject", sa.String(255), nullable=False, unique=True),
        sa.Column("puuid", sa.String(128), nullable=False, unique=True),
        sa.Column("game_name", sa.String(64)),
        sa.Column("tag_line", sa.String(16)),
        sa.Column("platform", sa.String(16), nullable=False),
        sa.Column("created_at", timestamp, nullable=False, server_default=sa.text("now()")),
        sa.Column("updated_at", timestamp, nullable=False, server_default=sa.text("now()")),
    )
    op.create_table(
        "riot_tokens",
        sa.Column("id", uuid, primary_key=True),
        sa.Column("riot_account_id", uuid, sa.ForeignKey("riot_accounts.id", ondelete="CASCADE"), nullable=False, unique=True),
        sa.Column("encrypted_access_token", sa.LargeBinary(), nullable=False),
        sa.Column("encrypted_refresh_token", sa.LargeBinary()),
        sa.Column("access_token_expires_at", timestamp),
        sa.Column("scopes", jsonb, nullable=False, server_default=sa.text("'[]'::jsonb")),
        sa.Column("created_at", timestamp, nullable=False, server_default=sa.text("now()")),
        sa.Column("updated_at", timestamp, nullable=False, server_default=sa.text("now()")),
    )
    op.create_table(
        "matches",
        sa.Column("match_id", sa.String(128), primary_key=True),
        sa.Column("region", sa.String(16)),
        sa.Column("map_id", sa.Text()),
        sa.Column("game_version", sa.String(64)),
        sa.Column("game_length_millis", sa.BigInteger()),
        sa.Column("game_start_millis", sa.BigInteger()),
        sa.Column("provisioning_flow_id", sa.String(64)),
        sa.Column("is_completed", sa.Boolean()),
        sa.Column("custom_game_name", sa.Text()),
        sa.Column("queue_id", sa.String(64)),
        sa.Column("game_mode", sa.String(64)),
        sa.Column("is_ranked", sa.Boolean()),
        sa.Column("season_id", sa.String(128)),
        sa.Column("premier_match_info", jsonb),
        sa.Column("raw_payload", jsonb, nullable=False),
        sa.Column("fetched_at", timestamp, nullable=False, server_default=sa.text("now()")),
    )
    op.create_index("ix_matches_game_start_millis", "matches", ["game_start_millis"])
    op.create_index("ix_matches_queue_id", "matches", ["queue_id"])
    op.create_table(
        "match_rounds",
        sa.Column("match_id", sa.String(128), sa.ForeignKey("matches.match_id", ondelete="CASCADE"), primary_key=True),
        sa.Column("round_number", sa.Integer(), primary_key=True),
        sa.Column("winning_team", sa.String(32)),
        sa.Column("winning_team_role", sa.String(32)),
        sa.Column("round_result", sa.String(64)),
        sa.Column("round_result_code", sa.String(64)),
        sa.Column("plant_round_time", sa.Integer()),
        sa.Column("plant_location", jsonb),
        sa.Column("plant_site", sa.String(16)),
    )
    op.create_table(
        "player_match_stats",
        sa.Column("match_id", sa.String(128), sa.ForeignKey("matches.match_id", ondelete="CASCADE"), primary_key=True),
        sa.Column("riot_account_id", uuid, sa.ForeignKey("riot_accounts.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("team_id", sa.String(32)),
        sa.Column("party_id", sa.String(128)),
        sa.Column("character_id", sa.String(128)),
        sa.Column("score", sa.Integer()),
        sa.Column("rounds_played", sa.Integer()),
        sa.Column("kills", sa.Integer()),
        sa.Column("deaths", sa.Integer()),
        sa.Column("assists", sa.Integer()),
        sa.Column("playtime_millis", sa.BigInteger()),
        sa.Column("ability_casts", jsonb),
        sa.Column("competitive_tier", sa.Integer()),
        sa.Column("account_level", sa.Integer()),
    )
    op.create_table(
        "player_round_stats",
        sa.Column("match_id", sa.String(128), primary_key=True),
        sa.Column("riot_account_id", uuid, primary_key=True),
        sa.Column("round_number", sa.Integer(), primary_key=True),
        sa.Column("score", sa.Integer()),
        sa.Column("economy", jsonb),
        sa.Column("ability", jsonb),
        sa.ForeignKeyConstraint(["match_id", "riot_account_id"], ["player_match_stats.match_id", "player_match_stats.riot_account_id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["match_id", "round_number"], ["match_rounds.match_id", "match_rounds.round_number"], ondelete="CASCADE"),
    )
    op.create_table(
        "round_kills",
        sa.Column("match_id", sa.String(128), primary_key=True),
        sa.Column("riot_account_id", uuid, primary_key=True),
        sa.Column("round_number", sa.Integer(), primary_key=True),
        sa.Column("kill_index", sa.Integer(), primary_key=True),
        sa.Column("is_killer", sa.Boolean(), nullable=False),
        sa.Column("is_victim", sa.Boolean(), nullable=False),
        sa.Column("is_assistant", sa.Boolean(), nullable=False),
        sa.Column("game_time_millis", sa.Integer()),
        sa.Column("round_time_millis", sa.Integer()),
        sa.Column("finishing_damage_type", sa.String(64)),
        sa.Column("finishing_item", sa.String(128)),
        sa.Column("is_secondary_fire_mode", sa.Boolean()),
        sa.ForeignKeyConstraint(["match_id", "riot_account_id", "round_number"], ["player_round_stats.match_id", "player_round_stats.riot_account_id", "player_round_stats.round_number"], ondelete="CASCADE"),
    )
    op.create_table(
        "round_damage",
        sa.Column("match_id", sa.String(128), primary_key=True),
        sa.Column("riot_account_id", uuid, primary_key=True),
        sa.Column("round_number", sa.Integer(), primary_key=True),
        sa.Column("damage_index", sa.Integer(), primary_key=True),
        sa.Column("damage", sa.Integer()),
        sa.Column("headshots", sa.Integer()),
        sa.Column("bodyshots", sa.Integer()),
        sa.Column("legshots", sa.Integer()),
        sa.ForeignKeyConstraint(["match_id", "riot_account_id", "round_number"], ["player_round_stats.match_id", "player_round_stats.riot_account_id", "player_round_stats.round_number"], ondelete="CASCADE"),
    )


def downgrade() -> None:
    op.drop_table("round_damage")
    op.drop_table("round_kills")
    op.drop_table("player_round_stats")
    op.drop_table("player_match_stats")
    op.drop_table("match_rounds")
    op.drop_index("ix_matches_queue_id", table_name="matches")
    op.drop_index("ix_matches_game_start_millis", table_name="matches")
    op.drop_table("matches")
    op.drop_table("riot_tokens")
    op.drop_table("riot_accounts")
    op.drop_table("users")
