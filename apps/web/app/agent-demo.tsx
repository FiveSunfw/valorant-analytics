"use client";
import { useState } from "react";

type Answer = { conclusion: string; confidence: string; playerEvidence: Array<{ claim: string; metricName?: string; matchId?: string; roundNumber?: number }>; recommendations: Array<{ action: string; rationale: string }>; limitations: string[]; nextQuestions: string[] };
type Result = { runId: string; answer: Answer };
const presets = ["我的攻守方表现有什么差异？", "我最近的趋势如何？", "我为什么经常成为首死？", "我在 Haven 的表现如何？"];

export function AgentDemo() {
  const [loggedIn, setLoggedIn] = useState(false); const [question, setQuestion] = useState(presets[0]);
  const [result, setResult] = useState<Result | null>(null); const [error, setError] = useState<string | null>(null); const [loading, setLoading] = useState(false);
  async function demoLogin() { setLoading(true); setError(null); const response = await fetch("/api/auth/demo", { method: "POST" }); setLoading(false); if (!response.ok) return setError((await response.json()).message ?? "Demo 登录失败"); setLoggedIn(true); }
  async function analyze() { setLoading(true); setError(null); setResult(null); const response = await fetch("/api/agent/analyze", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question }) }); const payload = await response.json(); setLoading(false); if (!response.ok) return setError(payload.message ?? "分析失败，请重试。"); setResult(payload); }
  return <main style={{ fontFamily: "system-ui", maxWidth: 880, margin: "0 auto", padding: "48px 24px", lineHeight: 1.55 }}>
    <h1>VALORANT Analytics</h1><p>国际服竞技赛后复盘 · 单 Agent 演示</p>
    {!loggedIn ? <button disabled={loading} onClick={demoLogin}>登录 Demo 账号</button> : <><p style={{ color: "#16794b" }}>已登录固定 fixture 账号</p><div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>{presets.map((preset) => <button key={preset} onClick={() => setQuestion(preset)}>{preset}</button>)}</div><textarea value={question} onChange={(event) => setQuestion(event.target.value)} rows={3} style={{ display: "block", width: "100%", margin: "16px 0", padding: 10 }} /><button disabled={loading || !question.trim()} onClick={analyze}>{loading ? "分析中…" : "开始分析"}</button></>}
    {error && <section style={{ marginTop: 24, color: "#b42318" }}><p>{error}</p><button disabled={loading} onClick={loggedIn ? analyze : demoLogin}>重试</button></section>}
    {result && <section style={{ marginTop: 32, borderTop: "1px solid #ddd" }}><p><small>Run ID: {result.runId}</small></p><h2>{result.answer.conclusion}</h2><p>置信度：{result.answer.confidence}</p><h3>证据</h3><ul>{result.answer.playerEvidence.map((item, index) => <li key={index}>{item.claim}{item.metricName ? `（${item.metricName}）` : ""}{item.matchId ? ` · ${item.matchId} 第 ${item.roundNumber} 回合` : ""}</li>)}</ul><h3>建议</h3><ul>{result.answer.recommendations.map((item, index) => <li key={index}><strong>{item.action}</strong>：{item.rationale}</li>)}</ul><h3>限制</h3><ul>{result.answer.limitations.map((item) => <li key={item}>{item}</li>)}</ul><h3>下一步问题</h3><ul>{result.answer.nextQuestions.map((item) => <li key={item}>{item}</li>)}</ul></section>}
  </main>;
}
