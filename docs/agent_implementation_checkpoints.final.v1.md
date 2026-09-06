# Agent Implementation Checkpoints

- Version: `1.0.0`
- Scope: TypeScript Agent implementation only
- Date: 2026-09-06

## Measurement Rules

Progress is measured by completed, tested behavior, not by file count. A checkpoint is complete only when its acceptance tests pass and the relevant trace or contract is documented.

## Checkpoints

| ID | Milestone | Weight | Completion evidence |
| --- | --- | ---: | --- |
| C0 | TypeScript contracts and prompt registry exist | 10% | Zod contracts, registry shape, contract tests |
| C1 | Persisted multi-turn session state | 15% | Create/resume session tests and scope-change tests |
| C2 | Supervisor routing and bounded Agent loop | 20% | Routing, max-step, timeout, refusal tests |
| C3 | Stats, Death, and Aim specialist findings | 15% | Three specialist contract tests with fixture evidence |
| C4 | First end-to-end player analysis | 15% | “Why am I losing recently?” returns validated evidence-backed answer |
| C5 | Trace, replay, cost, and error recovery | 10% | Replay fixture, sanitized trace, budget and retry tests |
| C6 | Twenty-case multi-turn Eval suite | 10% | Eval report with failure categories and latency/cost fields |
| C7 | Analytics MCP adapter | 5% | MCP schema, auth scope, bounded result, and adapter tests |

## Completion Formula

```text
progress = sum(weight of completed checkpoints)
```

A checkpoint cannot be marked complete when tests are skipped, real secrets are required, or the implementation only returns mocked success without validating contracts.

## Current Status

```text
C0  TypeScript contracts and prompt registry     CONTRACTS COMPLETE; REGISTRY PENDING
C1  Persisted multi-turn session state           NOT STARTED
C2  Supervisor routing and bounded loop          NOT STARTED
C3  Stats / Death / Aim specialists              NOT STARTED
C4  First end-to-end analysis                    NOT STARTED
C5  Trace / replay / cost / recovery              NOT STARTED
C6  Multi-turn Eval suite                        NOT STARTED
C7  Analytics MCP adapter                        NOT STARTED

Measured progress: 5% (contracts complete; Prompt Registry remains in C0)
```

## Verified Work

The TypeScript contract slice is complete:

- `apps/api-ts/src/agent-contracts.ts` owns shared Zod contracts.
- Existing analytics tools reuse the shared final-answer schema.
- Contract tests cover session state, evidence-bound claims, tool results, events, and final answers.
- API typecheck passes.
- API tests pass: 15 passed, 1 existing integration test skipped by configuration.

The remaining C0 work is the versioned Prompt Registry and prompt asset metadata. C0 reaches 10% only after that registry has contract tests.

## Scope Exclusions for This Phase

This checklist tracks only the TypeScript Agent core. It does not include Python services, knowledge ingestion, video/OCR processing, pgvector, or real Riot API credentials.

## Definition of Done for C0

- `apps/api-ts/src/agent/contracts.ts` owns shared Zod schemas.
- Existing analytics tools import the shared final-answer schema.
- Contracts cover authenticated user, session scope, specialist finding, tool result, Agent event, and final answer.
- Invalid evidence, invalid scope, unsupported event types, and invalid confidence values fail validation.
- `npm run typecheck --workspace=@valorant/api` passes.
- `npm run test --workspace=@valorant/api` passes.
