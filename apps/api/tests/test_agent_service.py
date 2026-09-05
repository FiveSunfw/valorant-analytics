import unittest

from fastapi.testclient import TestClient

from app.agent.service import AnalysisAnswer, TOOL_NAMES, build_analysis_agent
from app.main import app


class AgentServiceTests(unittest.TestCase):
    def test_health_reports_local_dependencies(self) -> None:
        response = TestClient(app).get("/health")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["database"], "ok")
        self.assertEqual(response.json()["redis"], "ok")

    def test_agent_registers_only_current_user_tools(self) -> None:
        agent = build_analysis_agent()

        self.assertEqual(tuple(tool.name for tool in agent.tools), TOOL_NAMES)
        self.assertNotIn("puuid", " ".join(TOOL_NAMES))

    def test_final_answer_requires_traceable_contract(self) -> None:
        answer = AnalysisAnswer.model_validate(
            {
                "conclusion": "Recent data is insufficient for a stable conclusion.",
                "evidence": [],
                "confidence": "low",
                "recommendations": [],
                "limitations": ["Only two competitive matches are available."],
            }
        )

        self.assertEqual(answer.confidence, "low")


if __name__ == "__main__":
    unittest.main()
