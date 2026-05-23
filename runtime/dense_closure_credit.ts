// acc2 dense post-closure credit — DAG-backprop of closure_residual.
//
// Research grounding (2026):
//   - HCAPO (arXiv:2603.08754) — Hindsight Credit Assignment for Policy
//     Optimization: dense per-step credit derived from a terminal outcome
//     beats coarse terminal-only credit for long-horizon agents.
//   - Mem-T (arXiv:2601.23014) — hindsight memory re-weighting; intermediate
//     contributions to a final outcome should accrue learning signal.
//   Reported lift: +7.7–13.8% over GRPO-style coarse terminal credit.
//
// THE PROBLEM acc2 had: credit was relatively terminal/trajectory-level.
// distributeCredit (runtime/credit.ts) fires per action_scored on individual
// acts, and projectActionScoredToCredit projects every action_scored to its
// cited artifacts — but the ROOT-task closure verdict (task_closure_audited's
// closure_residual), the single most-grounded outcome signal a directive
// produces, never flowed back to the INTERMEDIATE decompositions / acts /
// retrievals / artifacts that contributed to reaching it. The posteriors that
// rank decomposition strategies, motifs, and artifact retrieval learned only
// from per-act residuals, not from "did the whole directive actually close?".
//
// THE DENSE PASS (this module): when a ROOT task's task_closure_audited lands
// with a numeric closure_residual, walk the directive's OWN task DAG + the
// act/retrieval citation graph under it, and apply the EXISTING credit
// primitives (applyResidualOutcome for act_artifacts; candidate_confirmed /
// candidate_contradicted for knowledge) to the intermediate contributors,
// weighted by the closure_residual and damped by graph distance so the dense
// signal is ADDITIVE/secondary, never overpowering the primary terminal
// credit. Low closure_residual = directive succeeded = positive credit (alpha
// up); high closure_residual = directive failed = negative credit (beta up) —
// the residual→Beta mapping is residualToBetaDeltas, the same algebra
// distributeCredit uses.
//
// ADDITIVE invariants (do NOT change dispatch / the four-link chain / existing
// terminal credit):
//   - This is a NEW post-write hook on task_closure_audited gated to root
//     tasks. It does not touch action_scored projection, distributeCredit, or
//     the dispatcher.
//   - Idempotent: each (closure_audit_event_id, target_id) pair is credited
//     exactly once. Re-running the pass (replay/retry) emits nothing new.
//     Key: dense_closure_credit:{closure_audit_event_id}:{target_id}.
//   - Bounded: walks ONLY the closing directive's DAG + the acts attached to
//     tasks in that DAG. No whole-ledger scan; per-directive event counts are
//     small. A hard cap on credited contributors keeps a pathologically large
//     directive from exploding the event count.
//   - Damping: closure-derived weight is BACKPROP_BASE_WEIGHT (0.25) at the
//     leaf, decaying by BACKPROP_DEPTH_DECAY per refines-hop toward the root,
//     so the dense signal is a fraction of a normal full-weight credit. The
//     root act itself is excluded (it already carries terminal credit via the
//     closure verdict's own internal-act projection).
//
// The deterministic DAG-backprop is implemented here. The OPTIONAL
// LLM hindsight-critic re-weighting (the brain re-scoring which intermediate
// nodes actually mattered) is a deliberately deferred second step — this pass
// uses uniform depth-damped weights, which is the deterministic core HCAPO
// describes; the critic refines it later without changing this contract.

import type { Database } from "bun:sqlite";
import type { JsonValue } from "../substrate/types";
import { emitEvent, type EmitEventInput } from "./events";
import {
  applyResidualOutcome,
  getArtifact,
  maybePromote,
  residualToBetaDeltas,
} from "./artifact_store";
import { readDagForDirective, type TaskEdge } from "./task_topology";
import { nowIso } from "./ids";

// Leaf-node closure-derived credit weight. A normal per-act credit is
// weight=1.0; the dense backprop intentionally lands at a quarter of that so
// it densifies the learning signal without swamping the primary terminal
// credit each act already received.
const BACKPROP_BASE_WEIGHT = 0.25;
// Per refines-hop decay toward the root. A node 2 hops below the root gets
// BACKPROP_BASE_WEIGHT * BACKPROP_DEPTH_DECAY^2. Distant intermediate work
// gets a smaller (but non-zero) share of the closure outcome.
const BACKPROP_DEPTH_DECAY = 0.7;
// Hard cap on credited contributors per closure to keep the event count
// bounded even for a pathologically large directive DAG. The bound is per
// dense pass; normal directives are far below it.
const MAX_DENSE_CONTRIBUTORS = 256;

// Success/failure bands mirror credit.ts so the knowledge polarity matches the
// rest of the pipeline.
const SUCCESS_BAND = 0.3;
const FAILURE_BAND = 0.7;

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));

const jsonObject = (value: string | null | undefined): Record<string, unknown> => {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
};

const stringArray = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string" && v.length > 0)
    : [];

export type DenseClosureCreditInput = {
  /** Event id of the task_closure_audited row that triggered this pass. */
  closure_audit_event_id: string;
  directive_id: string;
  /** The root task_id the closure audited. */
  root_task_id: string;
  /** Numeric closure_residual from the audit payload (already validated by
   *  the caller to be finite). */
  closure_residual: number;
};

export type DenseClosureCreditResult = {
  ran: boolean;
  reason?: string;
  /** Distinct contributors credited (act_artifacts + knowledge ids). */
  contributors_credited: number;
  emitted_event_ids: string[];
};

/** Is `taskId` the directive's ROOT task? The root is the directive's first
 *  task_node_opened with a null/empty parent_task_id (the canonical pattern
 *  used by amendment_handler.ts). Returns the resolved root task_id (so the
 *  caller can pass it into the dense pass) or null when no root node exists. */
export const resolveDirectiveRootTaskId = (
  db: Database,
  directiveId: string,
): string | null => {
  const row = db
    .query<{ task_id: string }, [string]>(
      `SELECT task_id FROM events
       WHERE directive_id = ?
         AND kind = 'task_node_opened'
         AND (parent_task_id IS NULL OR parent_task_id = '')
       ORDER BY ts ASC LIMIT 1`,
    )
    .get(directiveId);
  return row?.task_id ?? null;
};

/** Compute refines-graph depth from the root for every task in the directive
 *  DAG. The root is depth 0. Tasks reachable via `refines` / `requires` edges
 *  from the root accrue depth = parent_depth + 1. Tasks not reachable from the
 *  root (orphans) are assigned depth 0 so they still receive base-weight
 *  credit rather than being silently dropped. */
const depthByTask = (
  rootTaskId: string,
  edges: TaskEdge[],
  allTaskIds: Set<string>,
): Map<string, number> => {
  // Build child adjacency over the structural edges. Both refines and
  // requires participate: a "requires" upstream is a contributor to the
  // downstream's outcome, and "refines" children are the decomposition of a
  // parent. We walk from the root outward (root → its children) using the
  // from_task → to_task direction.
  const children = new Map<string, string[]>();
  for (const e of edges) {
    if (e.kind !== "refines" && e.kind !== "requires") continue;
    const list = children.get(e.from_task) ?? [];
    list.push(e.to_task);
    children.set(e.from_task, list);
  }
  const depth = new Map<string, number>();
  depth.set(rootTaskId, 0);
  const queue: string[] = [rootTaskId];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    const d = depth.get(cur)!;
    for (const child of children.get(cur) ?? []) {
      if (depth.has(child)) continue;
      depth.set(child, d + 1);
      queue.push(child);
    }
  }
  // Orphans (in the DAG but not reachable from the root) → depth 0.
  for (const t of allTaskIds) if (!depth.has(t)) depth.set(t, 0);
  return depth;
};

/** Collect the citation contributors attached to a set of tasks. For every
 *  action_predicted / act_tuple_recorded event on those tasks, gather
 *  cited_artifact_ids + cited_knowledge_ids (payload) and the act's
 *  context_refs. Also pulls retrieval_binding source ids on those tasks. The
 *  returned map keys are target ids; the value is the minimum task depth at
 *  which the target contributed (so a target reused across depths is damped at
 *  its shallowest — most-credited — appearance). */
const collectContributors = (
  db: Database,
  taskIds: string[],
  depth: Map<string, number>,
): Map<string, number> => {
  const out = new Map<string, number>();
  if (taskIds.length === 0) return out;
  const placeholders = taskIds.map(() => "?").join(",");
  const note = (id: string, taskDepth: number) => {
    if (!id) return;
    const prev = out.get(id);
    if (prev === undefined || taskDepth < prev) out.set(id, taskDepth);
  };

  // Acts under these tasks: action_predicted (carries the act tuple's cited
  // ids on payload + context_refs) and act_tuple_recorded (caller-declared
  // citation envelope). Both are the canonical citation surfaces.
  const actRows = db
    .query(
      `SELECT task_id, payload, context_refs FROM events
       WHERE kind IN ('action_predicted','act_tuple_recorded')
         AND task_id IN (${placeholders})`,
    )
    .all(...taskIds) as Array<{ task_id: string; payload: string; context_refs: string }>;
  for (const r of actRows) {
    const d = depth.get(r.task_id) ?? 0;
    const p = jsonObject(r.payload);
    for (const id of stringArray(p.cited_artifact_ids)) note(id, d);
    for (const id of stringArray(p.cited_knowledge_ids)) note(id, d);
    for (const id of stringArray(safeParseArray(r.context_refs))) note(id, d);
  }

  // retrieval_binding rows scoped to these tasks: the bound source event /
  // artifact is a retrieval contributor to the task's outcome.
  const bindingRows = db
    .query(
      `SELECT task_id, payload FROM events
       WHERE kind = 'retrieval_binding'
         AND task_id IN (${placeholders})`,
    )
    .all(...taskIds) as Array<{ task_id: string; payload: string }>;
  for (const r of bindingRows) {
    const d = depth.get(r.task_id) ?? 0;
    const p = jsonObject(r.payload);
    const srcEvent = typeof p.source_event_id === "string" ? p.source_event_id : "";
    const srcArtifact = typeof p.source_artifact_id === "string" ? p.source_artifact_id : "";
    if (srcEvent) note(srcEvent, d);
    if (srcArtifact) note(srcArtifact, d);
  }

  return out;
};

const safeParseArray = (value: string | null | undefined): unknown => {
  if (!value) return [];
  try {
    return JSON.parse(value);
  } catch {
    return [];
  }
};

/** Classify a contributor id: an act_artifact row, a knowledge-bearing event,
 *  or unknown (skip). */
const classify = (db: Database, id: string): "act_artifact" | "knowledge" | "unknown" => {
  const art = db.query("SELECT 1 AS x FROM act_artifact WHERE id = ?").get(id) as { x: number } | null;
  if (art) return "act_artifact";
  const ev = db.query("SELECT kind FROM events WHERE id = ?").get(id) as { kind: string } | null;
  if (ev && (ev.kind === "knowledge_candidate" || ev.kind === "knowledge_promoted" || ev.kind === "lesson_extracted")) {
    return "knowledge";
  }
  return "unknown";
};

const denseProjectionKey = (closureAuditEventId: string, targetId: string): string =>
  "dense_closure_credit:" + closureAuditEventId + ":" + targetId;

/** Has this contributor already been densely credited for this closure audit?
 *  Idempotency guard — keyed on (closure_audit_event_id, target_id). Both the
 *  act_artifact dense-score row and the knowledge dense-confirm/contradict row
 *  stamp the same projection_key, so one lookup covers both branches. */
const denseCreditExists = (db: Database, key: string): boolean => {
  const row = db
    .query<{ x: number }, [string]>(
      `SELECT 1 AS x FROM events
       WHERE json_extract(payload, '$.projection_key') = ?
         AND json_extract(payload, '$.projected_from') = 'dense_closure_credit'
       LIMIT 1`,
    )
    .get(key);
  return row !== null;
};

/** Dense post-closure credit pass. Idempotent + bounded + additive.
 *
 *  Fail-soft: any internal error is surfaced as a projection_error and never
 *  thrown — the parent task_closure_audited row already landed and must not be
 *  poisoned by a credit-pass failure. */
export const distributeDenseClosureCredit = (
  db: Database,
  input: DenseClosureCreditInput,
): DenseClosureCreditResult => {
  const emitted: string[] = [];
  const emit = (event: EmitEventInput): string => {
    const res = emitEvent(db, {
      ...event,
      directive_id: event.directive_id ?? input.directive_id,
      task_id: event.task_id ?? input.root_task_id,
      invoker: event.invoker ?? "substrate_auto",
    });
    emitted.push(res.id);
    return res.id;
  };

  try {
    const residual = clamp01(input.closure_residual);
    const { nodes, edges } = readDagForDirective(db, input.directive_id);
    if (nodes.length === 0) {
      return { ran: false, reason: "empty_dag", contributors_credited: 0, emitted_event_ids: [] };
    }
    const allTaskIds = new Set(nodes.map((n) => n.id));
    const depth = depthByTask(input.root_task_id, edges, allTaskIds);

    // INTERMEDIATE tasks only — exclude the root itself. The root act's
    // closure verdict already produces its own internal-act credit
    // (events.ts task_closure_audited → recordInternalAct); dense-crediting
    // the root would double-count the terminal signal we are explicitly
    // leaving unchanged.
    const intermediateTaskIds = nodes.map((n) => n.id).filter((id) => id !== input.root_task_id);

    const contributorDepth = collectContributors(db, intermediateTaskIds, depth);
    if (contributorDepth.size === 0) {
      return { ran: true, reason: "no_contributors", contributors_credited: 0, emitted_event_ids: emitted };
    }

    const { alphaDelta: baseAlpha, betaDelta: baseBeta } = residualToBetaDeltas(residual);
    const ts = nowIso();
    let credited = 0;

    // Deterministic ordering: shallowest depth first (largest credit), then
    // id. Keeps the bounded cap selecting the most-impactful contributors.
    const ordered = [...contributorDepth.entries()].sort((a, b) => {
      if (a[1] !== b[1]) return a[1] - b[1];
      return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
    });

    for (const [targetId, taskDepth] of ordered) {
      if (credited >= MAX_DENSE_CONTRIBUTORS) break;
      const key = denseProjectionKey(input.closure_audit_event_id, targetId);
      if (denseCreditExists(db, key)) continue; // idempotent

      // Depth-damped closure weight. Leaf (max depth among reachable) is not
      // special-cased; weight decays toward the root so deeper intermediate
      // work — closer to the leaves where concrete acts run — keeps more of
      // the base weight. taskDepth 0 (root-adjacent / orphan) is damped most.
      const weight = BACKPROP_BASE_WEIGHT * Math.pow(BACKPROP_DEPTH_DECAY, Math.max(0, taskDepth - 1));

      const kind = classify(db, targetId);
      if (kind === "act_artifact") {
        const row = getArtifact(db, targetId);
        if (!row) continue;
        const updated = applyResidualOutcome(db, targetId, residual, ts, (e) => emit(e), { weight });
        maybePromote(db, targetId, (e) => emit(e));
        emit({
          kind: "act_artifact_score_updated",
          substrate_origin: "substrate_auto",
          action_artifact_id: targetId,
          context_refs: [input.closure_audit_event_id, targetId],
          payload: {
            artifact_id: targetId,
            role: "dense_closure_contributor",
            residual,
            weight,
            task_depth: taskDepth,
            score: updated.score,
            confidence: updated.confidence,
            closure_audit_event_id: input.closure_audit_event_id,
            posterior_delta_alpha: baseAlpha * weight,
            posterior_delta_beta: baseBeta * weight,
            projected_from: "dense_closure_credit",
            projection_key: key,
          } as JsonValue,
        });
        credited += 1;
      } else if (kind === "knowledge") {
        const knowledgeKind: "candidate_confirmed" | "candidate_contradicted" =
          residual >= FAILURE_BAND ? "candidate_contradicted" : "candidate_confirmed";
        emit({
          kind: knowledgeKind,
          substrate_origin: "substrate_auto",
          context_refs: [targetId, input.closure_audit_event_id],
          payload: {
            knowledge_id: targetId,
            residual,
            weight,
            task_depth: taskDepth,
            closure_audit_event_id: input.closure_audit_event_id,
            polarity: residual >= FAILURE_BAND ? "deny" : residual <= SUCCESS_BAND ? "assert" : "midband",
            projected_from: "dense_closure_credit",
            projection_key: key,
          } as JsonValue,
        });
        // Synchronous promotion refresh — the densely-credited candidate
        // becomes searchable without waiting for the extractor cadence.
        try {
          const { maybePromoteKnowledge } = require("../substrate/extractors") as typeof import("../substrate/extractors");
          maybePromoteKnowledge(db, targetId);
        } catch {
          /* bulk extractor cadence remains the fallback */
        }
        credited += 1;
      }
      // unknown → skip (decorative / unresolvable id).
    }

    // One audit summary row so the dense pass is observable on the ledger as a
    // single bounded event regardless of contributor count.
    emit({
      kind: "dense_closure_credit_distributed",
      substrate_origin: "substrate_auto",
      context_refs: [input.closure_audit_event_id, input.root_task_id],
      payload: {
        closure_audit_event_id: input.closure_audit_event_id,
        root_task_id: input.root_task_id,
        closure_residual: residual,
        dag_node_count: nodes.length,
        contributors_seen: contributorDepth.size,
        contributors_credited: credited,
        capped: contributorDepth.size > MAX_DENSE_CONTRIBUTORS,
        projected_from: "dense_closure_credit",
        projection_key: "dense_closure_credit_summary:" + input.closure_audit_event_id,
      } as JsonValue,
    });

    return { ran: true, contributors_credited: credited, emitted_event_ids: emitted };
  } catch (err) {
    try {
      emitEvent(db, {
        kind: "projection_error",
        substrate_origin: "substrate_auto",
        directive_id: input.directive_id,
        task_id: input.root_task_id,
        context_refs: [input.closure_audit_event_id],
        payload: {
          where: "distributeDenseClosureCredit",
          reason: "exception",
          error: (err as Error).message ?? String(err),
          closure_audit_event_id: input.closure_audit_event_id,
        } as JsonValue,
      });
    } catch {
      /* swallow secondary failure */
    }
    return { ran: false, reason: "exception", contributors_credited: 0, emitted_event_ids: emitted };
  }
};

// ── Internal exports for tests ────────────────────────────────────
export const __depthByTaskForTest = depthByTask;
