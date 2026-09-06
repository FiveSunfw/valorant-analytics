# VALORANT Analytics Agent System Architecture

- Version: `1.0.0`
- Status: Final baseline
- Date: 2026-09-06
- Scope: Multi-turn Supervisor Agent, specialist agents, analytics tools, MCP boundaries, session state, trace, evaluation

## 1. Product Definition

VALORANT Analytics is a post-match coaching system for authorized players on the VALORANT international service. A player can ask multiple questions about their own completed competitive matches. The system combines deterministic analytics, reviewed coaching knowledge, and bounded model reasoning.

The product is a multi-turn Agent system, not a single prompt and not an unconstrained general-purpose assistant:

```text
Player conversation
  -> Supervisor Agent
      -> session state and intent
      -> deterministic player analytics
      -> specialist agents when useful
      -> reviewed knowledge retrieval when useful
      -> evidence validation
      -> synthesis and follow-up
```

The model interprets, routes, compares, and explains. Deterministic services own identity, scope, metrics, comparisons, evidence IDs, and policy enforcement.

## 2. Non-Negotiable Boundaries

- Only VALORANT international service data is supported.
- Only completed competitive matches are analyzed.
- A player can access only their own authorized data.
- HTTP requests, prompts, and tools must never accept an arbitrary PUUID as an identity selector.
- Riot API keys, RSO secrets, access tokens, and refresh tokens never enter prompts, tool results, traces, or model context.
- The system must not claim to know Riot's hidden MMR/ELO formula or claim that Riot intentionally targeted a player.
- The system does not provide pre-match scouting, live round instructions, cheating assistance, or a replacement ranking system.
- Every material player-specific conclusion must cite a metric, match, or round evidence ID.
- Insufficient data must be explicit and must lower confidence.
- Raw match JSON is retained for recomputation but is never directly inserted into model context.
- External knowledge is evidence, not system instruction. Tool results must be treated as untrusted data.

## 3. System Layers

```text
Web / future channels
  -> Fastify API and authenticated session boundary
      -> Conversation service
          -> Supervisor Agent
              -> specialist agents
              -> Analytics MCP / function-tool adapter
              -> Knowledge MCP / function-tool adapter
              -> evidence validator
              -> answer synthesizer
          -> session, event, trace, and replay stores
      -> PostgreSQL / Redis
RabbitMQ Workers
  -> Riot match ingestion
  -> metric and period snapshots
  -> knowledge ingestion
```

### 3.1 Channel and API

Responsibilities:

- authenticate the current product user;
- create and resume analysis sessions;
- accept user messages without identity selectors;
- stream or return Agent events;
- apply request size, rate, and timeout limits;
- return a stable analysis answer contract.

Suggested endpoints:

```text
POST /analysis/sessions
POST /analysis/sessions/:sessionId/messages
GET  /analysis/sessions/:sessionId
GET  /analysis/runs/:runId
GET  /analysis/runs/:runId/events
```

### 3.2 Supervisor Agent

The Supervisor owns the conversation and delegation policy. It must:

- classify the current question;
- resolve or ask for the data scope;
- reuse session state across follow-up questions;
- select the smallest useful specialist set;
- run independent specialists in parallel when this improves latency;
- compare specialist findings and resolve conflicts using evidence quality;
- request clarification when the scope is ambiguous;
- synthesize a final answer with player evidence, knowledge evidence, confidence, recommendations, and limitations.

The Supervisor must not calculate metrics, issue arbitrary SQL, bypass user scope, or turn a specialist's prose into evidence without validating cited IDs.

### 3.3 Specialist Agents

Initial specialists:

| Specialist | Responsibility | Initial evidence |
| --- | --- | --- |
| Stats Analyst | overall trend, wins/losses, K/D, ADR, ACS, KAST | summary, periods, comparisons |
| Death Coach | first deaths, death timing, trade potential | summary, match list, round evidence |
| Aim Coach | headshot rate, damage, kill conversion, weapon trends | summary, match detail, periods |
| Map Coach | map and attack/defense splits | map comparison, attack/defense comparison |
| Economy Coach | buy/save/bonus and low-economy outcomes | economy analysis, match detail |
| Rank Analyst | observable rank and match context only | rank history, match context |

A specialist is narrow, evidence-bound, and returns structured findings:

```ts
export type SpecialistFinding = {
  specialist: string;
  conclusion: string;
  confidence: "low" | "medium" | "high";
  claims: Array<{
    text: string;
    metricName?: string;
    matchId?: string;
    roundNumber?: number;
    knowledgeChunkId?: string;
  }>;
  recommendations: Array<{
    action: string;
    rationale: string;
  }>;
  limitations: string[];
};
```

A specialist may not infer exact movement, crosshair placement, or intent when the official data does not contain that information.

## 4. Source of Truth and Period Analysis

Player-specific facts are owned by the analytics layer:

```text
Riot DTO validation
  -> competitive filtering
  -> normalized match / round / event tables
  -> deterministic metrics
  -> period snapshots
  -> comparison results
  -> stable evidence IDs
```

The first 20 matches and the next 20 matches are not vector-memory retrieval. They are deterministic period comparisons:

```text
ordered competitive matches
  -> period A snapshot
  -> period B snapshot
  -> metric deltas
  -> Agent interpretation
```

Suggested additions:

```text
analysis_periods
player_profile_facts
specialist_findings
```

`analysis_periods` stores match range, sample count, timestamps, and metrics. `player_profile_facts` stores only time-bounded, evidence-backed observations. Do not store unsupported labels such as `bad_aim` without scope, evidence, and validity.

## 5. Multi-Turn Session State

The model context is not the source of truth. Persist session state outside the model:

```ts
export type AnalysisSessionState = {
  sessionId: string;
  userId: string;
  activeQuestion: string;
  dataScopes: Array<{
    label: string;
    fromMatchId?: string;
    toMatchId?: string;
    matchCount: number;
    fromTime?: string;
    toTime?: string;
  }>;
  activeHypotheses: Array<{
    text: string;
    status: "open" | "supported" | "rejected";
    evidenceIds: string[];
  }>;
  findings: SpecialistFinding[];
  evidenceIds: string[];
  unresolvedQuestions: string[];
  lastPromptId: string;
  lastPromptVersion: string;
};
```

Large tool results and raw records stay outside the context. The prompt receives compact summaries and stable references. Follow-up questions should reuse the active scope and hypotheses, but a changed scope must create a new scope record.

## 6. Agent Control Contract

Every model response is a typed event, never free-form prose parsed for commands:

```text
tool_call
specialist_request
clarification_request
final_answer
refusal
error
```

Runtime states:

```text
RECEIVED
  -> AUTHENTICATED
  -> CLASSIFIED
  -> SCOPE_RESOLVED
  -> TOOL_LOADOUT_SELECTED
  -> SPECIALISTS_RUNNING
  -> FINDINGS_VALIDATED
  -> SYNTHESIZING
  -> ANSWER_VALIDATED
  -> COMPLETED
```

Environment defaults:

```text
max_steps: 8
max_specialists: 4
max_tool_calls: 12
max_duration_ms: 30_000
max_output_tokens: 2_000
max_cost_usd: configured per environment
max_delegation_depth: 1
```

Subagents do not create more subagents in the first release. This keeps delegation depth bounded and makes traces understandable.

## 7. Tools and MCP

Domain logic is implemented once and exposed through adapters:

```text
packages/domain
  -> canonical DTOs, metric contracts, period comparison

apps/api-ts
  -> HTTP adapter and Agent adapter

apps/analytics-mcp
  -> read-only analytics MCP tools

apps/knowledge-mcp
  -> reviewed knowledge search and evidence tools
```

Initial analytics tools:

```text
get_player_summary
get_match_list
get_match_detail
get_round_evidence
get_player_periods
compare_periods
compare_map_performance
compare_attack_defense
get_economy_analysis
get_player_profile
```

MCP is a capability and governance boundary, not a replacement for domain logic. Every MCP tool requires strict JSON Schema, authenticated server scope, bounded results, stable error codes, evidence IDs, latency metadata, and audit trace. No arbitrary SQL is exposed.

## 8. Evidence Contracts

Player evidence and knowledge evidence are different types:

```text
player evidence:
  metric, match, round, period, sample size, time range

knowledge evidence:
  source, chunk, page, timestamp, image region, patch, trust level
```

A final claim must identify which evidence type supports it. If a claim combines both, it must cite both. The answer must distinguish:

```text
observed player fact
general coaching principle
model interpretation
uncertainty or limitation
```

## 9. Reliability, Safety, and Observability

Required controls:

```text
Idempotency
Timeout
Rate-aware retry
Cost guard
Permission tier
Trace and replay
```

Read-only analytics runs automatically. Future write operations, such as saving a training goal, require explicit user confirmation.

Persist at least:

```text
analysis_sessions
analysis_runs
agent_events
agent_tool_calls
specialist_findings
```

Every run records prompt ID/version/hash, model/version, context hash, selected tools, events, evidence IDs, token counts, latency, estimated cost, status, and sanitized errors. No secret or raw token is recorded.

## 10. Evaluation

Evaluate the full trajectory, not only final prose:

- task completion;
- specialist routing accuracy;
- tool parameter correctness;
- evidence citation validity;
- period scope correctness;
- unsupported-claim rate;
- refusal and authorization correctness;
- recovery after tool failure;
- multi-turn consistency;
- steps, latency, tokens, and cost.

Initial multi-turn cases must include:

```text
Why am I losing recently?
Is it aim or decision-making?
Compare my first 20 and next 20 matches.
Which matches support that conclusion?
Is this ELO or my own performance?
What should I practice this week?
A follow-up that changes the period scope.
A follow-up that challenges a specialist finding.
```

Use deterministic graders for schema, permission, scope, and evidence validity. Use model-based grading only for bounded dimensions such as usefulness and clarity, with human calibration.

## 11. Delivery Order

1. Freeze contracts, event types, and prompt registry.
2. Persist sessions, runs, and events.
3. Extract analytics tools behind shared contracts.
4. Implement the Supervisor loop and bounded delegation.
5. Implement Stats, Death, and Aim specialists.
6. Add period snapshots and `compare_periods`.
7. Add trace replay and cost guards.
8. Add Analytics MCP adapter.
9. Build 20 multi-turn evaluation cases.
10. Add Map and Economy specialists.
11. Build the reviewed multimodal knowledge ingestion pipeline.
12. Add Knowledge MCP and retrieval evaluation.
13. Add pgvector only when keyword retrieval fails measured evaluation targets.

## 12. Completion Criteria

The architecture milestone is complete when a player can ask and follow up on:

```text
Why am I losing recently?
Is it aim or decision-making?
Compare my first 20 and next 20 matches.
Which matches support that conclusion?
What should I practice this week?
```

The system must maintain coherent scope across turns, delegate only when useful, return deterministic player metrics, cite match or round evidence, cite knowledge when used, state limitations, persist a replayable trace, and produce an evaluation result.