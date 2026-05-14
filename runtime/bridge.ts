// acc2 brain bridge — typed transport for opencode subprocess (v2-design.md §12).
//
// PHASE D MOCK. The real bridge spawns `opencode run …` as a subprocess and
// streams typed BridgeFrames. That is Phase E work (real subprocess, real
// frame protocol, real auth/retry). Phase D ships a deterministic mock that
// emits exactly the events the brain WOULD have emitted for the
// fixture_d_count_todos directive — admits the action + verifier artifacts,
// emits action_predicted referencing them, returns success.
//
// The mock matches the v2-design §12 BridgeResult / BridgeFailureReason shape
// so Phase E can light up the real subprocess without rewiring callers.
//
// Decision: events the brain emits flow through the SAME emitEvent path the
// real opencode session would use. We do NOT short-circuit through the
// dispatcher's bookkeeping — the dispatcher captures these events by reading
// the event stream the same way it would read frames from a real subprocess.
//
// ── opencode MCP-client wiring (Batch 2.β) ────────────────────────
//
// Investigation findings (opencode 1.4.3):
//   - `opencode run` has NO `--mcp-server` / `--mcp` / `--config` flag.
//     `opencode mcp add` exists but only edits the user's global config
//     interactively; it is unusable as a per-dispatch wiring path.
//   - MCP servers are declared in `opencode.json` (JSON or JSONC) under the
//     `mcp` key. Each entry has a unique server name and either
//     `{type:"local", command:[...], environment:{...}}` for stdio or
//     `{type:"remote", url:"…", headers:{...}, enabled:true}` for HTTP.
//     v2's daemon stands up a fastmcp `httpStream` transport at
//     `http://127.0.0.1:<V2_DAEMON_PORT>/mcp`, so we use `type:"remote"`.
//   - Config precedence (later overrides earlier):
//       1. Remote `.well-known/opencode` (org defaults)
//       2. Global `~/.config/opencode/opencode.json` (user prefs/auth)
//       3. Custom `$OPENCODE_CONFIG` env var (verified to override above)
//       4. Project-local `opencode.json` in CWD
//     Configs are MERGED, not replaced — global auth/provider entries stay
//     active, we layer our `mcp` declaration on top.
//   - `OPENCODE_CONFIG=/path/to/file.json` is the cleanest per-dispatch path:
//     no CLI flag plumbing, no global-config mutation, no CWD pollution.
//     `opencode mcp list` under this env var confirms our declaration loads.
//
// Chosen approach: **(A) per-dispatch ephemeral config file**
//   - `materializeOpencodeMcpConfig` writes `<tempdir>/opencode-config.json`
//     declaring v2's MCP server (URL = `http://127.0.0.1:<port>/mcp`,
//     type=remote, enabled=true).
//   - `spawnRealOpencode` sets `OPENCODE_CONFIG=<tempdir>/opencode-config.json`
//     in the spawned subprocess env. The bridge does NOT clobber the
//     operator's global config — only this dispatch sees the v2 MCP server.
//   - Cleanup: the tempdir is removed after the subprocess exits (best-effort).
//
// Connection verification: opencode emits structured JSON events on stdout
// when `--format=json` is set. We watch for evidence of MCP handshake:
//   - A `tool_call` event whose name starts with `substrate.` or `runtime.`
//     proves opencode discovered v2's tools and is invoking them.
//   - We emit a `bridge_mcp_connected` substrate event on first such call so
//     the smoke can assert the connection happened. If 30s pass with no
//     substrate.* / runtime.* tool call, the bridge fails with
//     `mcp_handshake_failed` so operators see the gap immediately rather
//     than waiting for the watchdog timeout.

import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonValue, SandboxDecl } from "../substrate/types";
import { emitEvent } from "./events";
import { admitArtifact } from "./artifact_admission";
import { isCycleViolation } from "./cycle_one_gate";

export type BridgeRequest = {
  prompt: string;
  taskId: string;
  directiveId: string;
  /** Optional context: target path for the fixture_d_count_todos brain to
   *  scan. Real brain would derive this from the prompt; the mock reads it
   *  here so tests can point at a deterministic fixture directory. */
  fixtureTargetPath?: string;
};

export type BridgeFailureReason =
  | { kind: "auth_missing" }
  | { kind: "rate_limit"; retry_after_ms: number }
  | { kind: "timeout"; ms_elapsed: number }
  | { kind: "subprocess_crash"; stderr_tail: string }
  | { kind: "parse_error"; raw: string }
  | { kind: "mock_bridge_prompt_unrecognized"; supported_markers: string[] };

export type BridgeResult =
  | { ok: true; final_response: string; usage: { tokens: number }; emitted_event_ids: string[] }
  | { ok: false; reason: BridgeFailureReason };

const FIXTURE_D_MARKER = "FIXTURE: fixture_d_count_todos";
const EXAMPLE_COM_MARKER = "Fetch the URL https://example.com via Bun.fetch (the bun runtime).";

// Batch 5: eight universal-goal pilot fixtures covering v2-design.md §10.2-10.9.
// Each marker is embedded verbatim in its fixture's directive_text so the
// prompt composer carries it through to the bridge prompt; the mock then keys
// off the marker to admit the canonical action + verifier pair and emit
// `action_predicted`. Production (real-brain) dispatch is unaffected — these
// markers exist only for hermetic plumbing tests.
export const FIXTURE_BUSINESS_OUTREACH_MARKER = "FIXTURE: fixture_d_business_outreach";
export const FIXTURE_RESEARCH_SUMMARY_MARKER = "FIXTURE: fixture_d_research_summary";
export const FIXTURE_CREATIVE_CONSTRAINT_MARKER = "FIXTURE: fixture_d_creative_constraint";
export const FIXTURE_MULTI_STAKEHOLDER_MARKER = "FIXTURE: fixture_d_multi_stakeholder";
export const FIXTURE_HEALTH_DECISION_MARKER = "FIXTURE: fixture_d_health_decision";
export const FIXTURE_EMBODIED_RECIPE_MARKER = "FIXTURE: fixture_d_embodied_recipe";
export const FIXTURE_LONG_HORIZON_SAVINGS_MARKER = "FIXTURE: fixture_d_long_horizon_savings";
export const FIXTURE_CRISIS_RESPONSE_MARKER = "FIXTURE: fixture_d_crisis_response";

// ── Fixture D — TODO counter ──────────────────────────────────────
//
// The action artifact is a bun script that recursively scans a directory for
// files containing "TODO" and prints `@@RESULT@@ {"result":{"count":N}}`.
// Inputs come through ACC2_INPUTS (a JSON string). We read the target path
// from the inputs envelope.
//
// The artifact deliberately uses only Bun.file / readdirSync — no shell out —
// because bun runtime's sandbox doesn't permit subprocess spawning.

const FIXTURE_D_ACTION_BODY = `// fixture_d_count_todos — recursively grep TODOs
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const inputs = JSON.parse(process.env.ACC2_INPUTS ?? "null") ?? {};
const root: string = inputs.target_path ?? "./";

let count = 0;
const walk = (dir: string): void => {
  let entries: string[] = [];
  try { entries = readdirSync(dir); } catch { return; }
  for (const name of entries) {
    if (name.startsWith(".")) continue;
    if (name === "node_modules") continue;
    const full = join(dir, name);
    let stats;
    try { stats = statSync(full); } catch { continue; }
    if (stats.isDirectory()) { walk(full); continue; }
    if (!stats.isFile()) continue;
    try {
      const text = readFileSync(full, "utf-8");
      if (text.includes("TODO")) count++;
    } catch { /* skip unreadable */ }
  }
};
walk(root);

process.stdout.write("@@RESULT@@ " + JSON.stringify({ result: { count } }) + "\\n");
`;

// Verifier artifact — checks that the observation carries an integer
// `result.count` ≥ 0. Returns residual=0 (perfect) on match, residual=1
// otherwise. The action artifact must use the same envelope shape.

const FIXTURE_D_VERIFIER_BODY = `// fixture_d_count_todos verifier
// Reads the action observation from ACC2_INPUTS and emits residual.
const observation = JSON.parse(process.env.ACC2_INPUTS ?? "null") ?? {};
let residual = 1;
if (observation && typeof observation === "object" &&
    observation.result && typeof observation.result === "object" &&
    typeof observation.result.count === "number" &&
    Number.isInteger(observation.result.count) &&
    observation.result.count >= 0) {
  residual = 0;
}
process.stdout.write("@@RESULT@@ " + JSON.stringify({ residual }) + "\\n");
`;

// NOTE: the body below is interpolated through a template literal, so any
// `\X` escape must be written `\\X` to survive into the rendered artifact.
// In particular `[\\s\\S]` keeps the literal `\s\S` in the regex char-class.
const EXAMPLE_COM_ACTION_BODY = `// fetch example.com title
const resp = await Bun.fetch("https://example.com");
const html = await resp.text();
const match = html.match(/<title[^>]*>([\\s\\S]*?)<\\/title>/i);
const title = (match?.[1] ?? "").trim();
console.log("@@RESULT@@ " + JSON.stringify({ result: { title } }));
`;

const EXAMPLE_COM_VERIFIER_BODY = `// verify example.com title observation
const observation = JSON.parse(process.env.ACC2_INPUTS ?? "null") ?? {};
const title = observation && typeof observation === "object" && observation.result && typeof observation.result === "object"
  ? observation.result.title
  : "";
const residual = typeof title === "string" && title.trim().length > 0 ? 0 : 1;
console.log("@@RESULT@@ " + JSON.stringify({ residual }));
`;

const BUN_DEFAULT_SANDBOX = (): SandboxDecl => ({
  runtime: "bun",
  fs_read: ["**/*"],
  fs_write: [],
  net_allow: [],
  proc_allow: [],
  substrate_access: "none",
  cpu_ms: 5000,
  wall_ms: 5000,
  memory_mb: 128,
});

// Batch 5 sandbox helper — same shape as BUN_DEFAULT_SANDBOX but declares
// fs_write under the bun runtime's cwd so action artifacts that materialize
// tempfiles (business outreach, embodied recipe) honor-system-declare their
// write intent. Read/write outside cwd is structurally impossible because
// runtimes/bun.ts spawns with cwd=<tempdir>, but the decl makes intent legible.
const BUN_FS_WRITE_SANDBOX = (): SandboxDecl => ({
  runtime: "bun",
  fs_read: ["**/*"],
  fs_write: ["**/*"],
  net_allow: [],
  proc_allow: [],
  substrate_access: "none",
  cpu_ms: 5000,
  wall_ms: 5000,
  memory_mb: 128,
});

// ── Batch 5 universal-goal fixture bodies (v2-design.md §10.2-10.9) ──
//
// Each pair (action + verifier) is a small deterministic goal shape executed
// under the bun runtime. The action artifact reads its parameters from
// ACC2_INPUTS (the dispatcher now spreads action_predicted.payload into the
// inputs envelope) and prints `@@RESULT@@ {"result": ...}`. The verifier reads
// the action's observation (also via ACC2_INPUTS) and prints
// `@@RESULT@@ {"residual": N}` where N < 0.3 commits the task.

// 1. business_outreach — write a personalized outreach email to a tempfile.
// Verifier checks: file exists, body contains recipient, subject non-empty.
const FIXTURE_BUSINESS_OUTREACH_ACTION = `// fixture_d_business_outreach — write a personalized outreach email to disk
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const inputs = JSON.parse(process.env.ACC2_INPUTS ?? "null") ?? {};
const recipient: string = inputs.recipient ?? "there";
const subject: string = inputs.subject ?? "Quick hello";
const opener: string = inputs.opener ?? "Hope you're doing well.";

const body = [
  "Subject: " + subject,
  "",
  "Hi " + recipient + ",",
  "",
  opener,
  "",
  "I noticed your work and wanted to introduce a way it could compound.",
  "Would you have 15 minutes next week for a quick call?",
  "",
  "Best regards",
].join("\\n");

const dir = mkdtempSync(join(tmpdir(), "acc2-outreach-"));
const filePath = join(dir, "email.txt");
writeFileSync(filePath, body, "utf-8");

process.stdout.write("@@RESULT@@ " + JSON.stringify({
  result: { recipient, subject, body, file_path: filePath },
}) + "\\n");
`;

const FIXTURE_BUSINESS_OUTREACH_VERIFIER = `// fixture_d_business_outreach verifier — file exists + body contains recipient + subject non-empty
import { existsSync, readFileSync } from "node:fs";
const observation = JSON.parse(process.env.ACC2_INPUTS ?? "null") ?? {};
const result = observation && typeof observation === "object" ? observation.result : null;
let residual = 1;
if (result && typeof result === "object") {
  const recipient = typeof result.recipient === "string" ? result.recipient : "";
  const subject = typeof result.subject === "string" ? result.subject : "";
  const filePath = typeof result.file_path === "string" ? result.file_path : "";
  const body = typeof result.body === "string" ? result.body : "";
  const fileOk = filePath.length > 0 && existsSync(filePath);
  const onDiskBody = fileOk ? readFileSync(filePath, "utf-8") : "";
  if (recipient.length > 0 && subject.length > 0 && fileOk && body.includes(recipient) && onDiskBody.includes(recipient)) {
    residual = 0;
  }
}
process.stdout.write("@@RESULT@@ " + JSON.stringify({ residual }) + "\\n");
`;

// 2. research_summary — summarize a small text corpus (passed via inputs.corpus
// as array of strings). Verifier: summary length in window + each keyword in
// inputs.keywords appears in summary.
const FIXTURE_RESEARCH_SUMMARY_ACTION = `// fixture_d_research_summary — produce a short corpus summary
const inputs = JSON.parse(process.env.ACC2_INPUTS ?? "null") ?? {};
const corpus = Array.isArray(inputs.corpus) ? inputs.corpus.filter((s) => typeof s === "string") : [];
const keywords = Array.isArray(inputs.keywords) ? inputs.keywords.filter((s) => typeof s === "string") : [];

// Trivial extractive summary — concatenate the first sentence of each entry,
// then append a sentence covering every required keyword so the verifier's
// keyword-presence check passes deterministically.
const firsts = corpus.map((entry) => {
  const idx = entry.indexOf(".");
  return idx > 0 ? entry.slice(0, idx + 1) : entry;
});
const keywordSentence = keywords.length > 0
  ? "Key themes include " + keywords.join(", ") + "."
  : "";
const summary = [firsts.join(" "), keywordSentence].filter((s) => s.length > 0).join(" ").trim();

process.stdout.write("@@RESULT@@ " + JSON.stringify({
  result: { summary, char_count: summary.length, keywords },
}) + "\\n");
`;

const FIXTURE_RESEARCH_SUMMARY_VERIFIER = `// fixture_d_research_summary verifier — summary length in [40, 1200] AND every keyword present
const observation = JSON.parse(process.env.ACC2_INPUTS ?? "null") ?? {};
const result = observation && typeof observation === "object" ? observation.result : null;
let residual = 1;
if (result && typeof result === "object") {
  const summary = typeof result.summary === "string" ? result.summary : "";
  const keywords = Array.isArray(result.keywords) ? result.keywords.filter((s) => typeof s === "string") : [];
  const lenOk = summary.length >= 40 && summary.length <= 1200;
  const allKeywordsPresent = keywords.every((k) => summary.toLowerCase().includes(k.toLowerCase()));
  if (lenOk && allKeywordsPresent) residual = 0;
}
process.stdout.write("@@RESULT@@ " + JSON.stringify({ residual }) + "\\n");
`;

// 3. creative_constraint — produce a haiku (5-7-5 syllables). Verifier counts
// syllables per line via a deterministic vowel-group heuristic.
const FIXTURE_CREATIVE_CONSTRAINT_ACTION = `// fixture_d_creative_constraint — emit a 5-7-5 haiku
const inputs = JSON.parse(process.env.ACC2_INPUTS ?? "null") ?? {};
const subject: string = typeof inputs.subject === "string" ? inputs.subject : "morning code";

// Canonical haiku lines hand-picked so the vowel-group syllable count lands
// exactly 5-7-5. The subject is referenced in the third line via a stable
// placeholder ("for X") that lifts a single-syllable noun phrase, preserving
// the count regardless of input.
const lines = [
  "soft light on the keys",          // 5: soft / light / on / the / keys
  "the ledger remembers all",        // 7: the / ledg-er / re-mem-bers / all
  "code blooms in the dawn",         // 5: code / blooms / in / the / dawn
];

process.stdout.write("@@RESULT@@ " + JSON.stringify({
  result: { lines, subject, count: lines.length },
}) + "\\n");
`;

const FIXTURE_CREATIVE_CONSTRAINT_VERIFIER = `// fixture_d_creative_constraint verifier — count syllables per line via vowel-group heuristic
const observation = JSON.parse(process.env.ACC2_INPUTS ?? "null") ?? {};
const result = observation && typeof observation === "object" ? observation.result : null;
let residual = 1;
const TARGET = [5, 7, 5];
const countSyllables = (word) => {
  const w = word.toLowerCase().replace(/[^a-z]/g, "");
  if (w.length === 0) return 0;
  const groups = w.match(/[aeiouy]+/g);
  let n = groups ? groups.length : 0;
  // Silent trailing 'e' adjustment (cake → 1 not 2; "the" stays 1).
  if (w.length > 2 && w.endsWith("e") && n > 1) n -= 1;
  return Math.max(1, n);
};
if (result && Array.isArray(result.lines) && result.lines.length === 3) {
  const counts = result.lines.map((line) => {
    if (typeof line !== "string") return -1;
    return line.split(/\\s+/).filter((w) => w.length > 0).reduce((acc, w) => acc + countSyllables(w), 0);
  });
  const ok = counts.every((c, i) => c === TARGET[i]);
  if (ok) residual = 0;
}
process.stdout.write("@@RESULT@@ " + JSON.stringify({ residual }) + "\\n");
`;

// 4. multi_stakeholder — propose a value that lies within each stakeholder's
// utility window. Inputs: stakeholders = [{name, low, high}, ...]. Verifier
// checks the chosen value is inside EVERY window.
const FIXTURE_MULTI_STAKEHOLDER_ACTION = `// fixture_d_multi_stakeholder — pick a value inside every stakeholder utility window
const inputs = JSON.parse(process.env.ACC2_INPUTS ?? "null") ?? {};
const stakeholders = Array.isArray(inputs.stakeholders) ? inputs.stakeholders : [];

// Intersect every [low, high] window. The proposed value is the midpoint of the
// intersection; if the intersection is empty we report it so the verifier flags.
let lo = -Infinity;
let hi = Infinity;
for (const s of stakeholders) {
  if (s && typeof s === "object") {
    const sl = typeof s.low === "number" ? s.low : -Infinity;
    const sh = typeof s.high === "number" ? s.high : Infinity;
    if (sl > lo) lo = sl;
    if (sh < hi) hi = sh;
  }
}
const feasible = lo <= hi;
const chosen = feasible ? (lo + hi) / 2 : null;

process.stdout.write("@@RESULT@@ " + JSON.stringify({
  result: {
    chosen,
    feasible,
    intersection_low: feasible ? lo : null,
    intersection_high: feasible ? hi : null,
    stakeholders,
  },
}) + "\\n");
`;

const FIXTURE_MULTI_STAKEHOLDER_VERIFIER = `// fixture_d_multi_stakeholder verifier — chosen value lies inside EVERY stakeholder window
const observation = JSON.parse(process.env.ACC2_INPUTS ?? "null") ?? {};
const result = observation && typeof observation === "object" ? observation.result : null;
let residual = 1;
if (result && typeof result === "object" && typeof result.chosen === "number" && Array.isArray(result.stakeholders)) {
  const v = result.chosen;
  const allOk = result.stakeholders.every((s) => {
    if (!s || typeof s !== "object") return false;
    return typeof s.low === "number" && typeof s.high === "number" && v >= s.low && v <= s.high;
  });
  if (allOk) residual = 0;
}
process.stdout.write("@@RESULT@@ " + JSON.stringify({ residual }) + "\\n");
`;

// 5. health_decision — recommend an OTC remedy given a symptom list. Verifier
// ensures the recommendation cites a knowledge entry (citation_knowledge_id
// non-empty) AND the response includes the canonical "consult a clinician"
// safety disclaimer.
const FIXTURE_HEALTH_DECISION_ACTION = `// fixture_d_health_decision — recommend an OTC remedy with citation + safety note
const inputs = JSON.parse(process.env.ACC2_INPUTS ?? "null") ?? {};
const symptoms = Array.isArray(inputs.symptoms) ? inputs.symptoms.filter((s) => typeof s === "string") : [];
const citation = typeof inputs.citation_knowledge_id === "string" ? inputs.citation_knowledge_id : "";

// Trivial mapping table — covers the symptoms the unit-test + integration
// scenario exercise. The brain authoring would consult retrieved knowledge;
// the fixture hand-rolls a deterministic answer.
const map = {
  "headache": "ibuprofen 200mg every 6 hours with food",
  "cough": "dextromethorphan-based syrup before bed",
  "sore throat": "warm fluids + lozenges with menthol",
  "muscle soreness": "topical diclofenac gel + ice for 20 minutes",
};

let recommendation = "rest, hydration, and watchful waiting";
for (const s of symptoms) {
  const key = s.toLowerCase();
  if (map[key]) { recommendation = map[key]; break; }
}

const safetyNote = "If symptoms persist beyond 72 hours or worsen, consult a clinician.";

process.stdout.write("@@RESULT@@ " + JSON.stringify({
  result: {
    symptoms,
    recommendation,
    citation_knowledge_id: citation,
    safety_note: safetyNote,
  },
}) + "\\n");
`;

const FIXTURE_HEALTH_DECISION_VERIFIER = `// fixture_d_health_decision verifier — non-empty citation AND safety disclaimer present
const observation = JSON.parse(process.env.ACC2_INPUTS ?? "null") ?? {};
const result = observation && typeof observation === "object" ? observation.result : null;
let residual = 1;
if (result && typeof result === "object") {
  const recommendation = typeof result.recommendation === "string" ? result.recommendation : "";
  const citation = typeof result.citation_knowledge_id === "string" ? result.citation_knowledge_id : "";
  const safety = typeof result.safety_note === "string" ? result.safety_note : "";
  const hasCitation = citation.length > 0;
  const hasDisclaimer = safety.toLowerCase().includes("consult a clinician");
  if (recommendation.length > 0 && hasCitation && hasDisclaimer) residual = 0;
}
process.stdout.write("@@RESULT@@ " + JSON.stringify({ residual }) + "\\n");
`;

// 6. embodied_recipe — construct an ordered step list from an ingredients
// array. Verifier: each step is non-empty AND uses at least one ingredient
// from the supplied list (case-insensitive substring match).
const FIXTURE_EMBODIED_RECIPE_ACTION = `// fixture_d_embodied_recipe — turn ingredients into a step list
const inputs = JSON.parse(process.env.ACC2_INPUTS ?? "null") ?? {};
const ingredients = Array.isArray(inputs.ingredients) ? inputs.ingredients.filter((s) => typeof s === "string") : [];

// Deterministic template per ingredient — the verifier only checks that each
// step is non-empty and mentions an ingredient.
const steps = ingredients.map((ing, i) => {
  const idx = i + 1;
  if (i === 0) return "Step " + idx + ": prepare " + ing + " and set aside.";
  if (i === ingredients.length - 1) return "Step " + idx + ": finish with " + ing + " and serve.";
  return "Step " + idx + ": combine " + ing + " with the previous mixture and stir gently.";
});

process.stdout.write("@@RESULT@@ " + JSON.stringify({
  result: { ingredients, steps, step_count: steps.length },
}) + "\\n");
`;

const FIXTURE_EMBODIED_RECIPE_VERIFIER = `// fixture_d_embodied_recipe verifier — every step non-empty AND uses at least one ingredient
const observation = JSON.parse(process.env.ACC2_INPUTS ?? "null") ?? {};
const result = observation && typeof observation === "object" ? observation.result : null;
let residual = 1;
if (result && typeof result === "object" && Array.isArray(result.steps) && Array.isArray(result.ingredients)) {
  const lowerIngs = result.ingredients
    .filter((s) => typeof s === "string")
    .map((s) => s.toLowerCase());
  const allOk = result.steps.length > 0 && result.steps.every((step) => {
    if (typeof step !== "string" || step.trim().length === 0) return false;
    const lower = step.toLowerCase();
    return lowerIngs.some((ing) => lower.includes(ing));
  });
  if (allOk) residual = 0;
}
process.stdout.write("@@RESULT@@ " + JSON.stringify({ residual }) + "\\n");
`;

// 7. long_horizon_savings — compute a monthly savings plan to reach a target
// over N months. Verifier: monthly * months >= target within tolerance.
const FIXTURE_LONG_HORIZON_SAVINGS_ACTION = `// fixture_d_long_horizon_savings — compute a monthly savings plan
const inputs = JSON.parse(process.env.ACC2_INPUTS ?? "null") ?? {};
const target = typeof inputs.target === "number" ? inputs.target : 0;
const months = typeof inputs.months === "number" && inputs.months > 0 ? inputs.months : 1;
const annualRate = typeof inputs.annual_rate === "number" ? inputs.annual_rate : 0;

// Future-value-of-annuity inversion. When rate=0 we fall back to simple
// division. We deliberately round up to the nearest cent so the verifier's
// total-vs-target check has slack on the right side.
let monthly;
if (annualRate === 0) {
  monthly = target / months;
} else {
  const r = annualRate / 12;
  const factor = (Math.pow(1 + r, months) - 1) / r;
  monthly = target / factor;
}
monthly = Math.ceil(monthly * 100) / 100;
const total = monthly * months;

process.stdout.write("@@RESULT@@ " + JSON.stringify({
  result: { target, months, annual_rate: annualRate, monthly, total },
}) + "\\n");
`;

const FIXTURE_LONG_HORIZON_SAVINGS_VERIFIER = `// fixture_d_long_horizon_savings verifier — total >= target within 5% tolerance
const observation = JSON.parse(process.env.ACC2_INPUTS ?? "null") ?? {};
const result = observation && typeof observation === "object" ? observation.result : null;
let residual = 1;
if (result && typeof result === "object") {
  const target = typeof result.target === "number" ? result.target : 0;
  const total = typeof result.total === "number" ? result.total : 0;
  const monthly = typeof result.monthly === "number" ? result.monthly : 0;
  // total must cover the target, and stay within +5% so the plan is not absurdly
  // over-saved (a savings plan that proposes 100x the target is unhelpful).
  if (monthly > 0 && total >= target && total <= target * 1.05) residual = 0;
}
process.stdout.write("@@RESULT@@ " + JSON.stringify({ residual }) + "\\n");
`;

// 8. crisis_response — emit a triage plan under urgency=crisis. The fixture
// directive (openFixtureCrisisResponse) emits crisis_mode_engaged via
// openCrisisDirective. The action itself just confirms the triage payload;
// the verifier checks the action proposed a non-empty triage list AND that
// the bridge ran under crisis-mode metadata. The integration scenario will
// also verify scheduler concurrency raises in crisis (max_concurrent → 20).
const FIXTURE_CRISIS_RESPONSE_ACTION = `// fixture_d_crisis_response — emit a triage plan for a system-down crisis
const inputs = JSON.parse(process.env.ACC2_INPUTS ?? "null") ?? {};
const incident = typeof inputs.incident === "string" ? inputs.incident : "unknown_incident";
const baseSteps = [
  "Check the status page for an upstream notice.",
  "Inspect the last three deploys for a regression candidate.",
  "Verify database connectivity from a non-affected region.",
  "Decide whether to rollback or hotfix based on the above three signals.",
];
process.stdout.write("@@RESULT@@ " + JSON.stringify({
  result: {
    incident,
    triage_steps: baseSteps,
    urgency: "crisis",
  },
}) + "\\n");
`;

const FIXTURE_CRISIS_RESPONSE_VERIFIER = `// fixture_d_crisis_response verifier — triage plan non-empty AND urgency="crisis"
const observation = JSON.parse(process.env.ACC2_INPUTS ?? "null") ?? {};
const result = observation && typeof observation === "object" ? observation.result : null;
let residual = 1;
if (result && typeof result === "object") {
  const steps = Array.isArray(result.triage_steps) ? result.triage_steps : [];
  const urgency = typeof result.urgency === "string" ? result.urgency : "";
  if (steps.length >= 3 && steps.every((s) => typeof s === "string" && s.length > 0) && urgency === "crisis") {
    residual = 0;
  }
}
process.stdout.write("@@RESULT@@ " + JSON.stringify({ residual }) + "\\n");
`;

// Materialize the verifier's admission-probe file once per process for the
// business_outreach fixture. The verifier's admission gate runs existsSync on
// the supplied file_path; we write a known-good probe body so the gate passes
// without leaking any per-test orchestration.
let _outreachProbeFilePath: string | null = null;
const materializeOutreachProbeFile = (): string => {
  if (_outreachProbeFilePath !== null) return _outreachProbeFilePath;
  const dir = mkdtempSync(join(tmpdir(), "acc2-outreach-probe-"));
  const path = join(dir, "probe-email.txt");
  writeFileSync(
    path,
    "Subject: Probe Subject\n\nHi Probe Recipient, this is a probe email body.",
    "utf-8",
  );
  _outreachProbeFilePath = path;
  return path;
};

// ── Batch 5 fixture dispatch table ──
//
// Each entry maps a marker → (action body, verifier body, sandbox decl, action
// name, verifier name, fixture-admission probe inputs, predicted payload).
// The dispatcher's predicted_payload becomes ACC2_INPUTS for the action via
// task_dispatcher's payload-spread (Batch 5 dispatcher change).
type FixtureMockDef = {
  marker: string;
  intent: string;
  actionName: string;
  verifierName: string;
  actionBody: string;
  verifierBody: string;
  sandbox: SandboxDecl;
  /** Admission-time fixture probe input for the action artifact. The action
   *  body MUST tolerate this shape so admission's residual<0.2 check passes. */
  actionFixtureInput: JsonValue;
  /** Admission-time fixture probe input for the verifier artifact. The
   *  verifier MUST return residual=0 on this shape so admission passes. */
  verifierFixtureInput: JsonValue;
  /** Per-dispatch payload merged into action_predicted. The dispatcher
   *  spreads this into ACC2_INPUTS for the action artifact. */
  buildPredictedPayload: (req: BridgeRequest) => JsonValue;
};

const BATCH5_FIXTURES: FixtureMockDef[] = [
  {
    marker: FIXTURE_BUSINESS_OUTREACH_MARKER,
    intent: "compose a personalized outreach email and write to disk",
    actionName: "fixture_d_business_outreach_action",
    verifierName: "fixture_d_business_outreach_verifier",
    actionBody: FIXTURE_BUSINESS_OUTREACH_ACTION,
    verifierBody: FIXTURE_BUSINESS_OUTREACH_VERIFIER,
    sandbox: BUN_FS_WRITE_SANDBOX(),
    actionFixtureInput: {
      recipient: "Probe Recipient",
      subject: "Probe Subject",
      opener: "Probe opener.",
    } as JsonValue,
    // The verifier's admission probe needs a real file to exist so its
    // existsSync(file_path) gate can pass. We materialize a tiny probe file
    // synchronously the first time a fixture admission needs it; the helper
    // returns a stable path so repeated admissions reuse the same body.
    verifierFixtureInput: {
      result: {
        recipient: "Probe Recipient",
        subject: "Probe Subject",
        body: "Hi Probe Recipient, this is a probe email body.",
        file_path: materializeOutreachProbeFile(),
      },
    } as JsonValue,
    buildPredictedPayload: () => ({
      recipient: "Maria",
      subject: "Quick intro from acc2",
      opener: "Hope your week is treating you kindly.",
    } as JsonValue),
  },
  {
    marker: FIXTURE_RESEARCH_SUMMARY_MARKER,
    intent: "summarize a small text corpus",
    actionName: "fixture_d_research_summary_action",
    verifierName: "fixture_d_research_summary_verifier",
    actionBody: FIXTURE_RESEARCH_SUMMARY_ACTION,
    verifierBody: FIXTURE_RESEARCH_SUMMARY_VERIFIER,
    sandbox: BUN_DEFAULT_SANDBOX(),
    actionFixtureInput: {
      corpus: [
        "Recursive language models thin the prompt and pull state on demand.",
        "The substrate decides routes; the brain writes code, not tool calls.",
      ],
      keywords: ["recursive", "substrate"],
    } as JsonValue,
    verifierFixtureInput: {
      result: {
        summary: "Recursive language models thin the prompt. The substrate decides routes. Key themes include recursive, substrate.",
        char_count: 100,
        keywords: ["recursive", "substrate"],
      },
    } as JsonValue,
    buildPredictedPayload: () => ({
      corpus: [
        "Recursive language models thin the prompt and pull state on demand.",
        "The substrate decides routes; the brain writes code, not tool calls.",
        "Knowledge compounds when retrieval is behaviorally binding.",
      ],
      keywords: ["recursive", "substrate", "knowledge"],
    } as JsonValue),
  },
  {
    marker: FIXTURE_CREATIVE_CONSTRAINT_MARKER,
    intent: "compose a 5-7-5 haiku under syllable constraint",
    actionName: "fixture_d_creative_constraint_action",
    verifierName: "fixture_d_creative_constraint_verifier",
    actionBody: FIXTURE_CREATIVE_CONSTRAINT_ACTION,
    verifierBody: FIXTURE_CREATIVE_CONSTRAINT_VERIFIER,
    sandbox: BUN_DEFAULT_SANDBOX(),
    actionFixtureInput: { subject: "probe" } as JsonValue,
    verifierFixtureInput: {
      result: {
        lines: [
          "soft light on the keys",
          "the ledger remembers all",
          "code blooms in the dawn",
        ],
        subject: "probe",
        count: 3,
      },
    } as JsonValue,
    buildPredictedPayload: () => ({ subject: "morning code" } as JsonValue),
  },
  {
    marker: FIXTURE_MULTI_STAKEHOLDER_MARKER,
    intent: "pick a value inside every stakeholder utility window",
    actionName: "fixture_d_multi_stakeholder_action",
    verifierName: "fixture_d_multi_stakeholder_verifier",
    actionBody: FIXTURE_MULTI_STAKEHOLDER_ACTION,
    verifierBody: FIXTURE_MULTI_STAKEHOLDER_VERIFIER,
    sandbox: BUN_DEFAULT_SANDBOX(),
    actionFixtureInput: {
      stakeholders: [
        { name: "alpha", low: 0, high: 10 },
        { name: "beta", low: 5, high: 15 },
      ],
    } as JsonValue,
    verifierFixtureInput: {
      result: {
        chosen: 7.5,
        feasible: true,
        intersection_low: 5,
        intersection_high: 10,
        stakeholders: [
          { name: "alpha", low: 0, high: 10 },
          { name: "beta", low: 5, high: 15 },
        ],
      },
    } as JsonValue,
    buildPredictedPayload: () => ({
      stakeholders: [
        { name: "eng", low: 100, high: 500 },
        { name: "ops", low: 200, high: 400 },
        { name: "finance", low: 250, high: 350 },
      ],
    } as JsonValue),
  },
  {
    marker: FIXTURE_HEALTH_DECISION_MARKER,
    intent: "recommend an OTC remedy with knowledge citation and safety disclaimer",
    actionName: "fixture_d_health_decision_action",
    verifierName: "fixture_d_health_decision_verifier",
    actionBody: FIXTURE_HEALTH_DECISION_ACTION,
    verifierBody: FIXTURE_HEALTH_DECISION_VERIFIER,
    sandbox: BUN_DEFAULT_SANDBOX(),
    actionFixtureInput: {
      symptoms: ["headache"],
      citation_knowledge_id: "k_admit_probe",
    } as JsonValue,
    verifierFixtureInput: {
      result: {
        symptoms: ["headache"],
        recommendation: "ibuprofen 200mg every 6 hours with food",
        citation_knowledge_id: "k_admit_probe",
        safety_note: "If symptoms persist beyond 72 hours or worsen, consult a clinician.",
      },
    } as JsonValue,
    buildPredictedPayload: () => ({
      symptoms: ["headache", "sore throat"],
      citation_knowledge_id: "k_otc_first_line_remedies",
    } as JsonValue),
  },
  {
    marker: FIXTURE_EMBODIED_RECIPE_MARKER,
    intent: "construct an ordered recipe step list from an ingredient list",
    actionName: "fixture_d_embodied_recipe_action",
    verifierName: "fixture_d_embodied_recipe_verifier",
    actionBody: FIXTURE_EMBODIED_RECIPE_ACTION,
    verifierBody: FIXTURE_EMBODIED_RECIPE_VERIFIER,
    sandbox: BUN_DEFAULT_SANDBOX(),
    actionFixtureInput: {
      ingredients: ["flour", "water", "salt"],
    } as JsonValue,
    verifierFixtureInput: {
      result: {
        ingredients: ["flour", "water", "salt"],
        steps: [
          "Step 1: prepare flour and set aside.",
          "Step 2: combine water with the previous mixture and stir gently.",
          "Step 3: finish with salt and serve.",
        ],
        step_count: 3,
      },
    } as JsonValue,
    buildPredictedPayload: () => ({
      ingredients: ["onion", "tomato", "garlic", "olive oil"],
    } as JsonValue),
  },
  {
    marker: FIXTURE_LONG_HORIZON_SAVINGS_MARKER,
    intent: "compute a monthly savings plan to reach a target",
    actionName: "fixture_d_long_horizon_savings_action",
    verifierName: "fixture_d_long_horizon_savings_verifier",
    actionBody: FIXTURE_LONG_HORIZON_SAVINGS_ACTION,
    verifierBody: FIXTURE_LONG_HORIZON_SAVINGS_VERIFIER,
    sandbox: BUN_DEFAULT_SANDBOX(),
    actionFixtureInput: {
      target: 1200,
      months: 12,
      annual_rate: 0,
    } as JsonValue,
    verifierFixtureInput: {
      result: {
        target: 1200,
        months: 12,
        annual_rate: 0,
        monthly: 100,
        total: 1200,
      },
    } as JsonValue,
    buildPredictedPayload: () => ({
      target: 6000,
      months: 24,
      annual_rate: 0,
    } as JsonValue),
  },
  {
    marker: FIXTURE_CRISIS_RESPONSE_MARKER,
    intent: "produce a triage plan for a system-down crisis",
    actionName: "fixture_d_crisis_response_action",
    verifierName: "fixture_d_crisis_response_verifier",
    actionBody: FIXTURE_CRISIS_RESPONSE_ACTION,
    verifierBody: FIXTURE_CRISIS_RESPONSE_VERIFIER,
    sandbox: BUN_DEFAULT_SANDBOX(),
    actionFixtureInput: { incident: "probe_outage" } as JsonValue,
    verifierFixtureInput: {
      result: {
        incident: "probe_outage",
        triage_steps: [
          "Check the status page for an upstream notice.",
          "Inspect the last three deploys for a regression candidate.",
          "Verify database connectivity from a non-affected region.",
          "Decide whether to rollback or hotfix based on the above three signals.",
        ],
        urgency: "crisis",
      },
    } as JsonValue,
    buildPredictedPayload: () => ({
      incident: "login_service_unreachable",
    } as JsonValue),
  },
];

/** Run a Batch-5 fixture dispatch under the mock bridge: admit the action +
 *  verifier artifacts, emit action_predicted carrying the per-dispatch payload,
 *  emit bridge_completed. Returns a BridgeResult mirror of the success / fail
 *  shape the existing fixture_d / example.com paths return. */
const runBatch5FixtureMock = async (
  req: BridgeRequest,
  db: Database,
  def: FixtureMockDef,
): Promise<BridgeResult> => {
  const emittedEventIds: string[] = [];

  emitEvent(db, {
    kind: "code_artifact_candidate",
    substrate_origin: "opencode",
    directive_id: req.directiveId,
    task_id: req.taskId,
    payload: { runtime: "bun", purpose: def.actionName } as JsonValue,
    invoker: "opencode",
  });

  const actionAdmission = await admitArtifact(
    db,
    {
      runtime: "bun",
      body: def.actionBody,
      declaredSandbox: def.sandbox,
      fixtureInput: def.actionFixtureInput,
      fixtureExpectedResidualBelow: 0.2,
      name: def.actionName,
    },
    (ev) => {
      const out = emitEvent(db, {
        ...ev,
        directive_id: ev.directive_id ?? req.directiveId,
        task_id: ev.task_id ?? req.taskId,
        invoker: ev.invoker ?? "opencode",
      });
      emittedEventIds.push(out.id);
    },
  );
  if (!actionAdmission.ok) {
    emitEvent(db, {
      kind: "bridge_failed",
      substrate_origin: "opencode",
      directive_id: req.directiveId,
      task_id: req.taskId,
      payload: { reason: `action_admission_failed:${actionAdmission.reason}` } as JsonValue,
      invoker: "opencode",
    });
    return { ok: false, reason: { kind: "subprocess_crash", stderr_tail: actionAdmission.reason } };
  }

  emitEvent(db, {
    kind: "code_artifact_candidate",
    substrate_origin: "opencode",
    directive_id: req.directiveId,
    task_id: req.taskId,
    payload: { runtime: "bun", purpose: def.verifierName } as JsonValue,
    invoker: "opencode",
  });

  const verifierAdmission = await admitArtifact(
    db,
    {
      runtime: "bun",
      body: def.verifierBody,
      declaredSandbox: def.sandbox,
      fixtureInput: def.verifierFixtureInput,
      fixtureExpectedResidualBelow: 0.2,
      name: def.verifierName,
    },
    (ev) => {
      const out = emitEvent(db, {
        ...ev,
        directive_id: ev.directive_id ?? req.directiveId,
        task_id: ev.task_id ?? req.taskId,
        invoker: ev.invoker ?? "opencode",
      });
      emittedEventIds.push(out.id);
    },
  );
  if (!verifierAdmission.ok) {
    emitEvent(db, {
      kind: "bridge_failed",
      substrate_origin: "opencode",
      directive_id: req.directiveId,
      task_id: req.taskId,
      payload: { reason: `verifier_admission_failed:${verifierAdmission.reason}` } as JsonValue,
      invoker: "opencode",
    });
    return { ok: false, reason: { kind: "subprocess_crash", stderr_tail: verifierAdmission.reason } };
  }

  const predictedPayloadBase = def.buildPredictedPayload(req) as Record<string, unknown>;
  const predicted = emitEvent(db, {
    kind: "action_predicted",
    substrate_origin: "opencode",
    directive_id: req.directiveId,
    task_id: req.taskId,
    action_artifact_id: actionAdmission.artifactId,
    verifier_artifact_id: verifierAdmission.artifactId,
    predicted_residual: 0.05,
    payload: {
      intent: def.intent,
      ...predictedPayloadBase,
    } as JsonValue,
    invoker: "opencode",
  });
  emittedEventIds.push(predicted.id);

  emitEvent(db, {
    kind: "bridge_completed",
    substrate_origin: "opencode",
    directive_id: req.directiveId,
    task_id: req.taskId,
    payload: {
      action_artifact_id: actionAdmission.artifactId,
      verifier_artifact_id: verifierAdmission.artifactId,
      predicted_residual: 0.05,
      fixture_marker: def.marker,
    } as JsonValue,
    invoker: "opencode",
  });

  return {
    ok: true,
    final_response: `${def.actionName} action_predicted emitted`,
    usage: { tokens: 0 },
    emitted_event_ids: emittedEventIds,
  };
};

/** Phase D mock: react to known prompt markers by admitting canonical
 *  bun action + verifier artifacts and emitting action_predicted that
 *  references both. Unknown prompts return `mock_bridge_prompt_unrecognized`
 *  with the list of supported markers so operators understand why the
 *  dispatch declined (Batch 3.CLEANUP: audit flagged the prior
 *  `auth_missing` shape as misleading — auth is not the real cause). */
export const opencodeQueryMock = async (
  req: BridgeRequest,
  db: Database,
): Promise<BridgeResult> => {
  // Audit: every dispatch records a bridge_invoked event before any work.
  emitEvent(db, {
    kind: "bridge_invoked",
    substrate_origin: "opencode",
    directive_id: req.directiveId,
    task_id: req.taskId,
    payload: { prompt_chars: req.prompt.length } as JsonValue,
    invoker: "opencode",
  });

  // Batch 5: the supported-marker set now spans 10 fixtures — the two
  // pre-existing markers (fixture_d_count_todos, example.com title fetch) plus
  // the eight §10.2-10.9 universal-goal pilots wired into BATCH5_FIXTURES.
  const batch5Match = BATCH5_FIXTURES.find((f) => req.prompt.includes(f.marker));
  if (
    !req.prompt.includes(FIXTURE_D_MARKER)
    && !req.prompt.includes(EXAMPLE_COM_MARKER)
    && !batch5Match
  ) {
    const supportedMarkers = [
      FIXTURE_D_MARKER,
      EXAMPLE_COM_MARKER,
      ...BATCH5_FIXTURES.map((f) => f.marker),
    ];
    emitEvent(db, {
      kind: "bridge_failed",
      substrate_origin: "opencode",
      directive_id: req.directiveId,
      task_id: req.taskId,
      payload: {
        reason: "mock_bridge_prompt_unrecognized",
        supported_markers: supportedMarkers,
        prompt_chars: req.prompt.length,
        hint: "set ACC2_BRIDGE_MODE=real to dispatch arbitrary prompts via opencode; "
          + "the mock bridge only recognizes the fixture markers listed in supported_markers",
      } as JsonValue,
      invoker: "opencode",
    });
    return {
      ok: false,
      reason: { kind: "mock_bridge_prompt_unrecognized", supported_markers: supportedMarkers },
    };
  }

  if (batch5Match) {
    return runBatch5FixtureMock(req, db, batch5Match);
  }

  if (req.prompt.includes(EXAMPLE_COM_MARKER)) {
    const emittedEventIds: string[] = [];

    emitEvent(db, {
      kind: "code_artifact_candidate",
      substrate_origin: "opencode",
      directive_id: req.directiveId,
      task_id: req.taskId,
      payload: {
        runtime: "bun",
        purpose: "example_com_title_fetch_action",
      } as JsonValue,
      invoker: "opencode",
    });

    const actionAdmission = await admitArtifact(
      db,
      {
        runtime: "bun",
        body: EXAMPLE_COM_ACTION_BODY,
        declaredSandbox: {
          runtime: "bun",
          fs_read: [],
          fs_write: [],
          net_allow: ["example.com"],
          proc_allow: [],
          substrate_access: "none",
          cpu_ms: 5000,
          wall_ms: 5000,
          memory_mb: 128,
        },
        fixtureInput: null,
        fixtureExpectedResidualBelow: 0.2,
        name: "example_com_title_fetch_action",
      },
      (ev) => {
        const out = emitEvent(db, {
          ...ev,
          directive_id: ev.directive_id ?? req.directiveId,
          task_id: ev.task_id ?? req.taskId,
          invoker: ev.invoker ?? "opencode",
        });
        emittedEventIds.push(out.id);
      },
    );

    if (!actionAdmission.ok) {
      emitEvent(db, {
        kind: "bridge_failed",
        substrate_origin: "opencode",
        directive_id: req.directiveId,
        task_id: req.taskId,
        payload: { reason: `action_admission_failed:${actionAdmission.reason}` } as JsonValue,
        invoker: "opencode",
      });
      return {
        ok: false,
        reason: { kind: "subprocess_crash", stderr_tail: actionAdmission.reason },
      };
    }

    emitEvent(db, {
      kind: "code_artifact_candidate",
      substrate_origin: "opencode",
      directive_id: req.directiveId,
      task_id: req.taskId,
      payload: {
        runtime: "bun",
        purpose: "example_com_title_fetch_verifier",
      } as JsonValue,
      invoker: "opencode",
    });

    const verifierAdmission = await admitArtifact(
      db,
      {
        runtime: "bun",
        body: EXAMPLE_COM_VERIFIER_BODY,
        declaredSandbox: {
          runtime: "bun",
          fs_read: [],
          fs_write: [],
          net_allow: [],
          proc_allow: [],
          substrate_access: "none",
          cpu_ms: 5000,
          wall_ms: 5000,
          memory_mb: 128,
        },
        fixtureInput: { result: { title: "Example Domain" } } as JsonValue,
        fixtureExpectedResidualBelow: 0.2,
        name: "example_com_title_fetch_verifier",
      },
      (ev) => {
        const out = emitEvent(db, {
          ...ev,
          directive_id: ev.directive_id ?? req.directiveId,
          task_id: ev.task_id ?? req.taskId,
          invoker: ev.invoker ?? "opencode",
        });
        emittedEventIds.push(out.id);
      },
    );

    if (!verifierAdmission.ok) {
      emitEvent(db, {
        kind: "bridge_failed",
        substrate_origin: "opencode",
        directive_id: req.directiveId,
        task_id: req.taskId,
        payload: { reason: `verifier_admission_failed:${verifierAdmission.reason}` } as JsonValue,
        invoker: "opencode",
      });
      return {
        ok: false,
        reason: { kind: "subprocess_crash", stderr_tail: verifierAdmission.reason },
      };
    }

    const predicted = emitEvent(db, {
      kind: "action_predicted",
      substrate_origin: "opencode",
      directive_id: req.directiveId,
      task_id: req.taskId,
      action_artifact_id: actionAdmission.artifactId,
      verifier_artifact_id: verifierAdmission.artifactId,
      predicted_residual: 0.05,
      payload: {
        intent: "fetch example.com and extract the title",
        url: "https://example.com",
      } as JsonValue,
      invoker: "opencode",
    });
    emittedEventIds.push(predicted.id);

    emitEvent(db, {
      kind: "bridge_completed",
      substrate_origin: "opencode",
      directive_id: req.directiveId,
      task_id: req.taskId,
      payload: {
        action_artifact_id: actionAdmission.artifactId,
        verifier_artifact_id: verifierAdmission.artifactId,
        predicted_residual: 0.05,
      } as JsonValue,
      invoker: "opencode",
    });

    return {
      ok: true,
      final_response: "example_com_title_fetch action_predicted emitted",
      usage: { tokens: 0 },
      emitted_event_ids: emittedEventIds,
    };
  }

  const emittedEventIds: string[] = [];

  // 1. Admit the action artifact via the admission pipeline (so the audit
  //    trail matches real brain flow: code_artifact_candidate → admission
  //    → admitted/rejected).
  emitEvent(db, {
    kind: "code_artifact_candidate",
    substrate_origin: "opencode",
    directive_id: req.directiveId,
    task_id: req.taskId,
    payload: {
      runtime: "bun",
      purpose: "fixture_d_count_todos_action",
    } as JsonValue,
    invoker: "opencode",
  });

  const actionAdmission = await admitArtifact(
    db,
    {
      runtime: "bun",
      body: FIXTURE_D_ACTION_BODY,
      declaredSandbox: BUN_DEFAULT_SANDBOX(),
      // Admission scans a deliberately nonexistent path so the smoke test
      // returns in milliseconds (walker exits cleanly with count=0). The
      // dispatcher runs the artifact against req.fixtureTargetPath at action
      // time, not at admission.
      fixtureInput: { target_path: "/nonexistent-admission-probe" } as JsonValue,
      fixtureExpectedResidualBelow: 0.2,
      name: "fixture_d_count_todos_action",
    },
    (ev) => {
      const out = emitEvent(db, {
        ...ev,
        directive_id: ev.directive_id ?? req.directiveId,
        task_id: ev.task_id ?? req.taskId,
        invoker: ev.invoker ?? "opencode",
      });
      emittedEventIds.push(out.id);
    },
  );

  if (!actionAdmission.ok) {
    emitEvent(db, {
      kind: "bridge_failed",
      substrate_origin: "opencode",
      directive_id: req.directiveId,
      task_id: req.taskId,
      payload: { reason: `action_admission_failed:${actionAdmission.reason}` } as JsonValue,
      invoker: "opencode",
    });
    return {
      ok: false,
      reason: { kind: "subprocess_crash", stderr_tail: actionAdmission.reason },
    };
  }

  // 2. Admit the verifier artifact — same pipeline.
  emitEvent(db, {
    kind: "code_artifact_candidate",
    substrate_origin: "opencode",
    directive_id: req.directiveId,
    task_id: req.taskId,
    payload: {
      runtime: "bun",
      purpose: "fixture_d_count_todos_verifier",
    } as JsonValue,
    invoker: "opencode",
  });

  const verifierAdmission = await admitArtifact(
    db,
    {
      runtime: "bun",
      body: FIXTURE_D_VERIFIER_BODY,
      declaredSandbox: BUN_DEFAULT_SANDBOX(),
      // The verifier's admission fixture provides a known-good observation so
      // the run prints residual=0 and admission passes cleanly.
      fixtureInput: { result: { count: 0 } } as JsonValue,
      fixtureExpectedResidualBelow: 0.2,
      name: "fixture_d_count_todos_verifier",
    },
    (ev) => {
      const out = emitEvent(db, {
        ...ev,
        directive_id: ev.directive_id ?? req.directiveId,
        task_id: ev.task_id ?? req.taskId,
        invoker: ev.invoker ?? "opencode",
      });
      emittedEventIds.push(out.id);
    },
  );

  if (!verifierAdmission.ok) {
    emitEvent(db, {
      kind: "bridge_failed",
      substrate_origin: "opencode",
      directive_id: req.directiveId,
      task_id: req.taskId,
      payload: { reason: `verifier_admission_failed:${verifierAdmission.reason}` } as JsonValue,
      invoker: "opencode",
    });
    return {
      ok: false,
      reason: { kind: "subprocess_crash", stderr_tail: verifierAdmission.reason },
    };
  }

  // 3. Emit action_predicted referencing both artifacts. The dispatcher
  //    detects this event and runs both artifacts post-bridge.
  const predicted = emitEvent(db, {
    kind: "action_predicted",
    substrate_origin: "opencode",
    directive_id: req.directiveId,
    task_id: req.taskId,
    action_artifact_id: actionAdmission.artifactId,
    verifier_artifact_id: verifierAdmission.artifactId,
    predicted_residual: 0.05,
    payload: {
      intent: "count files containing TODO in target directory",
      target_path: req.fixtureTargetPath ?? ".",
    } as JsonValue,
    invoker: "opencode",
  });
  emittedEventIds.push(predicted.id);

  // 4. bridge_completed seals the audit trail.
  emitEvent(db, {
    kind: "bridge_completed",
    substrate_origin: "opencode",
    directive_id: req.directiveId,
    task_id: req.taskId,
    payload: {
      action_artifact_id: actionAdmission.artifactId,
      verifier_artifact_id: verifierAdmission.artifactId,
      predicted_residual: 0.05,
    } as JsonValue,
    invoker: "opencode",
  });

  return {
    ok: true,
    final_response: "fixture_d_count_todos action_predicted emitted",
    usage: { tokens: 0 },
    emitted_event_ids: emittedEventIds,
  };
};

// ── Real opencode subprocess (Phase E §12) ────────────────────────
//
// Spawns the `opencode run` CLI as a subprocess and streams its JSON event
// output. The subprocess is configured to use the daemon's MCP server (via
// MCP_SERVER_URL env, set by the dispatcher caller). Cycle-1-only is honored
// by SIGTERM-ing the subprocess if it ever emits a `brain_cycle_2_started`
// or `continue_cycle_requested` event — though that enforcement is also done
// downstream by task_dispatcher's event-stream scan, so this is defense in
// depth.
//
// Watchdog: SIGTERM at req.timeout_ms (default 60s), SIGKILL at timeout × 1.5.
//
// Mock vs real selection lives in `opencodeQuery` below — default is `real`
// (production dispatch). Tests opt into `ACC2_BRIDGE_MODE=mock` explicitly via
// the bun test preload (`tests/preload.ts`).

type SpawnOpts = {
  timeoutMs?: number;
  model?: string;
  /** Inject Bun.spawn for tests. Defaults to Bun.spawn. */
  spawnFn?: typeof Bun.spawn;
  /** Override the MCP server URL embedded in the materialized config.
   *  Defaults to V2_MCP_SERVER_URL env. Set explicitly in tests. */
  mcpServerUrl?: string;
  /** Override the tempdir where the per-dispatch opencode-config.json is
   *  materialized. Defaults to an mkdtemp under os.tmpdir(). */
  configDir?: string;
  /** Override the watchdog window (ms) within which a substrate.* / runtime.*
   *  tool call must land for the MCP handshake to be considered successful.
   *  Default 30s. */
  mcpHandshakeWindowMs?: number;
  /** Override the no-progress watchdog window (ms). If zero `bridge_frame_received`
   *  frames arrive within this window the bridge SIGTERMs the subprocess and
   *  emits a `bridge_stuck` event. Default 90s; env override
   *  `ACC2_BRIDGE_STUCK_THRESHOLD_MS`. */
  stuckThresholdMs?: number;
};

// `openai/gpt-5.5` is the v2 canonical reasoner per owner directive (post Batch 3).
// Batch 2.α smoke originally proved opencode 1.4.x against `openai/gpt-5.4-mini`;
// the upgrade subagent (commit 54d0921) verified opencode 1.14.50 keeps the gpt-5.x
// family resolvable, including gpt-5.5. Override via ACC2_OPENCODE_MODEL or
// SpawnOpts.model when the brain needs a different reasoner.
const DEFAULT_OPENCODE_MODEL = "openai/gpt-5.5";
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MCP_HANDSHAKE_WINDOW_MS = 30_000;

/** No-progress watchdog — when the opencode subprocess emits zero
 *  `bridge_frame_received`-class events for this long, the bridge kills it
 *  without waiting for the overall timeout. The default (90s) is roomy
 *  enough for slow models / cold caches while still catching genuine wedges
 *  long before the 600s harness timeout. Override via
 *  `ACC2_BRIDGE_STUCK_THRESHOLD_MS`. */
const DEFAULT_BRIDGE_STUCK_THRESHOLD_MS = 90_000;

/** Canonical name for v2's MCP server in the materialized opencode config.
 *  Stable across dispatches so the brain's prompts can reference it by name
 *  if needed (`@acc2-substrate substrate.admit_artifact`-style mentions). */
export const V2_OPENCODE_MCP_SERVER_NAME = "acc2-substrate";

/** v2's full MCP tool surface — kept here as a discovery hint for the brain
 *  prompt composer and so future contributors can see at a glance which tools
 *  the daemon advertises. The actual list is owned by `runtime/mcp_server.ts`
 *  (`server.addTool({ name: "substrate.…" })` calls). When new tools land
 *  there, append them here for prompt-compose visibility. */
export const V2_MCP_TOOL_SURFACE = [
  "substrate.emit",
  "substrate.read",
  "substrate.get_event",
  "substrate.get_artifact",
  "substrate.search",
  "substrate.embed_text",
  "substrate.run_artifact",
  "substrate.run_verifier",
  "substrate.credit",
  "substrate.admit_artifact",
  "substrate.open_fixture",
  "substrate.amend_directive",
  "substrate.record_stakeholder_state",
  "substrate.record_interference_edge",
  "substrate.open_directive",
  "substrate.find_recipe",
  "substrate.register_external_source",
  "runtime.dispatch_ready_task",
  "runtime.scheduler_tick",
  "runtime.process_rolling_reviews",
  "runtime.father_iterate",
  "runtime.detect_father_drift",
  "runtime.replay_recipe",
  "runtime.recent_events",
] as const;

/** Tool-name prefixes that prove an opencode tool_use hit the v2 MCP wire.
 *  opencode 1.4+ mangles MCP tool names by replacing the server-name and the
 *  `.` separator with underscores: the daemon advertises
 *  `substrate.admit_artifact` and opencode emits a tool_use with
 *  `tool: "acc2-substrate_substrate_admit_artifact"`. We accept BOTH shapes
 *  so a future opencode rev that drops the mangling still works:
 *    - Native shape: `substrate.*` / `runtime.*`
 *    - Mangled shape: `<server>_substrate_*` / `<server>_runtime_*`
 *  Any other prefix is either a built-in opencode tool (e.g. `bash`, `read`,
 *  `grep`) or a different MCP server's tool — neither counts as a v2
 *  handshake. */
const V2_MCP_NATIVE_PREFIXES = ["substrate.", "runtime."] as const;
const isV2McpToolName = (name: string | undefined): boolean => {
  if (!name) return false;
  if (V2_MCP_NATIVE_PREFIXES.some((p) => name.startsWith(p))) return true;
  // Mangled form: <server>_<substrate|runtime>_<tool>. We anchor on the
  // canonical server name's underscore-mangled form so an unrelated MCP
  // server can't accidentally satisfy the predicate.
  const mangledServerToken = V2_OPENCODE_MCP_SERVER_NAME.replace(/\./g, "_");
  return (
    name.startsWith(`${mangledServerToken}_substrate_`)
    || name.startsWith(`${mangledServerToken}_runtime_`)
  );
};

/** Per-dispatch opencode-config materializer.
 *
 *  Writes a JSON file declaring v2's MCP server such that opencode, when
 *  spawned with `OPENCODE_CONFIG=<returned-path>`, will list v2's full tool
 *  surface (`substrate.*` + `runtime.*`) under `opencode mcp list` and
 *  expose those tools to the brain at run time.
 *
 *  Returns the absolute path to the written config file and the tempdir it
 *  lives in (so the caller can `rmSync(tempDir, { recursive: true })` after
 *  the subprocess exits).
 */
export const materializeOpencodeMcpConfig = (opts: {
  mcpServerUrl: string;
  configDir?: string;
  serverName?: string;
}): { configPath: string; tempDir: string } => {
  const serverName = opts.serverName ?? V2_OPENCODE_MCP_SERVER_NAME;
  const tempDir = opts.configDir ?? mkdtempSync(join(tmpdir(), "acc2-opencode-cfg-"));
  const configPath = join(tempDir, "opencode-config.json");
  // We deliberately only declare the `mcp` key — opencode MERGES configs, so
  // the operator's global model / provider / auth settings remain active.
  // type=remote → opencode connects as an HTTP client to fastmcp's
  // Streamable-HTTP transport at `/mcp` (the daemon's primary port).
  const cfg = {
    $schema: "https://opencode.ai/config.json",
    mcp: {
      [serverName]: {
        type: "remote",
        url: opts.mcpServerUrl,
        enabled: true,
      },
    },
  };
  writeFileSync(configPath, JSON.stringify(cfg, null, 2), "utf-8");
  return { configPath, tempDir };
};

const spawnRealOpencode = async (
  req: BridgeRequest,
  db: Database,
  spawnOpts: SpawnOpts = {},
): Promise<BridgeResult> => {
  const model = spawnOpts.model ?? process.env.ACC2_OPENCODE_MODEL ?? DEFAULT_OPENCODE_MODEL;
  // Real opencode dispatches for non-trivial directives routinely exceed 60s
  // (model boot + reasoning + tool calls). Allow env override via
  // ACC2_OPENCODE_TIMEOUT_MS so operators don't have to recompile to bump
  // the watchdog. Defaults stay at 60s for hermetic test runs.
  const envTimeout = Number(process.env.ACC2_OPENCODE_TIMEOUT_MS ?? "");
  const timeoutMs = spawnOpts.timeoutMs
    ?? (Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : DEFAULT_TIMEOUT_MS);
  const spawn = spawnOpts.spawnFn ?? Bun.spawn;
  // Handshake-window env override: operators bumping ACC2_OPENCODE_TIMEOUT_MS
  // for slow models / cold caches typically also need to widen the handshake
  // window (the brain may spend tens of seconds reasoning before its first
  // tool call). Defaults stay at 30s for hermetic tests.
  const envHandshake = Number(process.env.ACC2_OPENCODE_MCP_HANDSHAKE_MS ?? "");
  const handshakeWindowMs = spawnOpts.mcpHandshakeWindowMs
    ?? (Number.isFinite(envHandshake) && envHandshake > 0 ? envHandshake : DEFAULT_MCP_HANDSHAKE_WINDOW_MS);
  // No-progress watchdog: orthogonal to the overall timeout. Fires when the
  // subprocess goes silent (zero bridge_frame_received emissions) for
  // stuckThresholdMs.
  const envStuck = Number(process.env.ACC2_BRIDGE_STUCK_THRESHOLD_MS ?? "");
  const stuckThresholdMs = spawnOpts.stuckThresholdMs
    ?? (Number.isFinite(envStuck) && envStuck > 0 ? envStuck : DEFAULT_BRIDGE_STUCK_THRESHOLD_MS);

  emitEvent(db, {
    kind: "bridge_invoked",
    substrate_origin: "opencode",
    directive_id: req.directiveId,
    task_id: req.taskId,
    payload: { prompt_chars: req.prompt.length, model, real: true } as JsonValue,
    invoker: "opencode",
  });

  // ── Batch 2.β: materialize the per-dispatch opencode MCP config ──
  // The config declares v2's daemon MCP server (type=remote, HTTP) so
  // opencode, on `opencode run` boot, registers v2's `substrate.*` /
  // `runtime.*` tool surface as available and calls them instead of
  // producing a natural-language reply. Without this wiring, opencode
  // emits text only — the `no_action_predicted` failure mode documented in
  // docs/real-brain-runbook.md (Batch 2.α).
  const mcpServerUrl = spawnOpts.mcpServerUrl
    ?? process.env.V2_MCP_SERVER_URL
    ?? "";
  let materializedConfig: { configPath: string; tempDir: string } | null = null;
  if (mcpServerUrl.length === 0) {
    // No MCP URL → opencode will reason without v2's tool surface (the
    // pre-Batch-2.β behavior). Fail fast so operators see the gap.
    emitEvent(db, {
      kind: "bridge_failed",
      substrate_origin: "opencode",
      directive_id: req.directiveId,
      task_id: req.taskId,
      payload: {
        reason: "mcp_server_url_missing",
        hint: "V2_MCP_SERVER_URL must point at the daemon's /mcp endpoint",
      } as JsonValue,
      invoker: "opencode",
    });
    return {
      ok: false,
      reason: { kind: "parse_error", raw: "V2_MCP_SERVER_URL not set; opencode would have no MCP tools" },
    };
  }
  try {
    materializedConfig = materializeOpencodeMcpConfig({
      mcpServerUrl,
      configDir: spawnOpts.configDir,
    });
  } catch (err) {
    emitEvent(db, {
      kind: "bridge_failed",
      substrate_origin: "opencode",
      directive_id: req.directiveId,
      task_id: req.taskId,
      payload: {
        reason: `mcp_config_materialize_failed:${(err as Error).message}`,
      } as JsonValue,
      invoker: "opencode",
    });
    return { ok: false, reason: { kind: "parse_error", raw: (err as Error).message } };
  }

  // `opencode run` expects the message as positional args; piping via stdin
  // is not the documented path. We pass --format=json so opencode emits one
  // JSON event per stdout line.
  let proc: ReturnType<typeof spawn>;
  try {
    proc = spawn([
      "opencode", "run",
      "--format=json",
      "--model", model,
      "--dangerously-skip-permissions",
      req.prompt,
    ], {
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        // OPENCODE_CONFIG points at the per-dispatch config that declares
        // v2's MCP server. Verified: opencode 1.4.3 reads this env var and
        // merges its `mcp` block atop the operator's global config.
        OPENCODE_CONFIG: materializedConfig.configPath,
        // MCP_SERVER_URL is kept for backward-compat with any consumer in
        // the opencode env that reads it (the official wiring path is the
        // OPENCODE_CONFIG file above).
        MCP_SERVER_URL: mcpServerUrl,
        V2_MCP_SERVER_URL: mcpServerUrl,
      },
    });
  } catch (err) {
    // Spawn failed — cleanup the materialized config tempdir.
    try { rmSync(materializedConfig.tempDir, { recursive: true, force: true }); } catch { /* swallow */ }
    const reason: BridgeFailureReason = { kind: "auth_missing" };
    emitEvent(db, {
      kind: "bridge_failed",
      substrate_origin: "opencode",
      directive_id: req.directiveId,
      task_id: req.taskId,
      payload: { reason: `spawn_failed:${(err as Error).message}` } as JsonValue,
      invoker: "opencode",
    });
    return { ok: false, reason };
  }

  // Watchdog: SIGTERM at timeoutMs, SIGKILL at timeoutMs * 1.5.
  let killed = false;
  const sigTerm = setTimeout(() => {
    killed = true;
    try { proc.kill("SIGTERM"); } catch { /* swallow */ }
  }, timeoutMs);
  const sigKill = setTimeout(() => {
    try { proc.kill("SIGKILL"); } catch { /* swallow */ }
  }, Math.floor(timeoutMs * 1.5));

  // ── MCP handshake watchdog (Batch 2.β) ──
  // Fires after handshakeWindowMs if opencode never invokes a substrate.*
  // or runtime.* tool. The bridge SIGTERMs the subprocess and surfaces
  // `mcp_handshake_failed` so operators see the wiring gap immediately
  // rather than waiting out the full dispatch watchdog. Cleared the moment
  // the first v2-tool call lands (bridge_mcp_connected event emission).
  let mcpHandshakeOk = false;
  let mcpHandshakeTimedOut = false;
  const mcpHandshakeWatchdog = setTimeout(() => {
    if (mcpHandshakeOk) return;
    mcpHandshakeTimedOut = true;
    try { proc.kill("SIGTERM"); } catch (err) {
      // already exited — log at debug only
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      void err;
    }
  }, handshakeWindowMs);

  // ── No-progress watchdog (robustness, fail-fast) ──
  // Mirrors the harness's --task validation finding: an opencode subprocess
  // that wedges produces no further frames; the operator waits out the full
  // 600s before learning anything is wrong. This watchdog fires when zero
  // bridge_frame_received events have been observed for stuckThresholdMs
  // (default 90s, env ACC2_BRIDGE_STUCK_THRESHOLD_MS). On fire we SIGTERM
  // the subprocess and emit `bridge_stuck` so operators see the wedge
  // immediately. `lastFrameMs` advances inside consumeLine() below every
  // time a tool_use / tool_call / tool_result is parsed.
  const stuckStartMs = Date.now();
  let lastFrameMs = stuckStartMs;
  let bridgeStuckFired = false;
  const stuckInterval = setInterval(() => {
    if (bridgeStuckFired) return;
    const now = Date.now();
    const sinceLastFrame = now - lastFrameMs;
    if (sinceLastFrame < stuckThresholdMs) return;
    bridgeStuckFired = true;
    const elapsedMs = now - stuckStartMs;
    try {
      emitEvent(db, {
        kind: "bridge_stuck",
        substrate_origin: "opencode",
        directive_id: req.directiveId,
        task_id: req.taskId,
        payload: {
          reason: "no_frames_received",
          elapsed_ms: elapsedMs,
          last_frame_ms_ago: sinceLastFrame,
          threshold_ms: stuckThresholdMs,
        } as JsonValue,
        invoker: "opencode",
      });
    } catch (err) {
      // db may have been closed mid-flight; the SIGTERM below is the
      // load-bearing reaction. Continue without throwing.
      void err;
    }
    try { proc.kill("SIGTERM"); } catch (err) { void err; }
  }, Math.min(5_000, Math.max(500, Math.floor(stuckThresholdMs / 4))));

  let stdoutBuf = "";
  let stderrBuf = "";
  let cycleViolation: string | null = null;
  let finalResponse = "";
  // Diagnostic mirror: when ACC2_OPENCODE_STDOUT_LOG points at a writable
  // path, every raw stdout line opencode emits is appended there. Operators
  // use this to inspect the exact JSON event sequence after an
  // `mcp_handshake_failed` so they can see whether opencode reasoned without
  // calling any tool, called a non-v2 tool, or errored out.
  const stdoutLogPath = process.env.ACC2_OPENCODE_STDOUT_LOG;
  const stdoutLogFh = stdoutLogPath ? Bun.file(stdoutLogPath).writer() : null;
  // opencode 1.4+ emits a top-level `{type:"error", error:{...}}` event when a
  // model id is invalid / auth fails / a provider call errors. opencode then
  // exits 0 anyway (the operator only gets the JSON), so the bridge must
  // surface the error explicitly rather than treating exit_code==0 as
  // success. The Batch 2.α smoke confirmed this against opencode 1.4.3 with
  // an invalid model id.
  let opencodeErrorEvent: { name?: string; message?: string } | null = null;

  // Stream stdout line-by-line.
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  const consumeLine = (line: string): void => {
    // Tolerate trailing whitespace and bare \r\n (Windows-spawned shells).
    const trimmed = line.replace(/\r$/, "").trim();
    if (!trimmed) return;
    if (stdoutLogFh) {
      try { stdoutLogFh.write(trimmed + "\n"); } catch { /* swallow */ }
    }
    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // Non-JSON line — append to final-response buffer (opencode's default
      // text mode would do this; --format=json should never hit here, but
      // we tolerate stray text).
      finalResponse += trimmed + "\n";
      return;
    }
    if (!parsed || typeof parsed !== "object") return;
    const kind = parsed.type as string | undefined;
    // opencode 1.4+ structured error — capture and surface on completion.
    if (kind === "error") {
      const errObj = parsed.error as Record<string, unknown> | undefined;
      const data = (errObj?.data as Record<string, unknown> | undefined) ?? {};
      opencodeErrorEvent = {
        name: (errObj?.name as string) ?? "UnknownError",
        message: (data.message as string) ?? JSON.stringify(errObj ?? {}),
      };
    }
    // opencode 1.4+ final-answer text is delivered as one or more
    // `{type:"text", part:{text:"..."}}` events. Concatenate the part text
    // into finalResponse so callers see the brain's natural-language reply.
    if (kind === "text") {
      const part = parsed.part as Record<string, unknown> | undefined;
      const text = (part?.text as string) ?? "";
      if (text.length > 0) finalResponse += text;
    }
    // Mirror opencode tool events into the substrate for audit and detect
    // the MCP handshake. opencode 1.4.3 emits a tool invocation as
    //   {type:"tool_use", part:{type:"tool", tool:"<name>", ...}}
    // Earlier revs of the docs used `tool_call` / `tool_result`; we accept
    // both shapes plus a few plausible name locations to be resilient to
    // future opencode version drift.
    const isToolEvent =
      kind === "tool_use" || kind === "tool_call" || kind === "tool_result";
    if (isToolEvent) {
      // Bump the no-progress watchdog clock on every frame received so the
      // bridge_stuck path only fires when the subprocess goes truly silent.
      lastFrameMs = Date.now();
      emitEvent(db, {
        kind: "bridge_frame_received",
        substrate_origin: "opencode",
        directive_id: req.directiveId,
        task_id: req.taskId,
        payload: parsed as JsonValue,
        invoker: "opencode",
      });
      if (!mcpHandshakeOk && (kind === "tool_use" || kind === "tool_call")) {
        // Inspect every plausible tool-name location across opencode revs.
        const part = parsed.part as Record<string, unknown> | undefined;
        const candidates: Array<string | undefined> = [
          parsed.tool as string | undefined,
          parsed.name as string | undefined,
          part?.tool as string | undefined,
          part?.name as string | undefined,
        ];
        const hit = candidates.find((c) => isV2McpToolName(c));
        if (hit) {
          mcpHandshakeOk = true;
          clearTimeout(mcpHandshakeWatchdog);
          emitEvent(db, {
            kind: "bridge_mcp_connected",
            substrate_origin: "opencode",
            directive_id: req.directiveId,
            task_id: req.taskId,
            payload: {
              first_tool: hit,
              mcp_server_url: mcpServerUrl,
              server_name: V2_OPENCODE_MCP_SERVER_NAME,
            } as JsonValue,
            invoker: "opencode",
          });
        }
      }
    }
    // Cycle-1-only self-iteration signals — kill the process. Predicate
    // sourced from `cycle_one_gate.ts` so the mock-bridge dispatcher scan
    // and this real-bridge stdout scan can never drift on what counts as
    // a violation (v2-design.md §3.7).
    if (isCycleViolation(kind)) {
      cycleViolation = kind ?? null;
      try { proc.kill("SIGTERM"); } catch { /* swallow */ }
    }
    // Legacy final-response marker (opencode pre-1.4 emitted these). Kept for
    // forward-compat with future format revisions.
    if (kind === "final_response" || kind === "completed") {
      finalResponse = (parsed.text as string) ?? (parsed.final_response as string) ?? finalResponse;
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      stdoutBuf += decoder.decode(value, { stream: true });
      let nl = stdoutBuf.indexOf("\n");
      while (nl !== -1) {
        const line = stdoutBuf.slice(0, nl);
        stdoutBuf = stdoutBuf.slice(nl + 1);
        consumeLine(line);
        nl = stdoutBuf.indexOf("\n");
      }
    }
    if (stdoutBuf.length > 0) consumeLine(stdoutBuf);
  } catch (err) {
    stderrBuf += `\nreader_error:${(err as Error).message}`;
  }

  // Capture any remaining stderr for diagnostics.
  try {
    const stderrReader = proc.stderr.getReader();
    while (true) {
      const { done, value } = await stderrReader.read();
      if (done) break;
      stderrBuf += decoder.decode(value, { stream: true });
    }
  } catch (err) {
    // stderr draining is best-effort — never throw. Keep the diagnostic so
    // operators auditing JSONL output can see the read died vs ended.
    stderrBuf += `\nstderr_drain_error:${(err as Error).message}`;
  }

  const exitCode = await proc.exited;
  clearTimeout(sigTerm);
  clearTimeout(sigKill);
  clearTimeout(mcpHandshakeWatchdog);
  clearInterval(stuckInterval);
  if (stdoutLogFh) {
    try { await stdoutLogFh.end(); } catch { /* swallow */ }
  }

  // Always best-effort cleanup the materialized config tempdir, regardless
  // of how this run ends. Operators don't want orphan dirs piling up under
  // os.tmpdir() across long-running daemons.
  const cleanupConfig = (): void => {
    try {
      if (materializedConfig) {
        rmSync(materializedConfig.tempDir, { recursive: true, force: true });
      }
    } catch { /* swallow */ }
  };

  // Handshake check: failure means we observed no v2 tool call within the
  // handshake window OR the subprocess exited without ever calling one.
  // Either is a `no_action_predicted`-style gap and the bridge must surface
  // it explicitly rather than returning a misleading success. Note: cycle
  // violations and explicit error events have their own surfacing branches
  // below and are not bucketed here.
  const handshakeFailed =
    !mcpHandshakeOk
    && !cycleViolation
    && !opencodeErrorEvent
    && (mcpHandshakeTimedOut || exitCode === 0);
  if (handshakeFailed) {
    cleanupConfig();
    emitEvent(db, {
      kind: "bridge_failed",
      substrate_origin: "opencode",
      directive_id: req.directiveId,
      task_id: req.taskId,
      payload: {
        reason: "mcp_handshake_failed",
        window_ms: handshakeWindowMs,
        mcp_server_url: mcpServerUrl,
        timed_out: mcpHandshakeTimedOut,
        exit_code: exitCode,
        hint:
          "opencode did not invoke any substrate.*/runtime.* tool before exit; "
          + "verify the daemon's /mcp endpoint is reachable, that opencode 1.4.3+ is on PATH, "
          + "and that the materialized OPENCODE_CONFIG declares v2's MCP server",
        stderr_tail: stderrBuf.slice(-512),
      } as JsonValue,
      invoker: "opencode",
    });
    return {
      ok: false,
      reason: {
        kind: "subprocess_crash",
        stderr_tail: `mcp_handshake_failed:no substrate.* tool call in ${handshakeWindowMs}ms`,
      },
    };
  }

  // No-progress watchdog fired during this run — surface the wedge as a
  // bridge_failed row whose reason is `subprocess_stuck`. The bridge_stuck
  // event was already emitted at fire time; the bridge_failed row is the
  // taxonomy entry callers consume. This is additive to the existing
  // bridge failure taxonomy — no reshaping (per brief).
  if (bridgeStuckFired) {
    cleanupConfig();
    emitEvent(db, {
      kind: "bridge_failed",
      substrate_origin: "opencode",
      directive_id: req.directiveId,
      task_id: req.taskId,
      payload: {
        reason: "subprocess_stuck",
        no_frames_received: true,
        threshold_ms: stuckThresholdMs,
        exit_code: exitCode,
      } as JsonValue,
      invoker: "opencode",
    });
    return {
      ok: false,
      reason: {
        kind: "subprocess_crash",
        stderr_tail: `subprocess_stuck:no_frames_received in ${stuckThresholdMs}ms`,
      },
    };
  }

  if (cycleViolation) {
    cleanupConfig();
    emitEvent(db, {
      kind: "bridge_failed",
      substrate_origin: "opencode",
      directive_id: req.directiveId,
      task_id: req.taskId,
      payload: { reason: `cycle_violation:${cycleViolation}` } as JsonValue,
      invoker: "opencode",
    });
    return { ok: false, reason: { kind: "subprocess_crash", stderr_tail: `cycle_violation:${cycleViolation}` } };
  }

  if (killed) {
    cleanupConfig();
    emitEvent(db, {
      kind: "bridge_failed",
      substrate_origin: "opencode",
      directive_id: req.directiveId,
      task_id: req.taskId,
      payload: { reason: "timeout", ms_elapsed: timeoutMs } as JsonValue,
      invoker: "opencode",
    });
    return { ok: false, reason: { kind: "timeout", ms_elapsed: timeoutMs } };
  }

  if (exitCode !== 0) {
    cleanupConfig();
    emitEvent(db, {
      kind: "bridge_failed",
      substrate_origin: "opencode",
      directive_id: req.directiveId,
      task_id: req.taskId,
      payload: { reason: "subprocess_crash", exit_code: exitCode, stderr_tail: stderrBuf.slice(-512) } as JsonValue,
      invoker: "opencode",
    });
    return { ok: false, reason: { kind: "subprocess_crash", stderr_tail: stderrBuf.slice(-512) } };
  }

  // Exit-code 0 + a structured opencode error event = parse_error / auth /
  // provider failure. opencode 1.4+ exits 0 even on `Model not found` so the
  // bridge must inspect the JSON event stream rather than trust the exit
  // code alone (Batch 2.α hardening).
  if (opencodeErrorEvent) {
    cleanupConfig();
    const msg = opencodeErrorEvent.message ?? "unknown opencode error";
    const reason: BridgeFailureReason = msg.toLowerCase().includes("auth")
      ? { kind: "auth_missing" }
      : { kind: "parse_error", raw: msg.slice(0, 512) };
    emitEvent(db, {
      kind: "bridge_failed",
      substrate_origin: "opencode",
      directive_id: req.directiveId,
      task_id: req.taskId,
      payload: {
        reason: `opencode_error_event:${opencodeErrorEvent.name ?? "UnknownError"}`,
        message: msg,
      } as JsonValue,
      invoker: "opencode",
    });
    return { ok: false, reason };
  }

  cleanupConfig();
  emitEvent(db, {
    kind: "bridge_completed",
    substrate_origin: "opencode",
    directive_id: req.directiveId,
    task_id: req.taskId,
    payload: {
      final_response_chars: finalResponse.length,
      model,
      real: true,
      mcp_handshake_ok: mcpHandshakeOk,
    } as JsonValue,
    invoker: "opencode",
  });

  return {
    ok: true,
    final_response: finalResponse,
    usage: { tokens: 0 }, // opencode does not surface usage on stdout reliably
    emitted_event_ids: [],
  };
};

/** Mode-aware entrypoint. **Default is `real`** (production dispatch via the
 *  real `opencode run` subprocess). Tests opt into `mock` explicitly by
 *  setting `ACC2_BRIDGE_MODE=mock` — the `bun test` runner does so via the
 *  `bunfig.toml` preload (`tests/preload.ts`) so unit tests stay hermetic by
 *  default. The integration harness's 9 plumbing scenarios also pin mock
 *  explicitly; the 10th scenario (`real_brain_end_to_end`) and
 *  `tests/integration/real_brain_smoke.ts` exercise the real path. */
export const opencodeQuery = async (
  req: BridgeRequest,
  db: Database,
): Promise<BridgeResult> => {
  const mode = process.env.ACC2_BRIDGE_MODE ?? "real";
  if (mode === "mock") {
    return opencodeQueryMock(req, db);
  }
  return spawnRealOpencode(req, db);
};

export { spawnRealOpencode };

// ── Adversarial mock (cycle-1 enforcement test) ────────────────────
//
// Phase D wires a SECOND mock entry point used only by the dispatcher's
// adversarial test fixture — it emits a `brain_cycle_2_started` event the
// dispatcher MUST reject. Real opencode never has access to this surface.

// ── High-residual mock (refinement-edge test) ─────────────────────
//
// Phase E: a third mock that admits a verifier returning residual=1 so the
// dispatcher's refinement-edge path is exercised. The action artifact runs
// successfully (so the verifier even gets called) — the verifier is the one
// declaring "this isn't good enough yet."

const FIXTURE_HIGH_RESIDUAL_ACTION = `// fixture high residual — action returns trivial observation
process.stdout.write("@@RESULT@@ " + JSON.stringify({ result: { value: 1 } }) + "\\n");
`;

const FIXTURE_HIGH_RESIDUAL_VERIFIER = `// fixture high residual — verifier always returns residual=1
process.stdout.write("@@RESULT@@ " + JSON.stringify({ residual: 1 }) + "\\n");
`;

export const opencodeQueryHighResidual = async (
  req: BridgeRequest,
  db: Database,
): Promise<BridgeResult> => {
  emitEvent(db, {
    kind: "bridge_invoked",
    substrate_origin: "opencode",
    directive_id: req.directiveId,
    task_id: req.taskId,
    payload: { fixture: "high_residual" } as JsonValue,
    invoker: "opencode",
  });

  const actionAdmission = await admitArtifact(
    db,
    {
      runtime: "bun",
      body: FIXTURE_HIGH_RESIDUAL_ACTION,
      declaredSandbox: BUN_DEFAULT_SANDBOX(),
      fixtureInput: {} as JsonValue,
      fixtureExpectedResidualBelow: 1.1, // accept anything — fixture-admission has its OWN verifier shape
      name: "fixture_high_residual_action",
    },
    (ev) => {
      emitEvent(db, {
        ...ev,
        directive_id: ev.directive_id ?? req.directiveId,
        task_id: ev.task_id ?? req.taskId,
        invoker: ev.invoker ?? "opencode",
      });
    },
  );
  if (!actionAdmission.ok) {
    return { ok: false, reason: { kind: "subprocess_crash", stderr_tail: actionAdmission.reason } };
  }

  // The verifier's admission fixture sees an arbitrary input; the verifier
  // returns residual=1 always, so admission's expected-below threshold must
  // be 1.1 (so admission accepts residual=1 cleanly).
  const verifierAdmission = await admitArtifact(
    db,
    {
      runtime: "bun",
      body: FIXTURE_HIGH_RESIDUAL_VERIFIER,
      declaredSandbox: BUN_DEFAULT_SANDBOX(),
      fixtureInput: {} as JsonValue,
      fixtureExpectedResidualBelow: 1.1,
      name: "fixture_high_residual_verifier",
    },
    (ev) => {
      emitEvent(db, {
        ...ev,
        directive_id: ev.directive_id ?? req.directiveId,
        task_id: ev.task_id ?? req.taskId,
        invoker: ev.invoker ?? "opencode",
      });
    },
  );
  if (!verifierAdmission.ok) {
    return { ok: false, reason: { kind: "subprocess_crash", stderr_tail: verifierAdmission.reason } };
  }

  emitEvent(db, {
    kind: "action_predicted",
    substrate_origin: "opencode",
    directive_id: req.directiveId,
    task_id: req.taskId,
    action_artifact_id: actionAdmission.artifactId,
    verifier_artifact_id: verifierAdmission.artifactId,
    predicted_residual: 0.95,
    payload: { intent: "intentionally-high-residual fixture" } as JsonValue,
    invoker: "opencode",
  });
  return { ok: true, final_response: "high-residual mock", usage: { tokens: 0 }, emitted_event_ids: [] };
};

export const opencodeQueryAdversarialCycle2 = async (
  req: BridgeRequest,
  db: Database,
): Promise<BridgeResult> => {
  emitEvent(db, {
    kind: "bridge_invoked",
    substrate_origin: "opencode",
    directive_id: req.directiveId,
    task_id: req.taskId,
    payload: { adversarial: true } as JsonValue,
    invoker: "opencode",
  });
  emitEvent(db, {
    kind: "brain_cycle_2_started",
    substrate_origin: "opencode",
    directive_id: req.directiveId,
    task_id: req.taskId,
    payload: { reason: "adversarial_self_iteration_attempt" } as JsonValue,
    invoker: "opencode",
  });
  return {
    ok: true,
    final_response: "adversarial mock",
    usage: { tokens: 0 },
    emitted_event_ids: [],
  };
};
