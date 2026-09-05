import unittest

import httpx

from app.riot.match_api import (
    RiotMatchClient,
    RiotRateLimitError,
    competitive_history_entries,
    is_completed_competitive_match,
)


class RiotMatchApiTests(unittest.IsolatedAsyncioTestCase):
    async def test_uses_server_side_api_key_and_match_endpoint(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            self.assertEqual(request.headers["X-Riot-Token"], "test-key")
            self.assertEqual(request.url.path, "/val/match/v1/matches/match-1")
            return httpx.Response(200, json={"matchInfo": {"matchId": "match-1"}})

        client = RiotMatchClient(
            api_key="test-key",
            platform="ap",
            client=httpx.AsyncClient(
                base_url="https://ap.api.riotgames.com", transport=httpx.MockTransport(handler)
            ),
        )
        payload = await client.get_match(match_id="match-1")
        self.assertEqual(payload["matchInfo"]["matchId"], "match-1")

    async def test_429_retries_then_raises_a_safe_error(self) -> None:
        calls = 0

        def handler(_: httpx.Request) -> httpx.Response:
            nonlocal calls
            calls += 1
            return httpx.Response(429, headers={"Retry-After": "0"})

        async def no_sleep(_: float) -> None:
            return None

        client = RiotMatchClient(
            api_key="test-key",
            platform="ap",
            max_attempts=2,
            sleep=no_sleep,
            client=httpx.AsyncClient(
                base_url="https://ap.api.riotgames.com", transport=httpx.MockTransport(handler)
            ),
        )
        with self.assertRaises(RiotRateLimitError):
            await client.get_match(match_id="match-1")
        self.assertEqual(calls, 2)

    def test_competitive_filter_requires_the_official_queue_and_final_state(self) -> None:
        history = {"history": [{"queueId": "competitive"}, {"queueId": "unrated"}]}
        self.assertEqual(competitive_history_entries(history), [{"queueId": "competitive"}])
        self.assertTrue(is_completed_competitive_match({"matchInfo": {"queueId": "competitive", "isRanked": True, "isCompleted": True}}))
        self.assertFalse(is_completed_competitive_match({"matchInfo": {"queueId": "competitive", "isRanked": False, "isCompleted": True}}))
