// Brain self-introspection surface — gives the brain a glass-box view of
// the substrate, its own performance, and what it was shown. Pre-2026-05-17
// the brain operated as a stateless task executor: it received a depth-1
// prompt, emitted events, and never saw its own report card, the catalog
// of what the substrate is, the full trajectory of work on a directive,
// or the prompt that was composed for it. These four builders close that
// loop. They are pure reads — no mutations — surfaced through
// `runtime.{system_map,brain_self_audit,trajectory_replay,prompt_self_inspect}`
// MCP tools and (for the audit) through a P2 reflexive prompt section.
//
// Design principle: every builder returns a STRUCTURED projection the
// brain can reason over directly, not a rendered string. The MCP wire
// JSON-stringifies; the prompt-side renderer flattens to text. Keeps the
// surface usable both from MCP code (where structure matters) and from
// the composer (where token budget matters).

import type { Database } from "bun:sqlite";
import type { JsonValue } from "../substrate/types";
import { EVENT_KINDS } from "../substrate/event_kinds";
import { VIEW_NAMES } from "../substrate/views";
import { McpMethods } from "./mcp_server/types";
import { summarizeEffectiveness, type DirectiveEffectivenessRow } from "./brain_effectiveness";

// ── system_map ───────────────────────────────────────────────────────
//
// Canonical tour-of-itself: what event kinds the brain can emit/observe,
// what views it can read, what tools it can call, what runtimes execute
// action artifacts. One call = the operator manual. Brain reads this once
// per new directive shape, not every cycle.

export type SystemMapEventKindEntry = {
  kind: string;
  producer: string;
  embeddable: boolean;
  narrative: boolean;
  health_metric: boolean;
};

export type SystemMapViewEntry = {
  name: string;
};

export type SystemMap = {
  generated_at: string;
  event_kinds: {
    total: number;
    by_producer: Record<string, number>;
    brain_emissible: SystemMapEventKindEntry[];
    all: SystemMapEventKindEntry[];
  };
  views: {
    total: number;
    names: string[];
  };
  tools: {
    total: number;
    substrate_methods: string[];
    runtime_methods: string[];
  };
  runtimes: string[];
  artifact_registry: {
    total: number;
    top_by_score: Array<{ id: string; runtime: string; name: string; score: number; confidence: number }>;
  };
};

const RUNTIMES_AVAILABLE = ["bun", "uv", "camofox-browser"] as const;

export const buildSystemMap = (db: Database, opts: { artifactTopK?: number } = {}): SystemMap => {
  const generatedAt = new Date().toISOString();
  const k = Math.max(1, Math.min(50, opts.artifactTopK ?? 10));

  const allKinds: SystemMapEventKindEntry[] = Object.entries(EVENT_KINDS).map(([kind, meta]) => ({
    kind,
    producer: meta.producer,
    embeddable: meta.embeddable,
    narrative: meta.narrative,
    health_metric: meta.health_metric,
  }));
  const byProducer: Record<string, number> = {};
  for (const k of allKinds) byProducer[k.producer] = (byProducer[k.producer] ?? 0) + 1;
  const brainEmissible = allKinds.filter((k) => k.producer === "brain" || k.producer === "both");

  const substrateMethods = McpMethods.filter((m) => m.startsWith("substrate."));
  const runtimeMethods = McpMethods.filter((m) => m.startsWith("runtime."));

  const artifactRows = db
    .query(
      `SELECT id, runtime, name, score, confidence
       FROM act_artifact
       WHERE status != 'quarantined'
       ORDER BY score DESC, confidence DESC
       LIMIT ?`,
    )
    .all(k) as Array<{ id: string; runtime: string; name: string; score: number; confidence: number }>;
  const artifactTotal = (db
    .query(`SELECT COUNT(*) AS c FROM act_artifact WHERE status != 'quarantined'`)
    .get() as { c: number }).c;

  return {
    generated_at: generatedAt,
    event_kinds: {
      total: allKinds.length,
      by_producer: byProducer,
      brain_emissible: brainEmissible,
      all: allKinds,
    },
    views: {
      total: VIEW_NAMES.length,
      names: [...VIEW_NAMES],
    },
    tools: {
      total: McpMethods.length,
      substrate_methods: substrateMethods,
      runtime_methods: runtimeMethods,
    },
    runtimes: [...RUNTIMES_AVAILABLE],
    artifact_registry: {
      total: artifactTotal,
      top_by_score: artifactRows,
    },
  };
};

// ── brain_self_audit ────────────────────────────────────────────────
//
// Brain's own report card: emission breakdown, citation rate, proposal
// accept rate, residual distribution, recent failures the brain caused.
// Brain reads this every cycle (via the P2 reflexive prompt section)
// so improvement proposals are evidence-grounded rather than vibes-based.

export type BrainSelfAudit = {
  generated_at: string;
  window_hours: number;
  emissions: {
    total: number;
    by_kind: Record<string, number>;
  };
  citations: {
    knowledge_candidates_emitted: number;
    knowledge_candidates_promoted: number;
    promotion_rate: number;
    contradicted_count: number;
  };
  proposals: {
    lesson_extracted_count: number;
    contract_amendment_proposed_count: number;
    applied_committed_count: number;
    applied_failed_count: number;
    accept_rate: number;
    pending_count: number;
  };
  residuals: {
    samples: number;
    p50: number | null;
    p90: number | null;
    mean: number | null;
    below_threshold_rate: number;
    threshold: number;
  };
  effectiveness: {
    total_directives: number;
    first_dispatch_committed_rate: number;
    by_classification: Record<string, number>;
    median_time_to_commit_ms: number | null;
  };
  recent_brain_failures: Array<{ ts: string; kind: string; failure_kind: string | null; task_id: string }>;
};

const RESIDUAL_THRESHOLD = 0.3;

const percentile = (sorted: number[], p: number): number | null => {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p));
  return sorted[idx] ?? null;
};

export const buildBrainSelfAudit = (
  db: Database,
  opts: { windowHours?: number } = {},
): BrainSelfAudit => {
  const windowHours = opts.windowHours ?? 168; // 7 days default
  const sinceIso = new Date(Date.now() - windowHours * 60 * 60 * 1000).toISOString();

  // Emissions by kind — only rows the brain actually authored.
  const emissionRows = db
    .query(
      `SELECT kind, COUNT(*) AS c FROM events
       WHERE ts >= ? AND substrate_origin = 'opencode'
       GROUP BY kind
       ORDER BY c DESC`,
    )
    .all(sinceIso) as Array<{ kind: string; c: number }>;
  const byKind: Record<string, number> = {};
  let totalEmissions = 0;
  for (const r of emissionRows) {
    byKind[r.kind] = r.c;
    totalEmissions += r.c;
  }

  // Citations — knowledge_candidate authored by brain, then how many
  // were promoted (origin_promoted) or contradicted (candidate_contradicted).
  const kcCount = byKind.knowledge_candidate ?? 0;
  const promotedRow = db
    .query(
      `SELECT COUNT(DISTINCT json_extract(payload, '$.knowledge_id')) AS c
       FROM events
       WHERE ts >= ? AND kind = 'origin_promoted'`,
    )
    .get(sinceIso) as { c: number };
  const contradictedRow = db
    .query(
      `SELECT COUNT(*) AS c FROM events
       WHERE ts >= ? AND kind = 'candidate_contradicted'`,
    )
    .get(sinceIso) as { c: number };
  const promotionRate = kcCount > 0 ? promotedRow.c / kcCount : 0;

  // Proposals — lesson_extracted + contract_amendment_proposed and their
  // applied_change_committed / applied_change_failed outcomes.
  const lessonCount = byKind.lesson_extracted ?? 0;
  const amendmentCount = byKind.contract_amendment_proposed ?? 0;
  const appliedRow = db
    .query(
      `SELECT
         SUM(CASE WHEN kind = 'applied_change_committed' THEN 1 ELSE 0 END) AS committed,
         SUM(CASE WHEN kind = 'applied_change_failed' THEN 1 ELSE 0 END) AS failed
       FROM events
       WHERE ts >= ? AND kind IN ('applied_change_committed', 'applied_change_failed')`,
    )
    .get(sinceIso) as { committed: number | null; failed: number | null };
  const committedCount = appliedRow.committed ?? 0;
  const failedCount = appliedRow.failed ?? 0;
  const proposalTotal = lessonCount + amendmentCount;
  const acceptRate = proposalTotal > 0 ? committedCount / proposalTotal : 0;
  const pendingCount = Math.max(0, proposalTotal - committedCount - failedCount);

  // Residual distribution — action_scored.residual for brain-origin chains.
  const residualRows = db
    .query(
      `SELECT residual FROM events
       WHERE ts >= ? AND kind = 'action_scored' AND residual IS NOT NULL`,
    )
    .all(sinceIso) as Array<{ residual: number }>;
  const residuals = residualRows.map((r) => r.residual).filter((n) => Number.isFinite(n));
  const sorted = [...residuals].sort((a, b) => a - b);
  const meanResidual = residuals.length > 0
    ? residuals.reduce((a, b) => a + b, 0) / residuals.length
    : null;
  const belowThresholdRate = residuals.length > 0
    ? residuals.filter((r) => r < RESIDUAL_THRESHOLD).length / residuals.length
    : 0;

  // Effectiveness via existing projection.
  const effectiveness = summarizeEffectiveness(db, { windowMs: windowHours * 60 * 60 * 1000 });

  // Recent failures the brain caused — task_failed + dispatcher_violation
  // + bridge_stuck on tasks the brain touched. The substrate-side
  // emitters tag these with substrate_origin='substrate_auto' (the
  // dispatcher / bridge worker is the immediate author), so a literal
  // substrate_origin='opencode' filter would MISS every dispatcher
  // violation. The right join is "task_id has at least one brain-
  // authored event" — i.e. the brain dispatched against this task and
  // the substrate-side bookkeeping emitter recorded a failure on it.
  const failureRows = db
    .query(
      `SELECT ts, kind, failure_kind, task_id FROM events
       WHERE ts >= ?
         AND kind IN ('task_failed', 'dispatcher_violation', 'bridge_stuck')
         AND (
           substrate_origin = 'opencode'
           OR invoker = 'opencode'
           OR task_id IN (
             SELECT DISTINCT task_id FROM events
             WHERE substrate_origin = 'opencode' AND ts >= ?
           )
         )
       ORDER BY ts DESC
       LIMIT 10`,
    )
    .all(sinceIso, sinceIso) as Array<{ ts: string; kind: string; failure_kind: string | null; task_id: string }>;

  return {
    generated_at: new Date().toISOString(),
    window_hours: windowHours,
    emissions: {
      total: totalEmissions,
      by_kind: byKind,
    },
    citations: {
      knowledge_candidates_emitted: kcCount,
      knowledge_candidates_promoted: promotedRow.c,
      promotion_rate: promotionRate,
      contradicted_count: contradictedRow.c,
    },
    proposals: {
      lesson_extracted_count: lessonCount,
      contract_amendment_proposed_count: amendmentCount,
      applied_committed_count: committedCount,
      applied_failed_count: failedCount,
      accept_rate: acceptRate,
      pending_count: pendingCount,
    },
    residuals: {
      samples: residuals.length,
      p50: percentile(sorted, 0.5),
      p90: percentile(sorted, 0.9),
      mean: meanResidual,
      below_threshold_rate: belowThresholdRate,
      threshold: RESIDUAL_THRESHOLD,
    },
    effectiveness: {
      total_directives: effectiveness.total,
      first_dispatch_committed_rate: effectiveness.first_dispatch_committed_rate,
      by_classification: effectiveness.by_classification as Record<string, number>,
      median_time_to_commit_ms: effectiveness.median_time_to_commit_ms,
    },
    recent_brain_failures: failureRows,
  };
};

// ── trajectory_replay ──────────────────────────────────────────────
//
// Given a directive_id, project the full task DAG with each node's
// action/residual + emitted knowledge/lessons. One call = "what
// happened on this directive". Brain reads this when refining — it
// sees what's already been tried, not just the current task's prompt.

export type TrajectoryNode = {
  task_id: string;
  parent_task_id: string | null;
  goal: string;
  opened_ts: string;
  status: "open" | "committed" | "failed" | "abandoned";
  terminal_kind?: string;
  terminal_ts?: string;
  failure_kind?: string | null;
  action_count: number;
  latest_residual: number | null;
  knowledge_count: number;
  lesson_count: number;
  amendment_count: number;
};

export type TrajectoryReplay = {
  directive_id: string;
  directive_text: string | null;
  opened_ts: string;
  status: "live" | "completed" | "failed" | "queued_at_cap" | "zombie" | "unknown";
  task_count: number;
  nodes: TrajectoryNode[];
  lessons: Array<{ event_id: string; ts: string; kind: string; summary: string }>;
  amendments: Array<{ event_id: string; ts: string; target_resource: string | null; anchor: string | null }>;
  effectiveness: DirectiveEffectivenessRow | null;
};

const TRAJECTORY_TASK_CAP = 100;

export const buildTrajectoryReplay = (
  db: Database,
  directiveId: string,
): TrajectoryReplay | null => {
  const opened = db
    .query(
      `SELECT id, ts, payload FROM events
       WHERE kind = 'directive_opened' AND directive_id = ?
       ORDER BY ts ASC LIMIT 1`,
    )
    .get(directiveId) as { id: string; ts: string; payload: string } | null;
  if (!opened) return null;

  let directiveText: string | null = null;
  try {
    const p = JSON.parse(opened.payload ?? "{}") as Record<string, unknown>;
    directiveText = typeof p.directive_text === "string" ? p.directive_text : null;
  } catch { /* swallow */ }

  // Walk task nodes for this directive.
  const taskRows = db
    .query(
      `SELECT task_id, parent_task_id, ts, payload FROM events
       WHERE kind = 'task_node_opened' AND directive_id = ?
       ORDER BY ts ASC LIMIT ?`,
    )
    .all(directiveId, TRAJECTORY_TASK_CAP) as Array<{
      task_id: string;
      parent_task_id: string | null;
      ts: string;
      payload: string;
    }>;

  const nodes: TrajectoryNode[] = [];
  for (const row of taskRows) {
    let goal = "";
    try {
      const p = JSON.parse(row.payload ?? "{}") as Record<string, unknown>;
      goal = typeof p.goal === "string" ? p.goal : "";
    } catch { /* swallow */ }
    const terminal = db
      .query(
        `SELECT kind, ts, failure_kind FROM events
         WHERE task_id = ? AND kind IN ('task_committed', 'task_failed', 'task_abandoned')
         ORDER BY ts ASC LIMIT 1`,
      )
      .get(row.task_id) as { kind: string; ts: string; failure_kind: string | null } | null;
    const actionCount = (db
      .query(`SELECT COUNT(*) AS c FROM events WHERE task_id = ? AND kind = 'action_predicted'`)
      .get(row.task_id) as { c: number }).c;
    const latestResidualRow = db
      .query(
        `SELECT residual FROM events
         WHERE task_id = ? AND kind = 'action_scored' AND residual IS NOT NULL
         ORDER BY ts DESC LIMIT 1`,
      )
      .get(row.task_id) as { residual: number } | null;
    const knowledgeCount = (db
      .query(`SELECT COUNT(*) AS c FROM events WHERE task_id = ? AND kind = 'knowledge_candidate'`)
      .get(row.task_id) as { c: number }).c;
    const lessonCount = (db
      .query(`SELECT COUNT(*) AS c FROM events WHERE task_id = ? AND kind = 'lesson_extracted'`)
      .get(row.task_id) as { c: number }).c;
    const amendmentCount = (db
      .query(`SELECT COUNT(*) AS c FROM events WHERE task_id = ? AND kind = 'contract_amendment_proposed'`)
      .get(row.task_id) as { c: number }).c;
    let status: TrajectoryNode["status"] = "open";
    if (terminal) {
      if (terminal.kind === "task_committed") status = "committed";
      else if (terminal.kind === "task_failed") status = "failed";
      else status = "abandoned";
    }
    nodes.push({
      task_id: row.task_id,
      parent_task_id: row.parent_task_id ?? null,
      goal,
      opened_ts: row.ts,
      status,
      terminal_kind: terminal?.kind,
      terminal_ts: terminal?.ts,
      failure_kind: terminal?.failure_kind ?? null,
      action_count: actionCount,
      latest_residual: latestResidualRow?.residual ?? null,
      knowledge_count: knowledgeCount,
      lesson_count: lessonCount,
      amendment_count: amendmentCount,
    });
  }

  const lessonRows = db
    .query(
      `SELECT id, ts, kind, payload FROM events
       WHERE directive_id = ?
         AND kind IN ('lesson_extracted', 'knowledge_candidate')
       ORDER BY ts ASC LIMIT 50`,
    )
    .all(directiveId) as Array<{ id: string; ts: string; kind: string; payload: string }>;
  const lessons = lessonRows.map((row) => {
    let summary = "";
    try {
      const p = JSON.parse(row.payload ?? "{}") as Record<string, unknown>;
      summary = (p.summary as string | undefined)
        ?? (p.claim as string | undefined)
        ?? (p.title as string | undefined)
        ?? "";
    } catch { /* swallow */ }
    return { event_id: row.id, ts: row.ts, kind: row.kind, summary };
  });

  const amendmentRows = db
    .query(
      `SELECT id, ts, payload FROM events
       WHERE directive_id = ? AND kind = 'contract_amendment_proposed'
       ORDER BY ts ASC LIMIT 30`,
    )
    .all(directiveId) as Array<{ id: string; ts: string; payload: string }>;
  const amendments = amendmentRows.map((row) => {
    let target: string | null = null;
    let anchor: string | null = null;
    try {
      const p = JSON.parse(row.payload ?? "{}") as Record<string, unknown>;
      target = (p.target_resource as string | undefined)
        ?? (p.resource_uri as string | undefined)
        ?? null;
      anchor = (p.anchor as string | undefined) ?? null;
    } catch { /* swallow */ }
    return { event_id: row.id, ts: row.ts, target_resource: target, anchor };
  });

  // Lifecycle status — read the resolved view if it returns a row, else
  // derive a best-effort label from terminal events on the root.
  let status: TrajectoryReplay["status"] = "unknown";
  try {
    const resolvedRow = db
      .query(
        `SELECT lifecycle_status FROM dispatch_resolved_view
         WHERE directive_id = ?
         ORDER BY terminal_at DESC
         LIMIT 1`,
      )
      .get(directiveId) as { lifecycle_status: string } | null;
    if (resolvedRow) status = resolvedRow.lifecycle_status as TrajectoryReplay["status"];
  } catch {
    // dispatch_resolved_view may not be materialized in some bare test
    // setups; status stays "unknown" in that path.
  }

  // Effectiveness for this single directive (re-uses the classifier).
  let effectiveness: DirectiveEffectivenessRow | null = null;
  try {
    const { classifyDirective } = require("./brain_effectiveness") as typeof import("./brain_effectiveness");
    effectiveness = classifyDirective(db, directiveId);
  } catch { /* swallow — classifier optional */ }

  return {
    directive_id: directiveId,
    directive_text: directiveText,
    opened_ts: opened.ts,
    status,
    task_count: taskRows.length,
    nodes,
    lessons,
    amendments,
    effectiveness,
  };
};

// ── prompt_self_inspect ────────────────────────────────────────────
//
// What was the brain shown for this task? Re-runs composePrompt and
// returns section names + token budgets + truncation list. Brain can
// use this to detect "I was shown an old version of section X" or
// "section Y kept getting truncated; my decisions are missing it".

export type PromptSelfInspect = {
  task_id: string;
  directive_id: string;
  total_tokens: number;
  budget_tokens: number;
  sections: Array<{ name: string; priority: number; tokens: number }>;
  truncated_sections: string[];
  /** Optional preview of the rendered prompt itself. Capped so the brain
   *  can spot-check a section without re-allocating the whole prompt
   *  inside its own context. */
  preview: string;
};

const PROMPT_PREVIEW_CHARS = 4096;

export const buildPromptSelfInspect = (
  db: Database,
  taskId: string,
  opts: { budgetTokens?: number; includePreview?: boolean } = {},
): PromptSelfInspect | null => {
  const row = db
    .query(
      `SELECT directive_id FROM events
       WHERE task_id = ? AND kind = 'task_node_opened' LIMIT 1`,
    )
    .get(taskId) as { directive_id: string } | null;
  if (!row) return null;

  // Lazy-require composePrompt to avoid a top-of-file cycle (composer
  // imports tools from this module via the audit section).
  const { composePrompt } = require("./prompt_composer") as typeof import("./prompt_composer");
  const composed = composePrompt(db, { taskId, budgetTokens: opts.budgetTokens });
  const totalTokens = composed.sections.reduce((sum, s) => sum + s.tokens, 0);
  return {
    task_id: taskId,
    directive_id: row.directive_id,
    total_tokens: totalTokens,
    budget_tokens: opts.budgetTokens ?? 8000,
    sections: composed.sections.map((s) => ({ name: s.name, priority: s.priorityP, tokens: s.tokens })),
    truncated_sections: composed.truncated,
    preview: opts.includePreview
      ? composed.text.slice(0, PROMPT_PREVIEW_CHARS)
      : "",
  };
};

// ── Compact renderer (prompt-side) ─────────────────────────────────
//
// The composer's reflexive section reads buildBrainSelfAudit and flattens
// it to a token-thrifty single block. ≈ 250-400 tokens depending on
// how busy the substrate has been.

export const renderBrainSelfAuditSection = (audit: BrainSelfAudit): string => {
  const lines: string[] = ["BRAIN SELF-AUDIT (your live report card — read this before deciding):"];
  lines.push(`  window=${audit.window_hours}h  emissions=${audit.emissions.total}`);
  const topKinds = Object.entries(audit.emissions.by_kind)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([k, n]) => `${k}=${n}`)
    .join(" ");
  if (topKinds.length > 0) lines.push(`  top_kinds: ${topKinds}`);
  lines.push(
    `  citations: kc_emitted=${audit.citations.knowledge_candidates_emitted} promoted=${audit.citations.knowledge_candidates_promoted} (rate=${audit.citations.promotion_rate.toFixed(2)}) contradicted=${audit.citations.contradicted_count}`,
  );
  lines.push(
    `  proposals: lessons=${audit.proposals.lesson_extracted_count} amendments=${audit.proposals.contract_amendment_proposed_count} committed=${audit.proposals.applied_committed_count} failed=${audit.proposals.applied_failed_count} accept_rate=${audit.proposals.accept_rate.toFixed(2)} pending=${audit.proposals.pending_count}`,
  );
  const p50 = audit.residuals.p50 == null ? "n/a" : audit.residuals.p50.toFixed(2);
  const p90 = audit.residuals.p90 == null ? "n/a" : audit.residuals.p90.toFixed(2);
  const mean = audit.residuals.mean == null ? "n/a" : audit.residuals.mean.toFixed(2);
  lines.push(
    `  residuals: n=${audit.residuals.samples} p50=${p50} p90=${p90} mean=${mean} below_${audit.residuals.threshold}_rate=${audit.residuals.below_threshold_rate.toFixed(2)}`,
  );
  lines.push(
    `  effectiveness: directives=${audit.effectiveness.total_directives} first_dispatch_committed_rate=${audit.effectiveness.first_dispatch_committed_rate.toFixed(2)} median_commit_ms=${audit.effectiveness.median_time_to_commit_ms ?? "n/a"}`,
  );
  if (audit.recent_brain_failures.length > 0) {
    lines.push(`  recent_failures (${audit.recent_brain_failures.length}):`);
    for (const f of audit.recent_brain_failures.slice(0, 5)) {
      lines.push(`    ${f.ts} ${f.kind}${f.failure_kind ? `:${f.failure_kind}` : ""} task=${f.task_id}`);
    }
  }
  lines.push(
    "  hint: when accept_rate is low, ground next proposal in trajectory_replay + system_map evidence; when promotion_rate is low, write tighter falsifiable claims.",
  );
  return lines.join("\n");
};

// Cast helpers — the MCP handlers accept JsonValue; these wrap each
// structured result into the wire shape.
export const systemMapToJson = (m: SystemMap): JsonValue => m as unknown as JsonValue;
export const brainSelfAuditToJson = (a: BrainSelfAudit): JsonValue => a as unknown as JsonValue;
export const trajectoryReplayToJson = (t: TrajectoryReplay): JsonValue => t as unknown as JsonValue;
export const promptSelfInspectToJson = (p: PromptSelfInspect): JsonValue => p as unknown as JsonValue;
