"use client";

import { useEffect, useMemo, useState } from "react";

type MatchSummary = { matchId: string; mapName: string; playedAt: string; result: "win" | "loss" };
type MatchDetail = MatchSummary & {
  roundsWon: number;
  roundsLost: number;
  kills: number;
  deaths: number;
  assists: number;
  metrics?: { kd?: number; adr?: number; acs?: number; firstDeathRate?: number };
};
type Evidence = { claim: string; metricName?: string; matchId?: string; roundNumber?: number };
type Answer = {
  conclusion: string;
  confidence: "low" | "medium" | "high" | string;
  playerEvidence: Evidence[];
  knowledgeEvidence: Evidence[];
  recommendations: Array<{ action: string; rationale: string }>;
  limitations: string[];
  nextQuestions: string[];
};
type AnalysisResult = { runId: string; answer: Answer; usage?: { totalTokens: number } };
type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  answer?: Answer;
  runId?: string;
  createdAt: string;
};
type CoachSession = {
  id: string;
  title: string;
  matchId?: string;
  messages: ChatMessage[];
  createdAt: string;
  updatedAt: string;
};
type SyncJob = { jobId: string; status: string; imported: number; skipped: number; failedMatchIds: string[]; errorMessage?: string };

const STORAGE_KEY = "valorant-analytics.coach-sessions.v1";
const starters = [
  "总结这场比赛最值得复盘的问题",
  "这场比赛我为什么经常成为首死？",
  "结合这场比赛，下一局我应该只改什么？",
  "把这场比赛和我最近的状态联系起来"
];

function now() {
  return new Date().toISOString();
}

function id(prefix: string) {
  return prefix + "-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function formatMatchDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(date);
}

function sessionTitle(question: string) {
  return question.replace(/\s+/g, " ").trim().slice(0, 32) || "新的复盘会话";
}

function createSession(matchId?: string): CoachSession {
  const timestamp = now();
  return { id: id("session"), title: "新的复盘会话", matchId, messages: [], createdAt: timestamp, updatedAt: timestamp };
}

function answerMessage(result: AnalysisResult): ChatMessage {
  return {
    id: id("assistant"),
    role: "assistant",
    content: result.answer.conclusion,
    answer: result.answer,
    runId: result.runId,
    createdAt: now()
  };
}

function MatchChip({ match, onRemove }: { match: MatchSummary; onRemove?: () => void }) {
  return (
    <span className="match-chip">
      <span className="match-chip-dot" />
      <b>{match.mapName}</b>
      <small>{formatMatchDate(match.playedAt)}</small>
      <em className={match.result}>{match.result === "win" ? "胜" : "负"}</em>
      {onRemove ? <button aria-label="移除比赛上下文" onClick={onRemove}>×</button> : null}
    </span>
  );
}

function AnswerCard({ message, onFollowUp }: { message: ChatMessage; onFollowUp: (question: string) => void }) {
  const answer = message.answer;
  if (!answer) return <p className="assistant-text">{message.content}</p>;
  return (
    <div className="answer-card">
      <p className="answer-conclusion">{answer.conclusion}</p>
      {answer.playerEvidence.length ? (
        <section className="answer-section">
          <header><b>比赛证据</b><span>{answer.playerEvidence.length} 条</span></header>
          {answer.playerEvidence.slice(0, 4).map((item, index) => (
            <div className="answer-evidence" key={item.claim + index}>
              <i>{String(index + 1).padStart(2, "0")}</i>
              <p><b>{item.claim}</b><small>{item.metricName ?? (item.matchId ? item.matchId + (item.roundNumber ? " · 第 " + item.roundNumber + " 回合" : "") : "结构化指标")}</small></p>
            </div>
          ))}
        </section>
      ) : null}
      {answer.recommendations.length ? (
        <section className="answer-section recommendations">
          <header><b>下一步怎么练</b><span>{answer.confidence} confidence</span></header>
          {answer.recommendations.slice(0, 3).map((item, index) => (
            <div className="answer-recommendation" key={item.action + index}>
              <i>{index + 1}</i><p><b>{item.action}</b><small>{item.rationale}</small></p>
            </div>
          ))}
        </section>
      ) : null}
      {answer.limitations.length ? <p className="answer-limit">限制：{answer.limitations.join("；")}</p> : null}
      {answer.nextQuestions.length ? (
        <div className="answer-followups">
          {answer.nextQuestions.slice(0, 2).map((question) => <button key={question} onClick={() => onFollowUp(question)}>{question}<span>↗</span></button>)}
        </div>
      ) : null}
    </div>
  );
}

export function CoachClient() {
  const [loggedIn, setLoggedIn] = useState(false);
  const [accountMode, setAccountMode] = useState<"demo" | "riot" | null>(null);
  const [matches, setMatches] = useState<MatchSummary[]>([]);
  const [matchDetails, setMatchDetails] = useState<Record<string, MatchDetail>>({});
  const [sessions, setSessions] = useState<CoachSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState("");
  const [hydrated, setHydrated] = useState(false);
  const [rightPanel, setRightPanel] = useState<"matches" | "detail">("matches");
  const [question, setQuestion] = useState("");
  const [loading, setLoading] = useState(false);
  const [matchLoading, setMatchLoading] = useState(false);
  const [syncJob, setSyncJob] = useState<SyncJob | null>(null);
  const [error, setError] = useState<string | null>(null);

  const activeSession = useMemo(() => sessions.find((session) => session.id === activeSessionId) ?? null, [sessions, activeSessionId]);
  const activeMatch = activeSession?.matchId ? matches.find((match) => match.matchId === activeSession.matchId) : undefined;
  const activeDetail = activeSession?.matchId ? matchDetails[activeSession.matchId] : undefined;

  useEffect(() => {
    try {
      const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "[]") as CoachSession[];
      if (Array.isArray(stored) && stored.length) {
        setSessions(stored);
        setActiveSessionId(stored[0].id);
      }
    } catch {
      window.localStorage.removeItem(STORAGE_KEY);
    }
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (hydrated) window.localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions.slice(0, 20)));
  }, [hydrated, sessions]);

  useEffect(() => {
    void fetch("/api/auth/status", { cache: "no-store" }).then(async (response) => {
      const payload = await response.json();
      if (response.ok && payload.authenticated && payload.connected) {
        setLoggedIn(true);
        setAccountMode(payload.mode);
        await loadMatches();
      }
    }).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (loggedIn && !sessions.length) {
      const session = createSession();
      setSessions([session]);
      setActiveSessionId(session.id);
    }
  }, [loggedIn, sessions.length]);

  async function loadMatches() {
    const response = await fetch("/api/matches?limit=10", { cache: "no-store" });
    const payload = await response.json();
    if (!response.ok) return setError(payload.message ?? "无法读取比赛列表。");
    setMatches(payload.matches as MatchSummary[]);
  }

  async function loadMatchDetail(matchId: string) {
    if (matchDetails[matchId]) return matchDetails[matchId];
    setMatchLoading(true);
    const response = await fetch("/api/matches/" + encodeURIComponent(matchId), { cache: "no-store" });
    const payload = await response.json();
    setMatchLoading(false);
    if (!response.ok) {
      setError(payload.message ?? "无法读取这场比赛的详情。");
      return undefined;
    }
    const detail = payload.match as MatchDetail;
    setMatchDetails((current) => ({ ...current, [matchId]: detail }));
    return detail;
  }

  function updateSession(sessionId: string, updater: (session: CoachSession) => CoachSession) {
    setSessions((current) => current.map((session) => session.id === sessionId ? updater(session) : session));
  }

  function newSession(matchId?: string) {
    const session = createSession(matchId);
    setSessions((current) => [session, ...current]);
    setActiveSessionId(session.id);
    setQuestion("");
    setError(null);
    if (matchId) {
      setRightPanel("detail");
      void loadMatchDetail(matchId);
    }
  }

  function attachMatch(matchId: string) {
    if (!activeSession) newSession(matchId);
    else {
      updateSession(activeSession.id, (session) => ({ ...session, matchId, updatedAt: now() }));
      setRightPanel("detail");
      void loadMatchDetail(matchId);
    }
  }

  function detachMatch() {
    if (!activeSession) return;
    updateSession(activeSession.id, (session) => ({ ...session, matchId: undefined, updatedAt: now() }));
    setRightPanel("matches");
  }

  async function demoLogin() {
    setLoading(true);
    setError(null);
    const response = await fetch("/api/auth/demo", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    const payload = await response.json();
    setLoading(false);
    if (!response.ok) return setError(payload.message ?? "Demo 登录失败。");
    setLoggedIn(true);
    setAccountMode("demo");
    await loadMatches();
  }

  function connectRiot() {
    window.location.href = "/api/auth/riot/start";
  }

  async function syncMatches() {
    setLoading(true);
    setError(null);
    const response = await fetch("/api/sync", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    const payload = await response.json();
    if (!response.ok) {
      setLoading(false);
      return setError(payload.message ?? "同步未能启动。");
    }
    let current = payload as SyncJob;
    setSyncJob(current);
    for (let attempt = 0; attempt < 25 && (current.status === "queued" || current.status === "running"); attempt += 1) {
      await new Promise((resolve) => window.setTimeout(resolve, 800));
      const next = await fetch("/api/sync/" + current.jobId, { cache: "no-store" });
      if (!next.ok) break;
      current = await next.json() as SyncJob;
      setSyncJob(current);
    }
    setLoading(false);
    if (current.status === "failed") setError(current.errorMessage ?? "比赛同步失败。");
    else await loadMatches();
  }

  async function sendQuestion(nextQuestion = question) {
    const text = nextQuestion.trim();
    if (!activeSession || !loggedIn || loading || !text) return;
    const matchId = activeSession.matchId;
    const userMessage: ChatMessage = { id: id("user"), role: "user", content: text, createdAt: now() };
    const history = activeSession.messages.slice(-12).map((message) => ({ role: message.role, content: message.content }));
    updateSession(activeSession.id, (session) => ({
      ...session,
      title: session.messages.length ? session.title : sessionTitle(text),
      messages: [...session.messages, userMessage],
      updatedAt: now()
    }));
    setQuestion("");
    setLoading(true);
    setError(null);
    const response = await fetch("/api/agent/analyze", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: text, scope: matchId ? { type: "match", matchId } : { type: "recent" }, conversation: history })
    });
    const payload = await response.json();
    setLoading(false);
    if (!response.ok) return setError(payload.message ?? "分析失败，请重试。");
    const result = payload as AnalysisResult;
    updateSession(activeSession.id, (session) => ({ ...session, messages: [...session.messages, answerMessage(result)], updatedAt: now() }));
  }

  async function disconnectAccount() {
    setLoading(true);
    await fetch("/api/auth/riot/disconnect", { method: "POST" });
    setLoading(false);
    setLoggedIn(false);
    setAccountMode(null);
    setMatches([]);
    setMatchDetails({});
    setSessions([]);
    setActiveSessionId("");
    window.localStorage.removeItem(STORAGE_KEY);
  }

  if (!loggedIn) {
    return (
      <main className="client-login">
        <div className="client-login-brand"><span>V</span><b>VALORANT ANALYTICS</b></div>
        <div className="client-login-card">
          <small>POST-MATCH COACH</small>
          <h1>把每场比赛，变成下一次训练。</h1>
          <p>选择一场已完成的竞技比赛，让 Coach 在对话中引用这场比赛的结构化事实、回合证据和限制。</p>
          <div className="login-buttons">
            <button className="client-primary" disabled={loading} onClick={demoLogin}>{loading ? "正在连接…" : "进入 Demo"}<b>→</b></button>
            <button className="client-secondary" onClick={connectRiot}>使用 Riot 账号登录</button>
          </div>
        </div>
        <p className="client-login-note">仅支持当前授权玩家自己的国际服竞技比赛 · Demo 使用脱敏 fixture</p>
      </main>
    );
  }

  return (
    <main className="coach-client">
      <aside className="session-rail">
        <div className="client-brand"><span>V</span><b>VALORANT<br /><em>ANALYTICS</em></b></div>
        <button className="new-session" onClick={() => newSession()}><span>＋</span> 新建复盘会话</button>
        <div className="rail-label">COACH</div>
        <div className="session-list">
          {sessions.map((session) => {
            const match = session.matchId ? matches.find((item) => item.matchId === session.matchId) : undefined;
            return (
              <button key={session.id} className={"session-item " + (session.id === activeSessionId ? "active" : "")} onClick={() => { setActiveSessionId(session.id); setRightPanel(session.matchId ? "detail" : "matches"); }}>
                <span>{session.title}</span>
                <small>{match ? match.mapName + " · " + match.result : session.messages.length ? session.messages.length + " 条消息" : "未开始"}</small>
              </button>
            );
          })}
        </div>
        <div className="rail-bottom">
          <button className={rightPanel === "matches" ? "rail-nav active" : "rail-nav"} onClick={() => setRightPanel("matches")}>▣ <span>比赛记录</span></button>
          <button className="rail-nav" onClick={() => setError("Settings 仍在建设中，当前会话已保存在本机。")}>⚙ <span>设置</span></button>
          <button className="rail-account" onClick={disconnectAccount} disabled={loading}><i />{accountMode === "demo" ? "Demo 账号" : "Riot 授权账号"}<small>断开并删除关联数据</small></button>
        </div>
      </aside>

      <section className="coach-main">
        <header className="coach-header">
          <div><small>COACH</small><h1>{activeSession?.title ?? "新的复盘会话"}</h1></div>
          <span className="local-badge">● 本机保存</span>
        </header>
        {activeMatch ? (
          <div className="attached-context"><span>当前上下文</span><MatchChip match={activeMatch} onRemove={detachMatch} /><button onClick={() => setRightPanel("detail")}>查看比赛记录 →</button></div>
        ) : null}
        <div className="conversation">
          {activeSession?.messages.length ? activeSession.messages.map((message) => (
            <article className={"chat-message " + message.role} key={message.id}>
              <div className="message-label">{message.role === "user" ? "你" : "COACH"}</div>
              <div className="message-body">
                {message.role === "assistant" ? <AnswerCard message={message} onFollowUp={(followUp) => void sendQuestion(followUp)} /> : <p className="user-text">{message.content}</p>}
                {message.runId ? <small className="message-run">RUN {message.runId.slice(0, 8)}</small> : null}
              </div>
            </article>
          )) : (
            <div className="empty-conversation">
              <div className="empty-mark">✦</div>
              <h2>{activeMatch ? "这场比赛，你想先看哪里？" : "从一个具体问题开始。"}</h2>
              <p>{activeMatch ? "这场比赛已经挂载到会话。Coach 只会使用它的比赛事实，不会混入其他场次。" : "先从比赛记录中挂载一场比赛，或者直接问最近几场的趋势。"}</p>
              <div className="starter-grid">{starters.map((starter) => <button key={starter} onClick={() => void sendQuestion(starter)}>{starter}<span>↗</span></button>)}</div>
            </div>
          )}
          {loading ? <div className="typing"><i /><i /><i /><span>Coach 正在读取证据…</span></div> : null}
        </div>
        <div className="composer-wrap">
          {activeMatch ? <MatchChip match={activeMatch} onRemove={detachMatch} /> : <button className="attach-hint" onClick={() => setRightPanel("matches")}>＋ 挂载一场比赛到本次对话</button>}
          <div className="client-composer">
            <textarea value={question} onChange={(event) => setQuestion(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void sendQuestion(); } }} placeholder={activeMatch ? "围绕这场比赛继续追问…" : "问问最近的状态，或先挂载一场比赛…"} rows={2} />
            <button className="client-primary send-button" disabled={loading || !question.trim()} onClick={() => void sendQuestion()}>发送 <b>↗</b></button>
          </div>
          <small className="composer-help">Enter 发送 · Shift + Enter 换行 · Coach 只使用当前账号可见的竞技数据</small>
        </div>
        {error ? <div className="client-error"><b>请求未完成</b><span>{error}</span><button onClick={() => setError(null)}>关闭</button></div> : null}
      </section>

      <aside className="context-rail">
        <header className="context-header"><div><small>{rightPanel === "detail" && activeDetail ? "MATCH CONTEXT" : "MATCH HISTORY"}</small><h2>{rightPanel === "detail" && activeDetail ? activeDetail.mapName : "比赛记录"}</h2></div><button onClick={() => setRightPanel(rightPanel === "matches" ? "detail" : "matches")} disabled={rightPanel === "detail" && !activeMatch}>×</button></header>
        {syncJob ? <p className="sync-label">同步 {syncJob.status} · 导入 {syncJob.imported} 场</p> : null}
        {rightPanel === "detail" && activeMatch ? (
          <div className="match-detail">
            <MatchChip match={activeMatch} />
            {matchLoading ? <p className="muted-copy">读取比赛详情…</p> : activeDetail ? (
              <>
                <div className="match-score"><strong>{activeDetail.roundsWon}:{activeDetail.roundsLost}</strong><span>{activeDetail.result === "win" ? "胜利" : "失利"}</span></div>
                <div className="match-metrics"><span><b>{activeDetail.kills}/{activeDetail.deaths}/{activeDetail.assists}</b><small>K / D / A</small></span><span><b>{activeDetail.metrics?.kd ?? "—"}</b><small>K/D</small></span><span><b>{activeDetail.metrics?.acs ?? "—"}</b><small>ACS</small></span><span><b>{activeDetail.metrics?.firstDeathRate ?? "—"}</b><small>首死率</small></span></div>
                <button className="context-action" onClick={detachMatch}>从会话移除</button>
                <p className="context-note">这张卡片是 Coach 的事实范围。它不会把未挂载的其他比赛混入当前回答。</p>
              </>
            ) : null}
          </div>
        ) : (
          <div className="match-library">
            <div className="library-actions"><span>{matches.length} 场竞技比赛</span><button onClick={syncMatches} disabled={loading}>{loading ? "同步中…" : "同步"}</button></div>
            {matches.map((match) => <button className={"library-match " + (activeSession?.matchId === match.matchId ? "selected" : "")} key={match.matchId} onClick={() => attachMatch(match.matchId)}><span><b>{match.mapName}</b><small>{formatMatchDate(match.playedAt)}</small></span><em className={match.result}>{match.result === "win" ? "胜利" : "失利"}</em><strong>＋</strong></button>)}
            {!matches.length ? <p className="muted-copy">还没有已同步的竞技比赛。</p> : null}
          </div>
        )}
      </aside>
    </main>
  );
}

