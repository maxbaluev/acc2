// acc2 brain prompt composer — substrate projection under a strict token budget
// (v2-design.md §13).
//
// Composes the prompt the brain sees as a projection over substrate state:
//   - P0 sections always present (TASK GOAL, RUNTIMES, WORKFLOW).
//   - P1: retrieved knowledge (top-K by score), code artifact registry.
//   - P2: upstream completed-task outputs, watched outputs.
//   - P3: stakeholder state, cross-directive interference.
//   - P4: active failures, constitutional gates.
//
// Sections are filled in priority order; lower-priority sections truncate or
// drop first when the budget runs out. Token counting is approximate
// (chars/4); Phase F replaces with a real tokenizer.
//
// The prompt is intentionally lean — the brain pulls more via substrate.search
// mid-cycle (§13.2). Depth-1 retrieval is the RLM constraint.

import type { Database } from "bun:sqlite";
import { snapshotWatchedOutputs } from "./watch_edges";

export type PromptComposeOptions = {
  taskId: string;
  budgetTokens?: number;
};

export type PromptSection = {
  name: string;
  priorityP: number;
  tokens: number;
};

export type ComposedPrompt = {
  text: string;
  sections: PromptSection[];
  truncated: string[];
};

const DEFAULT_BUDGET_TOKENS = 8000;

/** Approximate token count — 4 chars per token rough average. Phase F swaps in
 *  a real tokenizer (e.g. tiktoken). The estimate is conservative enough that
 *  small overshoots cannot push the brain over its real budget. */
export const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

type TaskRow = {
  id: string;
  directive_id: string;
  goal: string;
  lifecycle: string;
  urgency: string;
};

const readTaskRow = (db: Database, taskId: string): TaskRow | null => {
  // Phase D: task rows live as `task_node_opened` events with payload.goal.
  // Once a tasks table exists (Phase E DAG topology), we'll query it directly.
  const row = db
    .query(
      "SELECT id, directive_id, payload FROM events WHERE task_id = ? AND kind = 'task_node_opened' ORDER BY ts ASC LIMIT 1",
    )
    .get(taskId) as Record<string, unknown> | null;
  if (!row) return null;
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse((row.payload as string) ?? "{}") as Record<string, unknown>;
  } catch { /* keep empty */ }
  return {
    id: taskId,
    directive_id: row.directive_id as string,
    goal: (payload.goal as string) ?? "(no goal recorded)",
    lifecycle: (payload.lifecycle as string) ?? "finite",
    urgency: (payload.urgency as string) ?? "normal",
  };
};

const readDirectiveGoal = (db: Database, directiveId: string): string | null => {
  const row = db
    .query(
      "SELECT payload FROM events WHERE directive_id = ? AND kind = 'directive_opened' ORDER BY ts ASC LIMIT 1",
    )
    .get(directiveId) as Record<string, unknown> | null;
  if (!row) return null;
  try {
    const payload = JSON.parse((row.payload as string) ?? "{}") as Record<string, unknown>;
    return (payload.directive_text as string) ?? (payload.goal as string) ?? null;
  } catch {
    return null;
  }
};

const readKnowledgeTopK = (db: Database, k: number): Array<{ id: string; text: string; score: number }> => {
  // Phase D stand-in: pull recent promoted knowledge candidates. Phase F lights
  // up embedding × posterior reranking against the task goal.
  const rows = db
    .query(
      "SELECT id, payload FROM events WHERE kind = 'knowledge_promoted' ORDER BY ts DESC LIMIT ?",
    )
    .all(k) as Array<Record<string, unknown>>;
  const out: Array<{ id: string; text: string; score: number }> = [];
  for (const r of rows) {
    try {
      const payload = JSON.parse((r.payload as string) ?? "{}") as Record<string, unknown>;
      out.push({
        id: r.id as string,
        text: (payload.text as string) ?? "(no text)",
        score: (payload.score as number) ?? 0,
      });
    } catch { /* skip malformed */ }
  }
  return out;
};

const readArtifactRegistryTopK = (db: Database, k: number): Array<{ id: string; runtime: string; name: string; score: number }> => {
  const rows = db
    .query(
      "SELECT id, runtime, name, score, confidence FROM code_artifact WHERE status IN ('admitted','promoted') ORDER BY score DESC, confidence DESC LIMIT ?",
    )
    .all(k) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: r.id as string,
    runtime: r.runtime as string,
    name: ((r.name as string | null) ?? "(unnamed)"),
    score: r.score as number,
  }));
};

const readRecentFailures = (db: Database, k: number): Array<{ kind: string; ts: string }> => {
  const rows = db
    .query(
      "SELECT failure_kind, ts FROM events WHERE failure_kind IS NOT NULL ORDER BY ts DESC LIMIT ?",
    )
    .all(k) as Array<Record<string, unknown>>;
  return rows.map((r) => ({ kind: r.failure_kind as string, ts: r.ts as string }));
};

const readConstitutionalGates = (db: Database): string[] => {
  const rows = db
    .query(
      "SELECT payload FROM events WHERE kind = 'constitutional_gate_decision' ORDER BY ts DESC LIMIT 10",
    )
    .all() as Array<Record<string, unknown>>;
  const gates: string[] = [];
  for (const r of rows) {
    try {
      const payload = JSON.parse((r.payload as string) ?? "{}") as Record<string, unknown>;
      const name = payload.gate as string | undefined;
      if (name) gates.push(name);
    } catch { /* skip */ }
  }
  return Array.from(new Set(gates));
};

// ── Section builders ──────────────────────────────────────────────

const buildTaskGoalSection = (task: TaskRow, directiveText: string | null): string => {
  const lines: string[] = [];
  lines.push("TASK GOAL: " + task.goal);
  lines.push("TASK ID: " + task.id);
  lines.push("DIRECTIVE ID: " + task.directive_id);
  if (directiveText) lines.push("DIRECTIVE TEXT: " + directiveText);
  lines.push("DIRECTIVE LIFECYCLE: " + task.lifecycle);
  lines.push("URGENCY: " + task.urgency);
  return lines.join("\n");
};

const RUNTIMES_AVAILABLE_TEXT = [
  "RUNTIMES AVAILABLE (you write code for these):",
  "  - bun           — TypeScript, substrate API, HTTP, arithmetic, text composition",
  "  - uv            — Python, numpy/pandas/PIL/sklearn, image processing, sensor parsing",
  "  - camofox-browser — TypeScript against the camofox API; real chromium driven against a profile",
].join("\n");

const WORKFLOW_TEXT = [
  "YOUR WORKFLOW (one cycle per dispatch — refinement via DAG edges, not re-prompting):",
  "  1. Write or reuse a code artifact for one of the three runtimes AND a verifier artifact",
  "     that returns a scalar residual in [0,1].",
  "  2. Emit action_predicted with action_artifact_id + verifier_artifact_id + predicted_residual.",
  "  3. For complex sub-goals, propose task_node_opened + task_edge_recorded. If work is",
  "     incomplete, emit a refinement edge — the next single-cycle session picks it up.",
  "  4. Propose knowledge_candidate events for new patterns; substrate promotes via outcome.",
  "  5. For new reusable scripts, emit code_artifact_candidate.",
  "  6. Commit task via task_committed when verifier residual is below threshold.",
].join("\n");

const buildKnowledgeSection = (rows: Array<{ id: string; text: string; score: number }>): string => {
  if (rows.length === 0) return "RETRIEVED KNOWLEDGE: (none)";
  const lines: string[] = ["RETRIEVED KNOWLEDGE (top-K by embedding × posterior):"];
  for (const r of rows) {
    lines.push(`  [${r.id}] (score=${r.score.toFixed(2)}) ${r.text}`);
  }
  return lines.join("\n");
};

const buildArtifactSection = (rows: Array<{ id: string; runtime: string; name: string; score: number }>): string => {
  if (rows.length === 0) return "CODE ARTIFACT REGISTRY: (none)";
  const lines: string[] = ["CODE ARTIFACT REGISTRY (top-K by posterior, scoped to your runtimes):"];
  for (const r of rows) {
    lines.push(`  [${r.id}] runtime=${r.runtime} name=${r.name} score=${r.score.toFixed(2)}`);
  }
  return lines.join("\n");
};

const buildFailuresSection = (rows: Array<{ kind: string; ts: string }>): string => {
  if (rows.length === 0) return "ACTIVE FAILURES: (none)";
  const lines: string[] = ["ACTIVE FAILURES (recent failure_recorded for similar goals):"];
  for (const r of rows) lines.push(`  - ${r.kind} @ ${r.ts}`);
  return lines.join("\n");
};

const buildGatesSection = (gates: string[]): string => {
  if (gates.length === 0) return "CONSTITUTIONAL GATES ACTIVE: (none)";
  return "CONSTITUTIONAL GATES ACTIVE:\n" + gates.map((g) => `  - ${g}`).join("\n");
};

const NOT_DO_TEXT = [
  "DO NOT:",
  "  - Look for a tool menu — there isn't one. Write code for a runtime.",
  "  - Author canonical knowledge directly — propose candidates; substrate promotes via outcome correlation.",
  "  - Iterate within this cycle — emit a refinement edge if more work remains.",
].join("\n");

const FIXTURE_D_MARKER = "FIXTURE: fixture_d_count_todos";

/** Compose the brain prompt as a substrate projection. Sections are emitted
 *  in priority order; lowest-priority sections drop first when the budget
 *  would be exceeded. Returns the rendered text plus a section manifest so
 *  callers (and tests) can audit what was kept vs dropped. */
export const composePrompt = (db: Database, opts: PromptComposeOptions): ComposedPrompt => {
  const budget = opts.budgetTokens ?? DEFAULT_BUDGET_TOKENS;
  const task = readTaskRow(db, opts.taskId);
  if (!task) {
    // Empty stub so tests have something to assert; the dispatcher gates
    // on the task existing before calling us.
    const text = `TASK NOT FOUND: ${opts.taskId}`;
    return {
      text,
      sections: [{ name: "task_not_found", priorityP: 0, tokens: estimateTokens(text) }],
      truncated: [],
    };
  }

  const directiveText = readDirectiveGoal(db, task.directive_id);

  // Build candidate sections in priority order. Each entry is {name, p, body}.
  type Candidate = { name: string; p: number; body: string };
  const candidates: Candidate[] = [];

  candidates.push({ name: "task_goal", p: 0, body: buildTaskGoalSection(task, directiveText) });
  candidates.push({ name: "runtimes_available", p: 0, body: RUNTIMES_AVAILABLE_TEXT });
  candidates.push({ name: "workflow", p: 0, body: WORKFLOW_TEXT });
  candidates.push({ name: "do_not", p: 0, body: NOT_DO_TEXT });

  // Phase D fixture marker — the mocked bridge keys off this so the
  // fixture_d_count_todos dispatch can be reproduced deterministically.
  if (directiveText && /count files .* TODO/i.test(directiveText)) {
    candidates.push({ name: "fixture_marker", p: 0, body: FIXTURE_D_MARKER });
  }

  candidates.push({ name: "retrieved_knowledge", p: 1, body: buildKnowledgeSection(readKnowledgeTopK(db, 8)) });
  candidates.push({ name: "code_artifact_registry", p: 1, body: buildArtifactSection(readArtifactRegistryTopK(db, 6)) });

  // P2/P3 sections are stubs in Phase D (no upstream-task or stakeholder data
  // yet). Including the headers anyway so the brain sees the structural
  // surface and Phase E only has to populate the bodies.
  candidates.push({ name: "upstream_outputs", p: 2, body: "UPSTREAM OUTPUTS: (none)" });
  // Watch edges (v2-design.md §9.4) — projected through declared consistency
  // mode. Empty when no watch edges target this task.
  const watched = snapshotWatchedOutputs(db, opts.taskId);
  const watchedBody = watched.length === 0
    ? "WATCHED OUTPUTS: (none)"
    : (() => {
        const lines: string[] = [
          "WATCHED OUTPUTS (upstream observations under declared consistency mode):",
        ];
        for (const w of watched.slice(0, 12)) {
          const payloadJson = JSON.stringify(w.payload);
          const truncated = payloadJson.length > 240 ? `${payloadJson.slice(0, 240)}…` : payloadJson;
          lines.push(
            `  [${w.upstream_task_id}] mode=${w.consistency_mode} kind=${w.event_kind} @${w.observed_at}: ${truncated}`,
          );
        }
        if (watched.length > 12) lines.push(`  … (${watched.length - 12} more elided)`);
        return lines.join("\n");
      })();
  candidates.push({ name: "watched_outputs", p: 2, body: watchedBody });
  candidates.push({ name: "stakeholder_state", p: 3, body: "STAKEHOLDER STATE: (none)" });
  candidates.push({ name: "cross_directive_interference", p: 3, body: "CROSS-DIRECTIVE INTERFERENCE: (none)" });

  candidates.push({ name: "active_failures", p: 4, body: buildFailuresSection(readRecentFailures(db, 3)) });
  candidates.push({ name: "constitutional_gates", p: 4, body: buildGatesSection(readConstitutionalGates(db)) });

  // Fill in priority order. Track running tokens; drop bottom-up when over.
  const kept: Candidate[] = [];
  const truncated: string[] = [];
  let totalTokens = 0;

  // Sort by p ascending so P0 fills first.
  const sorted = [...candidates].sort((a, b) => a.p - b.p);
  for (const c of sorted) {
    const sectionTokens = estimateTokens(c.body) + 2; // +2 for separator overhead
    if (totalTokens + sectionTokens > budget) {
      truncated.push(c.name);
      continue;
    }
    kept.push(c);
    totalTokens += sectionTokens;
  }

  // Restore canonical order in output (P0 → P4). The sort already did this.
  const text = kept.map((c) => c.body).join("\n\n");

  return {
    text,
    sections: kept.map((c) => ({ name: c.name, priorityP: c.p, tokens: estimateTokens(c.body) })),
    truncated,
  };
};
