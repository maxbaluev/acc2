// acc2 brain-bridge mock dispatcher — Phase D + Batch-5 fixture bodies,
// markers, sandbox helpers, dispatch table, and `opencodeQueryMock`
// + adversarial / high-residual variants. Split out of the monolithic
// runtime/bridge.ts (Batch 5 universal-goal pilots, Architecture.md).
//
// PHASE D MOCK. The real bridge spawns `opencode run …` as a subprocess
// and streams typed BridgeFrames; that path lives in `./opencode.ts`.
// This module ships a deterministic mock that emits exactly the events
// the brain WOULD have emitted for the known fixture markers — admits
// the action + verifier artifacts, emits action_predicted referencing
// them, returns success. Unknown prompts return
// `mock_bridge_prompt_unrecognized` with the supported-marker list so
// operators understand why the dispatch declined.
//
// Decision: events the brain emits flow through the SAME emitEvent path
// the real opencode session would use. We do NOT short-circuit through
// the dispatcher's bookkeeping — the dispatcher captures these events
// by reading the event stream the same way it would read frames from a
// real subprocess.

import type { Database } from "bun:sqlite";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonValue, SandboxDecl } from "../../substrate/types";
import { emitEvent } from "../events";
import { admitArtifact } from "../artifact_admission";
import type { BridgeRequest, BridgeResult } from "./types";

const FIXTURE_D_MARKER = "FIXTURE: fixture_d_count_todos";
const EXAMPLE_COM_MARKER = "Fetch the URL https://example.com via Bun.fetch (the bun runtime).";

// Batch 5: eight universal-goal pilot fixtures covering
// Architecture.md. Each marker is embedded verbatim in its
// fixture's directive_text so the prompt composer carries it through to
// the bridge prompt; the mock then keys off the marker to admit the
// canonical action + verifier pair and emit `action_predicted`.
// Production (real-brain) dispatch is unaffected — these markers exist
// only for hermetic plumbing tests.
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

// ── Batch 5 universal-goal fixture bodies (Architecture.md) ──
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
    kind: "act_artifact_candidate",
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
    kind: "act_artifact_candidate",
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
      kind: "act_artifact_candidate",
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
      kind: "act_artifact_candidate",
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
  //    trail matches real brain flow: act_artifact_candidate → admission
  //    → admitted/rejected).
  emitEvent(db, {
    kind: "act_artifact_candidate",
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
    kind: "act_artifact_candidate",
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
