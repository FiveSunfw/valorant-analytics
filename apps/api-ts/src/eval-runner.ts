import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

type Profile = "full" | "small" | "empty";
type EvalCase = { id: string; profile: Profile; question: string; expectedTools: string[]; expectRefusal: boolean; expectLowConfidence?: boolean; scope?: { type: "recent" } | { type: "match"; matchId: string } };
type ApiResult = { runId?: string; toolCalls?: number; toolNames?: string[]; answer?: { confidence?: string; playerEvidence?: unknown[]; limitations?: unknown[] }; usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number; estimatedCostUsd?: number | null }; error?: string; message?: string };
const apiUrl = process.env.EVAL_API_URL ?? "http://127.0.0.1:8000";
const root = resolve(import.meta.dirname, "../../..");
const cases = (await readFile(resolve(root, "eval/cases.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as EvalCase);
async function call(path: string, init: RequestInit): Promise<Response> { return fetch(`${apiUrl}${path}`, init); }
async function login(profile: Profile): Promise<string> { const response = await call("/auth/eval", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ profile }) }); if (!response.ok) throw new Error(`Eval login failed: ${response.status} ${await response.text()}`); const cookie = response.headers.get("set-cookie"); if (!cookie) throw new Error("Eval login did not return a session cookie"); return cookie; }
function answerValid(answer: ApiResult["answer"]): boolean { return Boolean(answer && typeof answer.confidence === "string" && Array.isArray(answer.playerEvidence) && Array.isArray(answer.limitations)); }
const cookies = new Map<Profile, string>(); const results: Array<Record<string, any>> = [];
for (const item of cases) {
  const startedAt = Date.now(); let firstAttemptSucceeded = false; let providerRetry = false;
  try {
    const cookie = cookies.get(item.profile) ?? await login(item.profile); cookies.set(item.profile, cookie);
    let response = await call("/agent/analyze", { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ question: item.question, scope: item.scope }) });
    let payload = await response.json() as ApiResult; firstAttemptSucceeded = response.ok;
    if (response.status === 503 && payload.error === "model_failed") { providerRetry = true; response = await call("/agent/analyze", { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ question: item.question, scope: item.scope }) }); payload = await response.json() as ApiResult; }
    const providerUnavailable = response.status === 503 && payload.error === "model_failed";
    const actualTools = payload.toolNames ?? []; const refused = response.ok && actualTools.length === 0; const invalidInput = response.status === 400 && payload.error === "invalid_input";
    const toolMatch = item.expectedTools.every((tool) => actualTools.includes(tool)); const schemaValid = response.ok ? answerValid(payload.answer) : invalidInput;
    const confidenceValid = !item.expectLowConfidence || payload.answer?.confidence === "low";
    results.push({ ...item, expectedTools: item.expectedTools, actualTools, status: response.status, runId: payload.runId ?? null, toolCalls: payload.toolCalls ?? null, outputSchemaValid: schemaValid, evidenceValid: response.ok ? Array.isArray(payload.answer?.playerEvidence) : null, refused, firstAttemptSucceeded, providerRetry, providerUnavailable, latencyMs: Date.now() - startedAt, usage: payload.usage ?? null, failureCategory: providerUnavailable ? "provider_availability" : !schemaValid ? "output_schema" : item.expectRefusal && !refused ? "refusal" : !item.expectRefusal && !toolMatch ? "tool_selection" : !confidenceValid ? "sample_limit" : null, error: payload.error ?? null, passed: !providerUnavailable && (invalidInput || (item.expectRefusal ? refused : response.ok && toolMatch && schemaValid && confidenceValid)) });
  } catch (error) { results.push({ ...item, status: null, firstAttemptSucceeded, providerRetry, providerUnavailable: true, latencyMs: Date.now() - startedAt, failureCategory: "provider_availability", error: error instanceof Error ? error.message : "connection error", passed: false }); }
}
await mkdir(resolve(root, "eval/results"), { recursive: true }); const output = resolve(root, `eval/results/${new Date().toISOString().replaceAll(":", "-")}.jsonl`); await writeFile(output, `${results.map((result) => JSON.stringify(result)).join("\n")}\n`);
const totalTokens = results.reduce((total, result) => total + (result.usage?.totalTokens ?? 0), 0);
console.info(JSON.stringify({ cases: results.length, passed: results.filter((result) => result.passed).length, providerUnavailable: results.filter((result) => result.providerUnavailable).length, firstAttemptSuccessRate: results.filter((result) => result.firstAttemptSucceeded).length / results.length, retries: results.filter((result) => result.providerRetry).length, totalTokens, output }));
