"""OpenAI Agents SDK definition for the VALORANT post-match analyst.

This module deliberately contains no database queries or Riot credentials.  The
FastAPI service supplies an authenticated user and a read-only analytics
reader for every run; SDK tools can therefore never select an arbitrary PUUID.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Annotated, Literal, Protocol

from agents import Agent, OpenAIChatCompletionsModel, RunContextWrapper, function_tool
from openai import AsyncOpenAI
from pydantic import BaseModel, ConfigDict, Field


class DataScope(BaseModel):
    """The fixed scope returned with every analytics result."""

    model_config = ConfigDict(extra="forbid")

    queue: Literal["competitive"] = "competitive"
    sample_size: int = Field(ge=0)
    period_start: str | None = None
    period_end: str | None = None
    limitation: str | None = None


class Metric(BaseModel):
    """A deterministic metric that the agent may cite."""

    model_config = ConfigDict(extra="forbid")

    name: str
    value: float
    unit: str


class PlayerSummary(BaseModel):
    model_config = ConfigDict(extra="forbid")

    scope: DataScope
    metrics: list[Metric]


class MatchSummary(BaseModel):
    model_config = ConfigDict(extra="forbid")

    match_id: str
    map_name: str
    played_at: str
    result: Literal["win", "loss"]


class MatchList(BaseModel):
    model_config = ConfigDict(extra="forbid")

    scope: DataScope
    matches: list[MatchSummary]


class RoundEvidence(BaseModel):
    model_config = ConfigDict(extra="forbid")

    match_id: str
    round_number: int = Field(ge=1)
    event_type: str
    description: str


class RoundEvidenceResult(BaseModel):
    model_config = ConfigDict(extra="forbid")

    scope: DataScope
    evidence: list[RoundEvidence]


class EvidenceCitation(BaseModel):
    """A user-visible reference to deterministic output or a concrete round."""

    model_config = ConfigDict(extra="forbid")

    claim: str
    metric_name: str | None = None
    match_id: str | None = None
    round_number: int | None = Field(default=None, ge=1)


class Recommendation(BaseModel):
    model_config = ConfigDict(extra="forbid")

    action: str
    rationale: str


class AnalysisAnswer(BaseModel):
    """Structured final answer required from the analysis agent."""

    model_config = ConfigDict(extra="forbid")

    conclusion: str
    evidence: list[EvidenceCitation]
    confidence: Literal["low", "medium", "high"]
    recommendations: list[Recommendation]
    limitations: list[str]


class AnalyticsReader(Protocol):
    """Read-only boundary implemented later by the metrics repository."""

    def get_player_summary(self, *, user_id: str) -> PlayerSummary: ...

    def get_match_list(self, *, user_id: str, limit: int) -> MatchList: ...

    def get_round_evidence(
        self, *, user_id: str, match_id: str, round_number: int
    ) -> RoundEvidenceResult: ...


@dataclass(frozen=True)
class AuthenticatedUser:
    """Per-run dependency container; PUUIDs are intentionally absent."""

    user_id: str
    analytics_reader: AnalyticsReader


@function_tool
def get_player_summary(context: RunContextWrapper[AuthenticatedUser]) -> PlayerSummary:
    """Get the authenticated player's competitive summary for the available period."""

    return context.context.analytics_reader.get_player_summary(
        user_id=context.context.user_id
    )


@function_tool
def get_match_list(
    context: RunContextWrapper[AuthenticatedUser],
    limit: Annotated[int, Field(ge=1, le=10)] = 5,
) -> MatchList:
    """List up to ten recent competitive matches for the authenticated player."""

    return context.context.analytics_reader.get_match_list(
        user_id=context.context.user_id, limit=limit
    )


@function_tool
def get_round_evidence(
    context: RunContextWrapper[AuthenticatedUser],
    match_id: str,
    round_number: Annotated[int, Field(ge=1)],
) -> RoundEvidenceResult:
    """Retrieve a concrete competitive-round event from the authenticated player's match."""

    return context.context.analytics_reader.get_round_evidence(
        user_id=context.context.user_id,
        match_id=match_id,
        round_number=round_number,
    )


TOOL_NAMES = (
    "get_player_summary",
    "get_match_list",
    "get_round_evidence",
)

ANALYSIS_INSTRUCTIONS = """
You are a VALORANT international-server post-match analyst. Analyze only the
authenticated player's historical competitive matches. Never offer pre-match
opponent scouting, real-time match instructions, cheating assistance, or a
replacement MMR/ELO score. Use the registered tools before making factual
claims. Every conclusion must cite a returned metric or match/round evidence.
When the sample is inadequate or evidence is unavailable, say so plainly and
lower confidence. Do not request, reveal, or reason about Riot credentials.
""".strip()


def build_analysis_model() -> OpenAIChatCompletionsModel | None:
    """Use the server-side DeepSeek-compatible endpoint when configured.

    Returning ``None`` preserves the SDK default model for local contract tests
    that intentionally run without any model credential.
    """

    api_key = os.getenv("DEEPSEEK_API_KEY")
    if not api_key:
        return None
    return OpenAIChatCompletionsModel(
        model=os.getenv("DEEPSEEK_MODEL", "deepseekv4flash"),
        openai_client=AsyncOpenAI(
            api_key=api_key,
            base_url=os.getenv("DEEPSEEK_BASE_URL", "https://api.deepseek.com/v1"),
        ),
    )


def build_analysis_agent() -> Agent[AuthenticatedUser]:
    """Construct the SDK-managed agent without making a model request."""

    model = build_analysis_model()
    return Agent[AuthenticatedUser](
        name="VALORANT Post-Match Analyst",
        instructions=ANALYSIS_INSTRUCTIONS,
        tools=[get_player_summary, get_match_list, get_round_evidence],
        output_type=AnalysisAnswer,
        model=model,
    )
