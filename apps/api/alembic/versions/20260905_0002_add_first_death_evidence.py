"""Store the deterministic first-death marker with personal kill evidence."""

from alembic import op
import sqlalchemy as sa


revision = "20260905_0002"
down_revision = "20260905_0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "round_kills",
        sa.Column("is_first_death", sa.Boolean(), nullable=False, server_default=sa.false()),
    )


def downgrade() -> None:
    op.drop_column("round_kills", "is_first_death")
