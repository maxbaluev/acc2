// acc2 Tier-S1 — DAG decomposition strategy extractor.
// Per roadmap Tier-S1 + brain KC G3PR7X6TCD4T57D7T6GXCDY9AW (S1 = the
// substrate learns reasoning STRUCTURE, not just leaf decisions).
//
// Today the brain decomposes directives into task_node trees with
// arbitrary fan-out, sibling order, refinement depth, and shape. No
// extractor measured whether a given DECOMPOSITION SHAPE correlates with
// low closure_residual — the substrate had no feedback on "is wide-
// shallow better than deep-narrow for this goal_class?".
//
// This extractor scans completed directives (those with a
// `task_closure_audited` row) in a bounded 30-day window (LIMIT 500
// directives), builds a per-directive DAG fingerprint
// (fan_out, max_depth, total_nodes, branching_factor, closure_residual),
// buckets each directive by a deterministic shape category
// (wide_shallow, deep_narrow, balanced, tree_heavy, minimal, other), and
// admits/upserts ONE act_artifact{kind:"decomposition_strategy_predicate"}
// row per category that meets the 5-sample threshold within the window.
//
// Each row's body carries { shape_category, sample_count, mean_residual,
// std_residual, effective_score, avg_fan_out, avg_max_depth,
// avg_total_nodes, last_observed_ts }. The Beta posterior is calibrated
// the same way as Tier-S5 goal-shape:
//   alpha = 1 + effective_score * sample_count
//   beta  = 1 + (1 - effective_score) * sample_count
// effective_score = (1 - mean_residual) * (1 - normalized_std). LOW
// variance means the shape PREDICTS outcome (which is what we want from
// a STRUCTURAL primitive — the whole point of bucketing trees by shape).
//
// Idempotency: re-runs UPDATE the existing row's metrics + posterior,
// preserving `created_at`. Bounded: yields every 25 directives processed.

import type { Database } from "bun:sqlite";
import { emitEvent } from "./events";

const YIELD_EVERY_N = 25;
const PREDICATE_KIND = "decomposition_strategy_predicate";
const MIN_SAMPLE_COUNT = 5;
const DEFAULT_WINDOW_DAYS = 30;
const DEFAULT_MAX_DIRECTIVES = 500;

const yieldToEventLoop = (): Promise<void> => new Promise<void>((r) => setTimeout(r, 0));

type DirectiveRow = {
  directive_id: string;
  closure_ts: string;
  closure_payload: string | null;
};

type DirectiveEventRow = {
  id: string;
  task_id: string;
  parent_task_id: string | null;
  kind: string;
  payload: string | null;
};

const parsePayload = (raw: string | null): Record<string, unknown> => {
  if (!raw) return {};
  try {
    const p = JSON.parse(raw) as unknown;
    return p && typeof p === "object" && !Array.isArray(p) ? (p as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

const numberOr = (v: unknown, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;

export type ShapeCategory =
  | "inline_atomic"
  | "audit_evidence_sweep"
  | "build_parallel_bundle"
  | "migrate_dependency_chain"
  | "refactor_change_bundle"
  | "synthesize_adjudication"
  | "explore_research_fanout"
  | "owner_gated_decision_tree"
  | "operational_recovery"
  | "rolling_maintenance"
  | "mixed_strategy";

type ShapeCategoryDecision = {
  shape_category: ShapeCategory;
  top_contributing_axes: string[];
  contribution_scores: Record<string, number>;
};

export type ShouldDecomposeDecision = {
  should_decompose: boolean;
  leverage_score: number;
  overhead_score: number;
  margin: number;
  top_contributing_axes: string[];
  contribution_scores: Record<string, number>;
};

type ScoredShouldDecomposePredicateArtifact = {
  kind: "should_decompose_predicate";
  score_inputs: readonly string[];
  decision_rule: "leverage_score_minus_overhead_score_gt_0";
  posterior_seed: { alpha: number; beta: number; score: number; confidence: number };
};

export const SHOULD_DECOMPOSE_PREDICATE_ARTIFACT: ScoredShouldDecomposePredicateArtifact = {
  kind: "should_decompose_predicate",
  score_inputs: [
    "expected_residual_reduction",
    "independent_verifiability",
    "reuse_value",
    "coordination_overhead",
    "context_overhead",
    "owner_control_overhead",
  ],
  decision_rule: "leverage_score_minus_overhead_score_gt_0",
  posterior_seed: { alpha: 1, beta: 1, score: 0.5, confidence: 0.3 },
};

type DagFingerprint = {
  directive_id: string;
  fan_out: number;
  max_depth: number;
  total_nodes: number;
  branching_factor: number;
  closure_residual: number;
  closure_ts: string;
  shape_category: ShapeCategory;
};

const clamp01 = (v: number): number => Math.min(1, Math.max(0, Number.isFinite(v) ? v : 0));

const topAxes = (scores: Record<string, number>, limit = 3): string[] =>
  Object.entries(scores)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([axis]) => axis);

/**
 * Goal-aware decomposition category bucketing. Geometry is retained as
 * evidence, but the category names now describe what the directive is doing
 * and expose the highest-scoring semantic contributors behind the choice.
 */
export const categorizeShapeWithContributors = (
  fan_out: number,
  max_depth: number,
  total_nodes: number,
  evidence: {
    goal_class?: string;
    target_resources?: readonly string[];
    edge_kinds?: readonly string[];
    owner_gate_count?: number;
    recovery_signal?: number;
    rolling_signal?: number;
    adjudication_signal?: number;
  } = {},
): ShapeCategoryDecision => {
  const goal = (evidence.goal_class ?? "").toLowerCase();
  const repoTargets = (evidence.target_resources ?? []).filter((r) => r.startsWith("repo:")).length;
  const edgeText = (evidence.edge_kinds ?? []).join(" ").toLowerCase();
  const contribution_scores: Record<string, number> = {
    goal_audit: goal.includes("audit") ? 1 : 0,
    goal_build: goal.includes("build") ? 1 : 0,
    goal_migrate: goal.includes("migrate") ? 1 : 0,
    goal_refactor: goal.includes("refactor") ? 1 : 0,
    goal_synthesize: goal.includes("synthesize") ? 1 : 0,
    goal_explore: goal.includes("explore") ? 1 : 0,
    fanout_parallelism: clamp01(fan_out / 6),
    depth_dependency: clamp01(max_depth / 6),
    tree_size: clamp01(total_nodes / 15),
    repo_change_surface: clamp01(repoTargets / 4),
    owner_gate: clamp01(evidence.owner_gate_count ?? 0),
    recovery_signal: clamp01(evidence.recovery_signal ?? (edgeText.includes("recover") ? 1 : 0)),
    rolling_signal: clamp01(evidence.rolling_signal ?? (edgeText.includes("review") ? 1 : 0)),
    adjudication_signal: clamp01(evidence.adjudication_signal ?? (edgeText.includes("adjudicat") ? 1 : 0)),
  };

  let shape_category: ShapeCategory = "mixed_strategy";
  if (total_nodes <= 1) shape_category = "inline_atomic";
  else if (contribution_scores.owner_gate > 0) shape_category = "owner_gated_decision_tree";
  else if (contribution_scores.recovery_signal > 0) shape_category = "operational_recovery";
  else if (contribution_scores.rolling_signal > 0) shape_category = "rolling_maintenance";
  else if (contribution_scores.adjudication_signal > 0 || contribution_scores.goal_synthesize > 0) shape_category = "synthesize_adjudication";
  else if (contribution_scores.goal_audit > 0 || (fan_out >= 4 && max_depth <= 3)) shape_category = "audit_evidence_sweep";
  else if (contribution_scores.goal_build > 0 && fan_out >= 3) shape_category = "build_parallel_bundle";
  else if (contribution_scores.goal_migrate > 0 || max_depth >= 4) shape_category = "migrate_dependency_chain";
  else if (contribution_scores.goal_refactor > 0 || repoTargets >= 2) shape_category = "refactor_change_bundle";
  else if (contribution_scores.goal_explore > 0 || fan_out >= 3) shape_category = "explore_research_fanout";

  return {
    shape_category,
    top_contributing_axes: topAxes(contribution_scores),
    contribution_scores,
  };
};

export const categorizeShape = (
  fan_out: number,
  max_depth: number,
  total_nodes: number,
): ShapeCategory => categorizeShapeWithContributors(fan_out, max_depth, total_nodes).shape_category;

export const shouldDecomposePredicate = (args: {
  expected_residual_reduction: number;
  independent_verifiability: number;
  reuse_value: number;
  coordination_overhead: number;
  context_overhead: number;
  owner_control_overhead: number;
}): ShouldDecomposeDecision => {
  const contribution_scores: Record<string, number> = {
    expected_residual_reduction: clamp01(args.expected_residual_reduction),
    independent_verifiability: clamp01(args.independent_verifiability),
    reuse_value: clamp01(args.reuse_value),
    coordination_overhead: clamp01(args.coordination_overhead),
    context_overhead: clamp01(args.context_overhead),
    owner_control_overhead: clamp01(args.owner_control_overhead),
  };
  const leverage_score = clamp01(
    0.55 * contribution_scores.expected_residual_reduction +
      0.30 * contribution_scores.independent_verifiability +
      0.15 * contribution_scores.reuse_value,
  );
  const overhead_score = clamp01(
    0.45 * contribution_scores.coordination_overhead +
      0.35 * contribution_scores.context_overhead +
      0.20 * contribution_scores.owner_control_overhead,
  );
  const margin = leverage_score - overhead_score;
  return {
    should_decompose: margin > 0,
    leverage_score,
    overhead_score,
    margin,
    top_contributing_axes: topAxes(contribution_scores),
    contribution_scores,
  };
};

/**
 * Build the DAG fingerprint for a single directive. fan_out is the
 * number of root-level child task_nodes (parent_task_id IS NULL).
 * max_depth is the longest parent-chain length through the
 * parent_task_id pointers + refines-edge relationships, walked
 * iteratively to avoid recursion blow-up on pathological trees.
 */
const buildFingerprint = (
  directiveId: string,
  closureTs: string,
  closureResidual: number,
  events: DirectiveEventRow[],
): DagFingerprint => {
  // Distinct task_node_opened rows per task_id (dedupe re-emissions).
  const nodes = new Map<string, { task_id: string; parent_task_id: string | null }>();
  // refines/requires edges keyed by to_task — used to derive depth when
  // parent_task_id is not populated on the task_node_opened row.
  const refineParent = new Map<string, string>();

  for (const ev of events) {
    if (ev.kind === "task_node_opened") {
      if (!nodes.has(ev.task_id)) {
        nodes.set(ev.task_id, {
          task_id: ev.task_id,
          parent_task_id: ev.parent_task_id ?? null,
        });
      }
    } else if (ev.kind === "task_edge_recorded") {
      const payload = parsePayload(ev.payload);
      const edgeKind = (payload.kind as string) ?? "requires";
      if (edgeKind !== "refines" && edgeKind !== "requires") continue;
      const from = (payload.from_task as string) ?? (payload.from as string) ?? null;
      const to = (payload.to_task as string) ?? (payload.to as string) ?? null;
      if (!from || !to) continue;
      // refines edges describe parent→child; prefer them over requires
      // for depth derivation since requires is a dataflow ordering.
      if (edgeKind === "refines" && !refineParent.has(to)) {
        refineParent.set(to, from);
      }
    }
  }

  const total_nodes = nodes.size;

  // Root-level children: parent_task_id is null on the node row AND no
  // refines edge points at this task. fan_out counts these directly.
  let fan_out = 0;
  for (const [taskId, node] of nodes) {
    const hasRefineParent = refineParent.has(taskId);
    const hasParent = node.parent_task_id !== null;
    if (!hasParent && !hasRefineParent) fan_out++;
  }

  // max_depth via iterative parent-walk with memoization. Cycles are
  // defensively broken by tracking a per-walk visited set.
  const depthCache = new Map<string, number>();
  const depthOf = (taskId: string): number => {
    if (depthCache.has(taskId)) return depthCache.get(taskId)!;
    const visited = new Set<string>();
    let cur: string | null = taskId;
    let depth = 1;
    while (cur && !visited.has(cur)) {
      visited.add(cur);
      const node = nodes.get(cur);
      const parent =
        (node?.parent_task_id ?? null) ??
        (refineParent.get(cur) ?? null);
      if (!parent || !nodes.has(parent)) break;
      depth++;
      cur = parent;
    }
    depthCache.set(taskId, depth);
    return depth;
  };

  let max_depth = 0;
  for (const taskId of nodes.keys()) {
    const d = depthOf(taskId);
    if (d > max_depth) max_depth = d;
  }
  if (max_depth === 0 && total_nodes > 0) max_depth = 1;

  const branching_factor = total_nodes / Math.max(1, max_depth);
  const shape_category = categorizeShape(fan_out, max_depth, total_nodes);

  return {
    directive_id: directiveId,
    fan_out,
    max_depth,
    total_nodes,
    branching_factor,
    closure_residual: closureResidual,
    closure_ts: closureTs,
    shape_category,
  };
};

export type DecompositionStrategySummary = {
  directives_scanned: number;
  shapes_seen: number;
  rows_admitted: number;
  rows_updated: number;
  skipped_below_threshold: number;
};

type ShapeAggregate = {
  fingerprints: DagFingerprint[];
  last_observed_ts: string;
};

type ShapeMetrics = {
  shape_category: ShapeCategory;
  sample_count: number;
  mean_residual: number;
  std_residual: number;
  effective_score: number;
  avg_fan_out: number;
  avg_max_depth: number;
  avg_total_nodes: number;
  last_observed_ts: string;
};

const computeMetrics = (
  shape: ShapeCategory,
  fingerprints: DagFingerprint[],
  lastObservedTs: string,
): ShapeMetrics => {
  const n = fingerprints.length;
  const residuals = fingerprints.map((f) => f.closure_residual);
  const mean = residuals.reduce((s, r) => s + r, 0) / n;
  const variance = residuals.reduce((s, r) => s + (r - mean) * (r - mean), 0) / n;
  const std = Math.sqrt(variance);
  const normalizedStd = Math.min(Math.max(std, 0), 1);
  const meanClamped = Math.min(Math.max(mean, 0), 1);
  const effective = (1 - meanClamped) * (1 - normalizedStd);
  const avg_fan_out = fingerprints.reduce((s, f) => s + f.fan_out, 0) / n;
  const avg_max_depth = fingerprints.reduce((s, f) => s + f.max_depth, 0) / n;
  const avg_total_nodes = fingerprints.reduce((s, f) => s + f.total_nodes, 0) / n;
  return {
    shape_category: shape,
    sample_count: n,
    mean_residual: mean,
    std_residual: std,
    effective_score: effective,
    avg_fan_out,
    avg_max_depth,
    avg_total_nodes,
    last_observed_ts: lastObservedTs,
  };
};

const upsertPredicateRow = (
  db: Database,
  metrics: ShapeMetrics,
): { id: string; created: boolean } => {
  const id = `decomp_${metrics.shape_category}`;
  const alpha = 1 + metrics.effective_score * metrics.sample_count;
  const beta = 1 + (1 - metrics.effective_score) * metrics.sample_count;
  const body = JSON.stringify({
    shape_category: metrics.shape_category,
    sample_count: metrics.sample_count,
    mean_residual: metrics.mean_residual,
    std_residual: metrics.std_residual,
    effective_score: metrics.effective_score,
    avg_fan_out: metrics.avg_fan_out,
    avg_max_depth: metrics.avg_max_depth,
    avg_total_nodes: metrics.avg_total_nodes,
    last_observed_ts: metrics.last_observed_ts,
  });
  const nowIso = new Date().toISOString();
  const existing = db
    .query("SELECT id FROM act_artifact WHERE id = ? LIMIT 1")
    .get(id) as { id: string } | null;
  if (existing) {
    db.run(
      `UPDATE act_artifact
         SET body = ?,
             posterior_alpha = ?,
             posterior_beta = ?,
             score = ?,
             confidence = ?,
             recent_residual_mean = ?,
             updated_at = ?
       WHERE id = ?`,
      [
        body,
        alpha,
        beta,
        metrics.effective_score,
        1 - 1 / Math.sqrt(alpha + beta),
        metrics.mean_residual,
        nowIso,
        id,
      ],
    );
    return { id, created: false };
  }
  const declaredSandbox = JSON.stringify({
    runtime: "bun",
    substrate_access: "ro",
    cpu_ms: 100,
    wall_ms: 1000,
    memory_mb: 8,
    fs_read: [],
    fs_write: [],
    net_allow: [],
    proc_allow: [],
  });
  db.run(
    `INSERT INTO act_artifact (
       id, runtime, body, declared_sandbox, state_root, kind,
       posterior_alpha, posterior_beta, score, confidence,
       recent_residual_mean, recent_kill_count, status, name,
       fixture_input, fixture_expected_residual,
       created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      "bun",
      body,
      declaredSandbox,
      `substrate/decomposition_strategy/${id}`,
      PREDICATE_KIND,
      alpha,
      beta,
      metrics.effective_score,
      1 - 1 / Math.sqrt(alpha + beta),
      metrics.mean_residual,
      0,
      "admitted",
      metrics.shape_category,
      JSON.stringify({ shape_category: metrics.shape_category }),
      0.5,
      nowIso,
      nowIso,
    ],
  );
  return { id, created: true };
};

/**
 * Scan completed directives (those with task_closure_audited) in a
 * bounded 30-day window, build per-directive DAG fingerprints, bucket
 * them by deterministic shape category, and admit/refresh one
 * act_artifact{kind:"decomposition_strategy_predicate"} row per shape
 * category that meets the 5-sample threshold.
 *
 * Directives without a task_closure_audited row are NOT scanned (the
 * SQL JOIN gates the scope — incomplete trajectories carry no truth
 * signal yet).
 */
export const extractDecompositionStrategy = async (
  db: Database,
  opts?: { maxDirectives?: number; windowDays?: number },
): Promise<DecompositionStrategySummary> => {
  const maxDirectives = Math.max(1, opts?.maxDirectives ?? DEFAULT_MAX_DIRECTIVES);
  const windowDays = Math.max(1, opts?.windowDays ?? DEFAULT_WINDOW_DAYS);
  const cutoff = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();

  const summary: DecompositionStrategySummary = {
    directives_scanned: 0,
    shapes_seen: 0,
    rows_admitted: 0,
    rows_updated: 0,
    skipped_below_threshold: 0,
  };

  // Pull the most-recent task_closure_audited per directive in the
  // window. A directive can be re-audited; we take the latest closure.
  const directives = db
    .query(
      `SELECT directive_id,
              MAX(ts)     AS closure_ts,
              payload     AS closure_payload
         FROM events
        WHERE kind = 'task_closure_audited'
          AND ts > ?
          AND directive_id IS NOT NULL
        GROUP BY directive_id
        ORDER BY closure_ts DESC
        LIMIT ?`,
    )
    .all(cutoff, maxDirectives) as DirectiveRow[];

  // Group fingerprints by shape category. Track the latest observed
  // closure_ts per shape so the predicate row's `last_observed_ts`
  // reflects when the substrate last saw evidence of this shape.
  const byShape = new Map<ShapeCategory, ShapeAggregate>();

  let processedSinceYield = 0;
  for (const dir of directives) {
    if (processedSinceYield >= YIELD_EVERY_N) {
      await yieldToEventLoop();
      processedSinceYield = 0;
    }
    processedSinceYield++;

    const closurePayload = parsePayload(dir.closure_payload);
    const closureResidual = numberOr(closurePayload.closure_residual, 1.0);

    const events = db
      .query(
        `SELECT id, task_id, parent_task_id, kind, payload
           FROM events
          WHERE directive_id = ?
            AND kind IN ('task_node_opened', 'task_edge_recorded')
          ORDER BY ts ASC, rowid ASC`,
      )
      .all(dir.directive_id) as DirectiveEventRow[];

    if (events.length === 0) continue;

    const fingerprint = buildFingerprint(
      dir.directive_id,
      dir.closure_ts,
      closureResidual,
      events,
    );

    if (fingerprint.total_nodes === 0) continue;
    summary.directives_scanned++;

    const entry = byShape.get(fingerprint.shape_category);
    if (entry) {
      entry.fingerprints.push(fingerprint);
      // closure_ts ordering is DESC in the outer query — the FIRST seen
      // fingerprint per shape carries the most-recent ts.
      // Keep the max defensively.
      if (fingerprint.closure_ts > entry.last_observed_ts) {
        entry.last_observed_ts = fingerprint.closure_ts;
      }
    } else {
      byShape.set(fingerprint.shape_category, {
        fingerprints: [fingerprint],
        last_observed_ts: fingerprint.closure_ts,
      });
    }
  }

  summary.shapes_seen = byShape.size;

  for (const [shape, agg] of byShape.entries()) {
    if (agg.fingerprints.length < MIN_SAMPLE_COUNT) {
      summary.skipped_below_threshold++;
      continue;
    }
    const metrics = computeMetrics(shape, agg.fingerprints, agg.last_observed_ts);
    const { id, created } = upsertPredicateRow(db, metrics);
    if (created) summary.rows_admitted++;
    else summary.rows_updated++;

    emitEvent(db, {
      kind: "decomposition_strategy_observed",
      substrate_origin: "substrate_auto",
      context_refs: [id],
      payload: {
        shape_category: shape,
        predicate_act_artifact_id: id,
        sample_count: metrics.sample_count,
        mean_residual: metrics.mean_residual,
        std_residual: metrics.std_residual,
        effective_score: metrics.effective_score,
        avg_fan_out: metrics.avg_fan_out,
        avg_max_depth: metrics.avg_max_depth,
        avg_total_nodes: metrics.avg_total_nodes,
        last_observed_ts: metrics.last_observed_ts,
        created,
      },
    });
  }

  return summary;
};
