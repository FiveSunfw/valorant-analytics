"""Small, server-only client for Riot's VAL Match-v1 API."""

from __future__ import annotations

import asyncio
import os
import random
from collections.abc import Awaitable, Callable
from typing import Any

import httpx


COMPETITIVE_QUEUE_ID = "competitive"


class RiotApiError(RuntimeError):
    """A safe error classification for API callers; it never contains secrets."""

    def __init__(self, status_code: int, message: str) -> None:
        super().__init__(message)
        self.status_code = status_code


class RiotRateLimitError(RiotApiError):
    """Raised only after the configured retry budget for HTTP 429 is exhausted."""


class RiotConfigurationError(RuntimeError):
    """Raised when a required server-side integration setting is absent."""


Sleep = Callable[[float], Awaitable[None]]


class RiotMatchClient:
    """Fetch an already-authorized account's match history and match details.

    The PUUID passed here originates from ``riot_accounts`` in a future worker
    task; this class is deliberately not exposed as an HTTP or Agent tool.
    """

    def __init__(
        self,
        *,
        api_key: str,
        platform: str,
        client: httpx.AsyncClient | None = None,
        max_attempts: int = 3,
        sleep: Sleep = asyncio.sleep,
    ) -> None:
        if not api_key:
            raise RiotConfigurationError("RIOT_API_KEY is required for VAL Match API calls")
        if not platform:
            raise RiotConfigurationError("RIOT_PLATFORM is required for VAL Match API calls")
        if max_attempts < 1:
            raise ValueError("max_attempts must be at least 1")
        self._api_key = api_key
        self._platform = platform.lower()
        self._max_attempts = max_attempts
        self._sleep = sleep
        self._client = client or httpx.AsyncClient(
            base_url=f"https://{self._platform}.api.riotgames.com",
            timeout=httpx.Timeout(10.0),
        )
        self._owns_client = client is None

    @classmethod
    def from_environment(cls) -> "RiotMatchClient":
        return cls(
            api_key=os.getenv("RIOT_API_KEY", ""),
            platform=os.getenv("RIOT_PLATFORM", ""),
        )

    async def aclose(self) -> None:
        if self._owns_client:
            await self._client.aclose()

    async def get_match_history(self, *, puuid: str) -> dict[str, Any]:
        return await self._get_json(f"/val/match/v1/matchlists/by-puuid/{puuid}")

    async def get_match(self, *, match_id: str) -> dict[str, Any]:
        return await self._get_json(f"/val/match/v1/matches/{match_id}")

    async def _get_json(self, path: str) -> dict[str, Any]:
        for attempt in range(self._max_attempts):
            try:
                response = await self._client.get(path, headers={"X-Riot-Token": self._api_key})
            except httpx.TimeoutException as exc:
                if attempt + 1 == self._max_attempts:
                    raise RiotApiError(504, "Riot Match API timed out") from exc
                await self._backoff(attempt)
                continue
            except httpx.HTTPError as exc:
                raise RiotApiError(502, "Riot Match API request failed") from exc

            if response.status_code == 429:
                if attempt + 1 == self._max_attempts:
                    raise RiotRateLimitError(429, "Riot Match API rate limit exhausted")
                await self._backoff(attempt, response.headers.get("Retry-After"))
                continue
            if response.status_code >= 500:
                if attempt + 1 == self._max_attempts:
                    raise RiotApiError(response.status_code, "Riot Match API server error")
                await self._backoff(attempt)
                continue
            if response.status_code in (401, 403, 404):
                raise RiotApiError(response.status_code, "Riot Match API rejected the request")
            if response.is_error:
                raise RiotApiError(response.status_code, "Riot Match API returned an unexpected error")

            payload = response.json()
            if not isinstance(payload, dict):
                raise RiotApiError(502, "Riot Match API returned an invalid payload")
            return payload
        raise AssertionError("retry loop must return or raise")

    async def _backoff(self, attempt: int, retry_after: str | None = None) -> None:
        try:
            delay = float(retry_after) if retry_after is not None else 0.5 * (2**attempt)
        except ValueError:
            delay = 0.5 * (2**attempt)
        await self._sleep(delay + random.uniform(0, 0.25))


def competitive_history_entries(match_history: dict[str, Any]) -> list[dict[str, Any]]:
    """Filter MatchlistDto history before scheduling match-detail requests."""

    history = match_history.get("history", [])
    if not isinstance(history, list):
        return []
    return [
        entry
        for entry in history
        if isinstance(entry, dict) and entry.get("queueId") == COMPETITIVE_QUEUE_ID
    ]


def is_completed_competitive_match(match: dict[str, Any]) -> bool:
    """The final filter used before any match becomes analyzable data."""

    info = match.get("matchInfo")
    return bool(
        isinstance(info, dict)
        and info.get("isCompleted") is True
        and info.get("isRanked") is True
        and info.get("queueId") == COMPETITIVE_QUEUE_ID
    )
