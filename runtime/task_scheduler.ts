// acc2 task scheduler — picks ready tasks and dispatches them
// (Architecture.md).
//
// Phase E lights up real parallelism:
//   - Up to maxConcurrent dispatches per tick (default 5, configurable up to
//     10 in crisis mode).
//   - Tracks in-flight dispatches via an in-memory map keyed by task_id so
//     successive ticks know how many slots are free.
//   - Routes through decideDispatch:
//       substrate_replay → dispatchReadyTask (which calls replayRecipe from
//                          runtime/recipe_replay.ts — real Tier-0 replay).
//       claude_inline    → emit `claude_inline_lane_routed` event; main
//                          Claude reads the event stream and runs inline.
//                          Scheduler does NOT dispatch from this lane.
//       opencode_brain   → dispatchReadyTask (Phase D dispatcher).
//   - Concurrent dispatches run via Promise.all with per-dispatch error
//     isolation (a failed dispatch must not crash the tick).
//   - schedulerLoop is a setInterval-style loop suitable for the daemon to
//     run continuously; honors a stop signal via AbortController.
//
// The scheduler's in-flight registry is process-local. Multi-process daemons
// would need a SQLite-backed lease table — Phase G+ adds that when uv /
// camofox runtimes show up.

import type { Database } from "bun:sqlite";
import type { JsonValue } from "../substrate/types";
import { readDagForDirective, readyTasks, type TaskNode } from "./task_topology";
import { dispatchReadyTask } from "./task_dispatcher";
import { hasFreeHandshakePermit, freeHandshakePermits, observedBrainRssBytes } from "./bridge/opencode";
import { decideDispatch, dispatchEvidencePayload } from "./dispatch_decider";
import { emitEvent } from "./events";
import { newId } from "./ids";
import { readCurrentMode, applyModeAdjustments } from "./crisis_mode";
import { findDeferringConflict } from "./interference";
import { isBridgeHealthDegraded } from "./bridge_health";
import { claimDispatchLease, releaseDispatchLease } from "./dispatch_leases";
import { getBootSessionToken } from "./brain_dispatch_reconciler";

// Interaction kinds that block another directive's dispatch when one of the
// two is mid-flight. `mutual_exclusion` is symmetric (either side blocks the
// other while in flight); `resource_conflict` denotes a shared exhaustible
// resource (attention, calendar slot, budget) — concurrent dispatch is
// permitted to be down-ranked rather than refused, but Father-style ranking
// uses the same set. The set is exported so Phase DAG callers and Father's
// selector reference the same canonical taxonomy.
export const CROSS_DIRECTIVE_BLOCKING_INTERACTIONS: ReadonlySet<string> = new Set([
  "mutual_exclusion",
  "resource_conflict",
]);

export type SchedulerOpts = {
  maxConcurrent?: number;
  pollIntervalMs?: number;
  directiveId?: string;
  fixtureTargetPath?: string;
  /** EmbeddingIndex threaded through to dispatchReadyTask so depth-1
   *  retrieval can fire before composePrompt. Without this the brain
   *  prompt's KNOWLEDGE section is always built from recency, not the
   *  cosine × posterior reranker. Knowledge audit bc5vdkrik #1. */
  index?: import("./embedding_index").EmbeddingIndex;
  /** Multi-goal alignment (2026-05-15): per-directive in-flight cap so
   *  one runaway goal cannot consume every scheduler slot and starve
   *  parallel goals. Defaults to ceil(maxConcurrent / 2) — at most half
   *  of the global slots can belong to a single directive at any time. */
  maxConcurrentPerDirective?: number;
};

export type SchedulerTick = {
  dispatched: string[];
  in_flight: string[];
  skipped_concurrency_cap: string[];
  skipped_recipe: string[];
  skipped_inline: string[];
  skipped_blocked: string[];
  /** Tasks not admitted because the daemon is in graceful restart drain. */
  skipped_draining: string[];
  /** Tasks deferred because a `mutual_exclusion` or `resource_conflict`
   *  interference edge points at an in-flight peer directive. The scheduler
   *  emits `task_deferred_for_interference` for each entry here. */
  skipped_interference: string[];
  /** Tasks the scheduler quarantined because they hit
   *  `MAX_CONSECUTIVE_BRIDGE_FAILURES` in a row with no successful
   *  interleaving event. Each entry corresponds to a `task_failed` row with
   *  `failure_kind: "consecutive_bridge_failures"`. */
  skipped_failure_capped: string[];
};

const DEFAULT_MAX_CONCURRENT = 5;
const DEFAULT_POLL_INTERVAL_MS = 500;

/** OOM defence: opencode subprocesses run gpt-5.5 and consume ~1-2GB RAM
 *  each. Four parallel brain dispatches on an 8GB host trigger the OS
 *  OOM-killer (exit 137 SIGKILL) — observed 2026-05-15 during a 4-way
 *  parallel orchestrator dispatch. The cap is computed DYNAMICALLY from
 *  available host RAM at dispatch time so the same daemon runs sensibly
 *  on a 4GB laptop (cap=1), an 8GB workstation (cap=2-3), and a 32GB
 *  workhorse (cap=10+) WITHOUT operator tuning. No env knob — matches
 *  the "no new env vars" operating rule and the user's directive that
 *  the system should self-determine brain parallelism. */
// Per-opencode-subprocess RAM budget. Empirical observation 2026-05-16:
// 3 live opencode subprocesses doing real brain cycles each held ~340MB RSS
// (`ps -eo pid,rss,comm | grep opencode` during a parallel-dispatch ant
// audit). The previous 1.8GB constant was ~6× over-provisioned, which
// caused brain_in_flight_at_cap saturation cascades (≥130 rejections in
// 2min) whenever the operator dispatched ≥4 parallel `acc task`
// directives. 700MB sits comfortably above observed peak with headroom
// for prompt-context growth + bridge buffers, and lets a 16GB host run
// ~8 concurrent brains instead of 3. Single universal value — no env
// override; the universal workflow stays one path.
const BRAIN_PROCESS_RAM_BYTES = 700_000_000;
const HOST_RAM_RESERVE_BYTES = 2_000_000_000;  // ~2GB kept for OS + bun + tests
const PROMPT_COMPOSITION_HEADROOM_BYTES = 150_000_000;
const DAEMON_RSS_PRESSURE_BYTES = 1_200_000_000;

export type DaemonHeapPressureState = {
  rss_bytes: number;
  heap_used_bytes: number;
  rss_pressure_threshold_bytes: number;
  under_pressure: boolean;
};

const readDaemonMemoryUsage = (): { rss_bytes: number; heap_used_bytes: number } => {
  try {
    const usage = process.memoryUsage();
    return {
      rss_bytes: Number.isFinite(usage.rss) ? Math.max(0, Math.floor(usage.rss)) : 0,
      heap_used_bytes: Number.isFinite(usage.heapUsed) ? Math.max(0, Math.floor(usage.heapUsed)) : 0,
    };
  } catch {
    return { rss_bytes: 0, heap_used_bytes: 0 };
  }
};

export const computeDaemonHeapPressureState = (): DaemonHeapPressureState => {
  const usage = readDaemonMemoryUsage();
  return {
    ...usage,
    rss_pressure_threshold_bytes: DAEMON_RSS_PRESSURE_BYTES,
    under_pressure: usage.rss_bytes >= DAEMON_RSS_PRESSURE_BYTES,
  };
};

/** Compute the brain-dispatch cap from live host memory. We use the
 *  *less* of available-free and the conservative free-from-total
 *  estimate to avoid optimism when the OS reports stale "free" while
 *  the page cache is hot. Floor of 1 — we never block dispatch entirely
 *  even on a tiny host; heap pressure is handled by a separate scheduler
 *  admission gate so existing in-flight work can settle gracefully. */
export const computeBrainDispatchCap = (): number => {
  let totalBytes = 0;
  let freeBytes = 0;
  try {
    // Use require-like indirection so the field is read at call time, not
    // module load time — important for tests that mock process.memoryUsage.
    const os = require("node:os") as typeof import("node:os");
    totalBytes = os.totalmem();
    freeBytes = os.freemem();
  } catch {
    return 2; // os module shouldn't fail; conservative default if it does.
  }
  const daemonHeap = computeDaemonHeapPressureState();
  const hostUsableBytes = Math.max(0, Math.min(freeBytes, totalBytes - HOST_RAM_RESERVE_BYTES));
  const usableBytes = Math.max(0, hostUsableBytes - daemonHeap.rss_bytes);
  // RSS-calibrated per-brain estimate: take the GREATER of the fixed default
  // and 1.2× the observed peak brain RSS. This can ONLY raise the estimate
  // (→ fewer concurrent brains) when brains run heavier than 700MB — OOM
  // protection — and never lowers it below the default, so calibration is
  // safe-by-construction (admission only becomes more conservative, never
  // riskier). Falls back to the fixed default when no live RSS observation.
  const observedRss = observedBrainRssBytes();
  const brainProcessBytes = observedRss && observedRss > 0
    ? Math.max(BRAIN_PROCESS_RAM_BYTES, Math.floor(observedRss * 1.2))
    : BRAIN_PROCESS_RAM_BYTES;
  const perBrainBytes = brainProcessBytes + PROMPT_COMPOSITION_HEADROOM_BYTES;
  const cap = Math.floor(usableBytes / perBrainBytes);
  return Math.max(1, cap);
};

/** Track in-flight opencode_brain dispatches separately so the brain cap
 *  is enforced independently of the global cap. Same lifecycle as
 *  IN_FLIGHT — entries inserted at dispatch, deleted on promise
 *  resolution / rejection / catch. */
const IN_FLIGHT_BRAIN: Set<string> = new Set();

/** (task_id, gate_name) pairs that have already emitted a
 *  constitutional_gate_decision in the current queueing cycle. Without this
 *  dedupe the scheduler tick (every 500ms) would re-emit gate events for
 *  every ready task on every tick while a gate stays closed, flooding the
 *  SQLite write queue (~340 events / 10min observed 2026-05-16 across
 *  brain_concurrency_cap + bridge_health_degraded gates, which throttled
 *  FastMCP request handling and made substrate.open_directive time out).
 *  Entries cleared when the corresponding task settles OR when ALL brain
 *  slots open (signal a fresh cycle). Tests call _resetSchedulerForTests. */
const GATE_NOTIFIED: Set<string> = new Set();
const gateKey = (taskId: string, gate: string): string => `${taskId}:${gate}`;

/** Holder identity for the durable dispatch lease. Prefers the daemon's
 *  minted boot session token (so a multi-daemon audit can attribute a lease
 *  to its owning process); falls back to a stable process-local token when
 *  no daemon booted (tests / direct scheduler use). Equality of this string
 *  is the cross-process ownership signal — same holder may re-claim/renew. */
const PROCESS_LOCAL_HOLDER = `sched-${process.pid}-${Date.now()}`;
const leaseHolder = (): string => getBootSessionToken() ?? PROCESS_LOCAL_HOLDER;

const clearInFlightTask = (taskId: string, db?: Database): void => {
  IN_FLIGHT.delete(taskId);
  IN_FLIGHT_DIRECTIVE.delete(taskId);
  IN_FLIGHT_PARENT.delete(taskId);
  IN_FLIGHT_BRAIN.delete(taskId);
  // Release the durable cross-process lease on completion. Idempotent: a
  // DELETE of an absent row is a no-op, and a release for a task this
  // process never leased (db absent, or lease-write failed at claim) is
  // harmless. Never throws into the dispatch lifecycle.
  if (db) releaseDispatchLease(db, taskId);
  GATE_NOTIFIED.delete(gateKey(taskId, "brain_concurrency_cap"));
  GATE_NOTIFIED.delete(gateKey(taskId, "bridge_health_degraded"));
  if (IN_FLIGHT_BRAIN.size === 0) GATE_NOTIFIED.clear();
};

/** Max consecutive `bridge_failed` events for a single task before the
 *  scheduler quarantines it with `task_failed { failure_kind:
 *  "consecutive_bridge_failures" }`. Without this cap, a structural issue
 *  (mcp_server_url_missing, brain_silent_exit, mcp_handshake_timed_out, auth_missing) causes the
 *  scheduler to hot-loop the same task forever — every 500ms tick re-picks
 *  the same task because `readyTasks` only filters by committed/failed and
 *  no `task_failed` is ever emitted for bridge-level failures. The cap is
 *  generous enough to absorb transient network blips (default 3) but tight
 *  enough that an operator notices fast. */
export const MAX_CONSECUTIVE_BRIDGE_FAILURES = 3;

/** Count consecutive `bridge_failed` events for a task with no intervening
 *  successful frame (`action_predicted`, `bridge_mcp_connected`, or
 *  `task_committed`). Returns the run-length of the most recent failure
 *  streak. */
const consecutiveBridgeFailureEvidence = (db: Database, taskId: string): Array<{ id: string; reason: string | null; ts: string }> => {
  const rows = db
    .query(
      `SELECT id, kind, ts, payload FROM events
       WHERE task_id = ?
         AND kind IN ('bridge_failed','action_predicted','bridge_mcp_connected','task_committed')
       ORDER BY ts DESC, rowid DESC LIMIT 50`,
    )
    .all(taskId) as Array<{ id: string; kind: string; ts: string; payload: string }>;
  const out: Array<{ id: string; reason: string | null; ts: string }> = [];
  for (const r of rows) {
    if (r.kind !== "bridge_failed") break;
    let reason: string | null = null;
    try {
      const payload = JSON.parse(r.payload ?? "{}") as Record<string, unknown>;
      reason = typeof payload.reason === "string" ? payload.reason : null;
    } catch { /* malformed payload: evidence id is still useful */ }
    out.push({ id: r.id, reason, ts: r.ts });
  }
  return out;
};

const consecutiveBridgeFailures = (db: Database, taskId: string): number =>
  consecutiveBridgeFailureEvidence(db, taskId).length;

/** Bridge-failure reasons that indicate the BRAIN itself failed to make
 *  progress (vs a transient transport issue). These failures are
 *  DETERMINISTIC: the brain will fail the same way on the same task again.
 *  Re-dispatching wastes 5+ minutes of brain-slot time per attempt.
 *  Foundational audit 2026-05-17: ledger evidence showed CHRZM6VX4H7YVF7D
 *  silent-failing 5 times in a row (each a 5-min watchdog kill) while
 *  never accumulating 3 CONSECUTIVE generic failures (other tasks landed
 *  in between). The generic cap (3) is right for transport hiccups; this
 *  tighter cap (1) is right for silent failures which are deterministic.
 *  After ONE silent-class failure, the task is quarantined with
 *  `failure_kind: "silent_dispatch_quarantine"` — operator may re-open via
 *  a fresh task_id once the underlying compatibility issue is resolved. */
// Silent-class failure reasons split by determinism (2026-05-20 Cause 2 fix):
// - DETERMINISTIC: same task + same brain → same failure. Tight cap protects
//   compute. brain_silent_exit means brain reasoned but emitted zero MCP
//   calls; subprocess_stuck means the subprocess wedged. Both reproduce.
// - TRANSIENT: handshake timeouts under concurrent opencode spawns or slow
//   boot are observably transient — fresh task_ids succeed, the same task_id
//   may also succeed after the concurrent contention clears. Wider cap lets
//   the substrate retry without permanent quarantine.
const DETERMINISTIC_SILENT_REASONS: ReadonlySet<string> = new Set([
  "brain_silent_exit",
  "subprocess_stuck",
]);

const TRANSIENT_SILENT_REASONS: ReadonlySet<string> = new Set([
  "mcp_handshake_timed_out",
]);

const SILENT_DISPATCH_REASONS: ReadonlySet<string> = new Set([
  ...DETERMINISTIC_SILENT_REASONS,
  ...TRANSIENT_SILENT_REASONS,
]);

const MAX_DETERMINISTIC_SILENT_FAILURES = 1;
const MAX_TRANSIENT_SILENT_FAILURES = 3;

/** Count silent-class bridge_failed events for a task (irrespective of
 *  whether they're consecutive). A task that silent-failed even ONCE in
 *  the deterministic class has proven brain-incompatible for this dispatch
 *  shape; further attempts on the same task waste compute. Transient-class
 *  failures (mcp_handshake_timed_out from concurrent boot races) tolerate
 *  more retries since fresh attempts may succeed when contention clears. */
const silentDispatchFailureEvidence = (
  db: Database,
  taskId: string,
): Array<{ id: string; reason: string; ts: string }> => {
  const rows = db
    .query(
      `SELECT id, ts, payload FROM events
       WHERE task_id = ?
         AND kind = 'bridge_failed'
       ORDER BY ts ASC`,
    )
    .all(taskId) as Array<{ id: string; ts: string; payload: string }>;
  const out: Array<{ id: string; reason: string; ts: string }> = [];
  for (const r of rows) {
    let reason: string | null = null;
    try {
      const payload = JSON.parse(r.payload ?? "{}") as Record<string, unknown>;
      reason = typeof payload.reason === "string" ? payload.reason : null;
    } catch { /* skip malformed */ }
    if (reason && SILENT_DISPATCH_REASONS.has(reason)) {
      out.push({ id: r.id, reason, ts: r.ts });
    }
  }
  return out;
};

// Process-local in-flight registry. The scheduler is the only writer; the
// dispatcher promises resolve here. Keys are task_ids; values are the
// underlying promise so the loop can await any completion when needed.
const IN_FLIGHT: Map<string, Promise<unknown>> = new Map();

// Companion map: task_id → directive_id so the scheduler can compute the set
// of in-flight directives without re-reading SQLite. Kept in sync with
// IN_FLIGHT (same insertion / deletion sites). Used for the interference
// concurrency check (`findDeferringConflict`).
const IN_FLIGHT_DIRECTIVE: Map<string, string> = new Map();
const IN_FLIGHT_PARENT: Map<string, string | null> = new Map();
let SCHEDULER_DRAINING = false;

/** Fence scheduler admission during daemon restart drain. Existing dispatches
 *  keep running; new ready tasks stay ready and are picked up by the next
 *  daemon generation after boot recovery reconciles any unclosed leases. */
export const setSchedulerDraining = (draining: boolean): void => {
  SCHEDULER_DRAINING = draining;
};

export const isSchedulerDraining = (): boolean => SCHEDULER_DRAINING;

export const inFlightDispatchTaskIds = (): string[] => Array.from(IN_FLIGHT.keys());

const refinementParent = (db: Database, task: TaskNode): string | null => {
  if (task.parent_id) return task.parent_id;
  const { edges } = readDagForDirective(db, task.directive_id);
  const refine = edges.find((e) => e.kind === "refines" && e.to_task === task.id);
  return refine?.from_task ?? null;
};

const hasRequiresEdgeBetween = (db: Database, directiveId: string, a: string, b: string): boolean => {
  const { edges } = readDagForDirective(db, directiveId);
  return edges.some((e) => e.kind === "requires" && ((e.from_task === a && e.to_task === b) || (e.from_task === b && e.to_task === a)));
};

const hasParallelSiblingSlot = (db: Database, task: TaskNode): boolean => {
  const parent = refinementParent(db, task);
  if (!parent) return false;
  for (const [inFlightTaskId, inFlightParent] of IN_FLIGHT_PARENT.entries()) {
    if (inFlightParent !== parent) continue;
    if (hasRequiresEdgeBetween(db, task.directive_id, task.id, inFlightTaskId)) continue;
    return true;
  }
  return false;
};

const emitInlineLaneRouted = (
  db: Database,
  task: TaskNode,
  reason: string,
): void => {
  emitEvent(db, {
    kind: "constitutional_gate_decision",
    substrate_origin: "substrate_auto",
    directive_id: task.directive_id,
    task_id: task.id,
    payload: {
      gate: "claude_inline_lane_routed",
      reason,
      task_id: task.id,
    } as JsonValue,
  });
};

const emitSchedulerAdmissionGate = (
  db: Database,
  task: TaskNode,
  gate: string,
  payload: Record<string, JsonValue>,
): void => {
  const key = gateKey(task.id, gate);
  if (GATE_NOTIFIED.has(key)) return;
  GATE_NOTIFIED.add(key);
  emitEvent(db, {
    kind: "constitutional_gate_decision",
    substrate_origin: "substrate_auto",
    directive_id: task.directive_id,
    task_id: task.id,
    payload: {
      gate,
      task_id: task.id,
      ...payload,
    } as JsonValue,
  });
};

const DELIVERABLE_PROGRESS_KINDS: ReadonlySet<string> = new Set([
  "contract_amendment_proposed",
  "knowledge_candidate",
  "act_artifact_candidate",
  "lesson_extracted",
  "pre_apply_adjudication_recorded",
]);

const STRUCTURAL_PROGRESS_KINDS: ReadonlySet<string> = new Set([
  ...DELIVERABLE_PROGRESS_KINDS,
  "action_predicted",
  "action_scored",
  "task_node_opened",
  "task_edge_recorded",
  "task_closure_audited",
  "task_committed",
  "task_failed",
  "task_abandoned",
  "task_blocked",
  "task_committed_superseded",
]);

const TERMINAL_OR_RECURSION_KINDS: ReadonlySet<string> = new Set([
  "task_closure_audited",
  "task_committed",
  "task_failed",
  "task_abandoned",
  "task_blocked",
  "task_committed_superseded",
  "task_edge_recorded",
]);

/** Cognitive-work signals: the brain actually RAN and reasoned/researched
 *  this cycle (vs a silent/empty dispatch). A clean closure with cognitive
 *  work but no structural emit is a research cycle mid-flight, not a stuck
 *  loop — it earns a bounded research grace before the no-progress abandon. */
const COGNITIVE_PROGRESS_KINDS: ReadonlySet<string> = new Set([
  "brain_reasoning_recorded",
  "retrieval_binding",
  "bridge_frame_received",
  "brain_message_emitted",
  "claude_reasoning_recorded",
  "counterfactual_alternative_recorded",
]);

/** Bounded grace for research/analysis dispatches: a task whose cycles do
 *  cognitive work but haven't emitted a structural event yet gets up to this
 *  many total dispatches to converge before the no-progress abandon fires.
 *  Truly silent dispatches (no cognitive work) get no grace. */
const RESEARCH_GRACE_CYCLES = 4;

/** HIERARCHICAL CLOSURE (elegance primitive #e). When a dispatch emits a
 *  DELIVERABLE (knowledge_candidate / lesson_extracted / contract_amendment_
 *  proposed / act_artifact_candidate) but NO task_closure_audited and NO
 *  refinement edge, the deliverable survives in the ledger but the task never
 *  formally closes or earns closure-credit. Bare-abandoning that case throws
 *  away real supercomplex-task progress. Instead the substrate gives the task a
 *  BOUNDED closure-audit opportunity: it supersedes the unclosed task with a
 *  closure-focused refinement child whose directive asks the brain to JUDGE
 *  (RLM-first) whether the emitted deliverable closes the directive and emit
 *  task_closure_audited. If the child closes cleanly (residual < 0.3) the
 *  existing cleanClosure branch auto-commits it; if the child itself emits a
 *  deliverable without closure, the lineage cap below terminates the chain so
 *  it cannot loop forever — after the cap, the task abandons exactly as before.
 *  This is additive: the genuinely-stuck (no-deliverable) abandon path and the
 *  normal commit/refinement paths are unchanged. */
const MAX_CLOSURE_AUDIT_REDISPATCHES = 1;

/** Walk the `refines` lineage of a task (self + ancestors) and count how many
 *  closure-audit refinement children the substrate has already opened for it.
 *  The marker is `payload.closure_audit_redispatch === true` on the opening
 *  `task_node_opened` event. Counting across the lineage (not per task_id) is
 *  what BOUNDS the mechanism: each closure-audit child is a fresh task_id, so a
 *  per-task counter would reset to 0 every hop and never terminate. */
const closureAuditRedispatchCount = (db: Database, task: TaskNode): number => {
  // Collect the lineage: this task plus every refines ancestor.
  const lineage = new Set<string>([task.id]);
  const { edges } = readDagForDirective(db, task.directive_id);
  const refinesInto = new Map<string, string>(); // to_task -> from_task
  for (const e of edges) {
    if (e.kind === "refines") refinesInto.set(e.to_task, e.from_task);
  }
  let cur: string | undefined = task.id;
  const seen = new Set<string>([cur]);
  while (cur && refinesInto.has(cur)) {
    const parent = refinesInto.get(cur)!;
    if (seen.has(parent)) break; // cycle defense
    seen.add(parent);
    lineage.add(parent);
    cur = parent;
  }
  // Count opening events in the lineage that are themselves closure-audit
  // children. A row marks itself with closure_audit_redispatch on open.
  const rows = db
    .query(
      `SELECT task_id, payload FROM events
       WHERE kind = 'task_node_opened' AND directive_id = ?`,
    )
    .all(task.directive_id) as Array<{ task_id: string | null; payload: string | null }>;
  let count = 0;
  for (const r of rows) {
    if (!r.task_id || !lineage.has(r.task_id)) continue;
    const payload = parseEventPayload(r.payload);
    if (payload.closure_audit_redispatch === true) count++;
  }
  return count;
};

type NoProgressTermination = {
  terminated: boolean;
  reason?: "no_structural_progress_since_last_dispatch" | "deliverable_without_closure_or_refinement";
  dispatch_id?: string;
  evidence_event_ids?: string[];
};

const parseEventPayload = (payload: string | null): Record<string, unknown> => {
  try {
    return JSON.parse(payload ?? "{}") as Record<string, unknown>;
  } catch {
    return {};
  }
};

/** Dispatch-termination policy: a task that has already had a brain dispatch
 *  must not be re-dispatched unchanged. Amendment/candidate-only cycles are
 *  real deliverables, but they do not alter task topology/status; the next
 *  scheduler admission must therefore see closure, terminalization, or a
 *  refinement edge. Otherwise the daemon self-reaps the zombie before it can
 *  consume another brain slot. */
const terminateNoProgressRedispatch = (db: Database, task: TaskNode): NoProgressTermination => {
  const lastDispatch = db
    .query(
      `SELECT id, ts, payload FROM events
       WHERE task_id = ? AND kind = 'brain_dispatched'
       ORDER BY ts DESC, rowid DESC LIMIT 1`,
    )
    .get(task.id) as { id: string; ts: string; payload: string | null } | null;
  if (!lastDispatch) return { terminated: false };

  const dispatchPayload = parseEventPayload(lastDispatch.payload);
  const dispatchId = typeof dispatchPayload.dispatch_id === "string" ? dispatchPayload.dispatch_id : undefined;
  const rows = db
    .query(
      `SELECT id, kind, residual, payload FROM events
       WHERE task_id = ? AND ts > ?
       ORDER BY ts ASC, rowid ASC`,
    )
    .all(task.id, lastDispatch.ts) as Array<{ id: string; kind: string; residual: number | null; payload: string | null }>;

  // A dispatch that bridge_failed (transient brain-subprocess timeout — 768+
  // all-time, reason=timeout) never got a productive run, so its lack of
  // structural progress is NOT a no-progress loop. Defer to the separate
  // consecutive-bridge-failed cap (MAX_CONSECUTIVE_BRIDGE_FAILED) which fails
  // the task only after repeated transient failures. Without this, research-
  // heavy / new-feature directives that hit one transient bridge timeout were
  // abandoned at the first re-dispatch before the brain could retry + emit.
  if (rows.some((r) => r.kind === "bridge_failed")) {
    return { terminated: false };
  }

  const progressRows = rows.filter((r) => STRUCTURAL_PROGRESS_KINDS.has(r.kind));
  if (progressRows.some((r) => r.kind === "task_committed" || r.kind === "task_failed" || r.kind === "task_abandoned" || r.kind === "task_blocked" || r.kind === "task_committed_superseded")) {
    return { terminated: false };
  }

  const deliverableRows = progressRows.filter((r) => DELIVERABLE_PROGRESS_KINDS.has(r.kind));
  const terminalOrRecursionRows = progressRows.filter((r) => TERMINAL_OR_RECURSION_KINDS.has(r.kind));
  const cleanClosure = terminalOrRecursionRows.find((r) => {
    if (r.kind !== "task_closure_audited") return false;
    const payload = parseEventPayload(r.payload);
    const residual = typeof payload.closure_residual === "number" ? payload.closure_residual : r.residual;
    return typeof residual === "number" && Number.isFinite(residual) && residual < 0.3;
  });

  if (cleanClosure) {
    emitEvent(db, {
      kind: "task_committed",
      substrate_origin: "substrate_auto",
      directive_id: task.directive_id,
      task_id: task.id,
      residual: 0,
      context_refs: [cleanClosure.id],
      payload: {
        dispatch_id: dispatchId,
        reason: "auto_commit_on_no_progress_redispatch_after_clean_closure",
        closure_audit_event_id: cleanClosure.id,
      } as JsonValue,
    });
    return { terminated: true, reason: "deliverable_without_closure_or_refinement", dispatch_id: dispatchId, evidence_event_ids: [cleanClosure.id] };
  }

  const noStructuralProgress = progressRows.length === 0;
  const deliverableWithoutClosureOrRefinement = deliverableRows.length > 0 && terminalOrRecursionRows.length === 0;
  if (!noStructuralProgress && !deliverableWithoutClosureOrRefinement) return { terminated: false };

  // RESEARCH GRACE (anti over-correction): a deep-research/analysis cycle does
  // its work IN-CYCLE via tools (web fetch, reasoning) and may close cleanly
  // having reasoned/researched without yet emitting a structural substrate
  // event — e.g. the Lakeland groundbase run closed after ~28s, abandoned with
  // no_structural_progress before it could emit a knowledge_candidate. Killing
  // it on the FIRST clean closure is the same over-correction class as the
  // reaper-cap (1→4) and bridge-failure cases. So: if the brain actually RAN
  // and did COGNITIVE work this cycle (reasoning / retrieval / brain frames),
  // give the task a bounded grace — re-dispatch to let research converge into a
  // structural emit — until RESEARCH_GRACE_CYCLES consecutive cognitive-only
  // closures. Truly SILENT dispatches (no cognitive activity at all) get no
  // grace and abandon immediately; genuine no-progress loops abandon at the cap.
  if (noStructuralProgress) {
    const didCognitiveWork = rows.some((r) => COGNITIVE_PROGRESS_KINDS.has(r.kind));
    if (didCognitiveWork) {
      const dispatchCount = (db
        .query("SELECT COUNT(*) AS c FROM events WHERE task_id = ? AND kind = 'brain_dispatched'")
        .get(task.id) as { c: number } | null)?.c ?? 0;
      if (dispatchCount < RESEARCH_GRACE_CYCLES) {
        // Grace: the brain is researching; let it continue another cycle.
        return { terminated: false };
      }
    }
  }

  // HIERARCHICAL CLOSURE (elegance primitive #e): a dispatch that emitted a
  // deliverable but no closure/refinement has REAL progress in the ledger — it
  // just never formally closed. Before bare-abandoning, give it a BOUNDED
  // closure-audit opportunity: supersede the unclosed task with a closure-
  // focused refinement child that asks the brain to JUDGE (RLM-first) whether
  // the emitted deliverable closes the directive and emit task_closure_audited.
  // Bounded by MAX_CLOSURE_AUDIT_REDISPATCHES across the refines lineage so the
  // chain cannot loop forever — once the cap is hit the task abandons exactly
  // as before. ADDITIVE: only the deliverable-emitted-but-unclosed case takes
  // this branch; genuinely-stuck (noStructuralProgress) still abandons below.
  if (deliverableWithoutClosureOrRefinement) {
    const auditsSoFar = closureAuditRedispatchCount(db, task);
    if (auditsSoFar < MAX_CLOSURE_AUDIT_REDISPATCHES) {
      const deliverableEvidence = deliverableRows.map((r) => r.id).slice(0, 20);
      const childTaskId = newId();
      const closureDirective =
        `Closure audit (hierarchical closure): the prior cycle on this task emitted ` +
        `${deliverableRows.length} deliverable(s) (` +
        `${Array.from(new Set(deliverableRows.map((r) => r.kind))).join(", ")}` +
        `) but did not formally close. Judge whether those deliverables close the ` +
        `original directive: re-read the directive intent and the emitted ` +
        `deliverable(s) (evidence event ids: ${deliverableEvidence.join(", ")}), then ` +
        `emit task_closure_audited with closure_residual < 0.3 if they close it, or a ` +
        `refinement edge describing the remaining work if they do not. Do NOT emit a ` +
        `bare deliverable without a closure audit or refinement edge.`;
      emitEvent(db, {
        kind: "task_node_opened",
        substrate_origin: "substrate_auto",
        directive_id: task.directive_id,
        task_id: childTaskId,
        parent_task_id: task.id,
        payload: {
          goal: closureDirective,
          lifecycle: "finite",
          urgency: "normal",
          closure_audit_redispatch: true,
          source: "hierarchical_closure_audit",
          superseded_task_id: task.id,
          deliverable_evidence_event_ids: deliverableEvidence,
        } as JsonValue,
      });
      emitEvent(db, {
        kind: "task_edge_recorded",
        substrate_origin: "substrate_auto",
        directive_id: task.directive_id,
        task_id: childTaskId,
        payload: { kind: "refines", from_task: task.id, to_task: childTaskId } as JsonValue,
      });
      // Supersede the unclosed task so it drops out of readyTasks (terminal =
      // committed in topology) and is NOT re-dispatched unchanged — the closure
      // child carries the work forward. The deliverable survives in the ledger.
      const supersede = emitEvent(db, {
        kind: "task_committed_superseded",
        substrate_origin: "substrate_auto",
        directive_id: task.directive_id,
        task_id: task.id,
        outcome: "superseded_for_closure_audit",
        context_refs: deliverableEvidence,
        payload: {
          reason: "deliverable_without_closure_superseded_by_closure_audit",
          dispatch_id: dispatchId,
          closure_audit_task_id: childTaskId,
          deliverable_evidence_event_ids: deliverableEvidence,
          closure_audit_redispatch_count: auditsSoFar + 1,
          cap: MAX_CLOSURE_AUDIT_REDISPATCHES,
          policy: "hierarchical_closure_bounded_audit_before_abandon",
        } as JsonValue,
      });
      return {
        terminated: true,
        reason: "deliverable_without_closure_or_refinement",
        dispatch_id: dispatchId,
        evidence_event_ids: [supersede.id, childTaskId],
      };
    }
    // Cap reached: fall through to the existing bare-abandon below.
  }

  const reason = noStructuralProgress
    ? "no_structural_progress_since_last_dispatch"
    : "deliverable_without_closure_or_refinement";
  const evidenceEventIds = (deliverableRows.length > 0 ? deliverableRows : rows).map((r) => r.id).slice(0, 20);
  emitEvent(db, {
    kind: "task_abandoned",
    substrate_origin: "substrate_auto",
    directive_id: task.directive_id,
    task_id: task.id,
    failure_kind: reason,
    payload: {
      reason,
      dispatch_id: dispatchId,
      prior_dispatch_event_id: lastDispatch.id,
      evidence_event_ids: evidenceEventIds,
      policy: "first_no_progress_redispatch_terminates_before_spawning_brain",
      hint: "Brain cycles that emit deliverables must also emit task_closure_audited/task_committed or a refinement edge; amendment-only exits are not eligible for re-dispatch on the same task_id.",
    } as JsonValue,
  });
  return { terminated: true, reason, dispatch_id: dispatchId, evidence_event_ids: evidenceEventIds };
};

/** One tick: read ready tasks, fill open dispatch slots, route by lane.
 *  Returns immediately after launching dispatches — the per-task promises
 *  remain tracked in IN_FLIGHT until they resolve. Tests await the
 *  per-dispatch promise by calling schedulerTickAwait. */
export const schedulerTick = async (
  db: Database,
  opts: SchedulerOpts = {},
): Promise<SchedulerTick> => {
  // Crisis-mode adjustments: if a directive scope is supplied AND that
  // directive is in crisis, raise maxConcurrent before applying the cap.
  // Without a directive scope we keep the caller's baseline (Phase K Father
  // will pick the active directive for us).
  let effectiveOpts: SchedulerOpts = { ...opts };
  if (opts.directiveId) {
    const mode = readCurrentMode(db, opts.directiveId);
    effectiveOpts = applyModeAdjustments(effectiveOpts, mode);
  }
  const maxConcurrent = Math.max(1, effectiveOpts.maxConcurrent ?? opts.maxConcurrent ?? DEFAULT_MAX_CONCURRENT);
  // Multi-goal alignment (2026-05-15): per-directive cap so one
  // runaway goal can't starve concurrent goals. Default to half the
  // global cap.
  const rawPerDir = effectiveOpts.maxConcurrentPerDirective ?? opts.maxConcurrentPerDirective;
  const maxConcurrentPerDirective = Math.max(1, rawPerDir ?? Math.ceil(maxConcurrent / 2));
  const ready = readyTasks(db, opts.directiveId);
  if (SCHEDULER_DRAINING) {
    for (const task of ready) {
      emitSchedulerAdmissionGate(db, task, "scheduler_draining", {
        reason: "scheduler_admission_paused_for_restart_drain",
        in_flight: IN_FLIGHT.size,
      });
    }
    return {
      dispatched: [],
      in_flight: Array.from(IN_FLIGHT.keys()),
      skipped_concurrency_cap: [],
      skipped_recipe: [],
      skipped_inline: [],
      skipped_blocked: [],
      skipped_draining: ready.map((task) => task.id),
      skipped_interference: [],
      skipped_failure_capped: [],
    };
  }

  // Branch-competition lane: when sibling refinement branches expose
  // trigger_residual / expected_residual_delta, prefer the branch with the
  // best expected residual reduction before falling back to oldest-ready
  // fairness. This keeps strategic alternatives competing on verifier axes
  // instead of whichever task_node_opened happened to be oldest.
  const taskOpenedTs = (taskId: string): string => {
    const row = db
      .query("SELECT ts FROM events WHERE kind = 'task_node_opened' AND task_id = ? ORDER BY ts ASC LIMIT 1")
      .get(taskId) as { ts: string } | null;
    return row?.ts ?? "";
  };
  const branchCompetitionScore = (taskId: string): number => {
    const row = db
      .query("SELECT payload FROM events WHERE kind = 'task_edge_recorded' AND json_extract(payload, '$.to_task') = ? ORDER BY ts DESC LIMIT 1")
      .get(taskId) as { payload: string } | null;
    if (!row) return 0;
    try {
      const p = JSON.parse(row.payload) as { trigger_residual?: number; expected_residual_delta?: number };
      return Math.max(0, Number(p.trigger_residual ?? 0)) * Math.max(0, Number(p.expected_residual_delta ?? 0));
    } catch { return 0; }
  };
  // Operator-dispatch fairness floor (foundational fix 2026-05-18):
  // pre-fix the scheduler ordered by branchCompetitionScore first (refinement
  // edges with trigger_residual × expected_residual_delta), then by
  // task_opened_ts oldest-first. Operator-initiated root tasks have NO
  // refinement edge pointing to them → branchCompetitionScore = 0 → they
  // perpetually lose to any brain-emitted child carrying even a tiny
  // residual hint. Observed: a 4-hour-old operator `acc task` landed in
  // orphan_node while 43 brain_dispatched fired in 10 min — pure
  // starvation by branch competition.
  //
  // Fix: add an age bonus to the effective score. Below 5 min waiting,
  // bonus is 0 (branch competition wins, the intended fast path). Over
  // 5 min, bonus grows linearly (+1.0 per 5 min). After 30 min waiting,
  // bonus = 5.0 which beats almost any branchCompetitionScore (residual
  // × delta is bounded ∈ [0,1]). This guarantees an operator dispatch
  // can never be starved indefinitely, while letting fresh refinement
  // edges still take precedence in normal operation.
  const ageBonusFor = (taskId: string): number => {
    const ts = taskOpenedTs(taskId);
    if (!ts) return 0;
    const ageMs = Math.max(0, Date.now() - Date.parse(ts));
    const FAIRNESS_AGE_THRESHOLD_MS = 5 * 60 * 1000;
    const FAIRNESS_AGE_BONUS_PER_MS = 1 / FAIRNESS_AGE_THRESHOLD_MS;
    return Math.max(0, (ageMs - FAIRNESS_AGE_THRESHOLD_MS) * FAIRNESS_AGE_BONUS_PER_MS);
  };
  const effectiveScore = (taskId: string): number => branchCompetitionScore(taskId) + ageBonusFor(taskId);
  ready.sort((a, b) => {
    const scoreDelta = effectiveScore(b.id) - effectiveScore(a.id);
    if (scoreDelta !== 0) return scoreDelta;
    return taskOpenedTs(a.id).localeCompare(taskOpenedTs(b.id));
  });

  const dispatched: string[] = [];
  const skippedConcurrencyCap: string[] = [];
  const skippedRecipe: string[] = [];
  const skippedInline: string[] = [];
  const skippedBlocked: string[] = [];
  const skippedInterference: string[] = [];
  const skippedFailureCapped: string[] = [];
  const pending: Array<Promise<unknown>> = [];

  // Per-tick brain handshake budget (anti-starve): handshake permits acquire
  // ASYNC after dispatch, so within a single tick hasFreeHandshakePermit()
  // stays true until the acquires register — a burst of ready brain tasks
  // could over-admit. Capture the free-permit count at tick start and
  // decrement per brain admission so a burst staggers across ticks instead
  // of spawning doomed subprocesses.
  let brainHandshakeBudget = freeHandshakePermits();

  for (const task of ready) {
    if (IN_FLIGHT.has(task.id)) continue; // already dispatched in a prior tick.

    const noProgressTermination = terminateNoProgressRedispatch(db, task);
    if (noProgressTermination.terminated) {
      skippedFailureCapped.push(task.id);
      emitSchedulerAdmissionGate(db, task, "scheduler_no_progress_redispatch_terminated", {
        reason: noProgressTermination.reason ?? "no_progress_redispatch_terminated",
        dispatch_id: noProgressTermination.dispatch_id ?? null,
        evidence_event_ids: noProgressTermination.evidence_event_ids ?? [],
      });
      continue;
    }

    // SILENT-DISPATCH QUARANTINE (FOUNDATIONAL FIX 2026-05-17):
    // Brain failures classified as `brain_silent_exit`, `mcp_handshake_timed_out`,
    // or `subprocess_stuck` are DETERMINISTIC — the brain will fail the same
    // way on the same task again. Live ledger evidence: CHRZM6VX4H7YVF7D
    // silent-failed 5 times in a row across multiple dispatches, each
    // consuming 5 min of brain-slot time, never accumulating 3 CONSECUTIVE
    // generic failures (the consecutive cap below) because other tasks
    // landed in between. The generic cap protects against transport flaps;
    // this tighter silent-class cap (1) prevents wasted compute on
    // structurally-incompatible tasks. Operator may re-open via a fresh
    // task_id once the prompt/grammar issue is fixed.
    const silentFailures = silentDispatchFailureEvidence(db, task.id);
    // Split by determinism class. Deterministic failures quarantine after 1
    // failure; transient failures (handshake timeouts) get up to 3 retries
    // since fresh attempts may succeed once concurrent contention clears.
    const deterministicFailures = silentFailures.filter((f) => DETERMINISTIC_SILENT_REASONS.has(f.reason));
    const transientFailures = silentFailures.filter((f) => TRANSIENT_SILENT_REASONS.has(f.reason));
    const overDeterministicCap = deterministicFailures.length >= MAX_DETERMINISTIC_SILENT_FAILURES;
    const overTransientCap = transientFailures.length >= MAX_TRANSIENT_SILENT_FAILURES;
    if (overDeterministicCap || overTransientCap) {
      skippedFailureCapped.push(task.id);
      const quarantineClass = overDeterministicCap ? "deterministic" : "transient";
      const cap = overDeterministicCap ? MAX_DETERMINISTIC_SILENT_FAILURES : MAX_TRANSIENT_SILENT_FAILURES;
      const reasonsObserved = Array.from(new Set(silentFailures.map((f) => f.reason)));
      emitEvent(db, {
        kind: "task_failed",
        substrate_origin: "substrate_auto",
        directive_id: task.directive_id,
        task_id: task.id,
        failure_kind: "silent_dispatch_quarantine",
        payload: {
          silent_failures: silentFailures.length,
          deterministic_failures: deterministicFailures.length,
          transient_failures: transientFailures.length,
          cap,
          quarantine_class: quarantineClass,
          reason: "silent_dispatch_quarantine",
          reasons_observed: reasonsObserved,
          backoff_mode: "terminal_after_silent_class_failure",
          retry_evidence_event_ids: silentFailures.map((f) => f.id),
          retry_evidence: silentFailures,
          hint: overDeterministicCap
            ? "brain produced zero substrate emits for this task (deterministic). Re-dispatch on the same task_id will repeat the failure. Operator should investigate prompt shape OR re-open via a fresh task_id once the brain-incompatible pattern is resolved."
            : "task failed handshake repeatedly (transient class). Concurrent opencode boot contention is the usual cause; if the substrate is otherwise quiet a fresh task_id is likely to succeed.",
        } as JsonValue,
      });
      continue;
    }

    // Consecutive-failure backoff (no retry storm). If the task's most-recent
    // bridge_failed streak hit the cap, emit `task_failed` so it drops out of
    // `readyTasks` on the next call — the cap prevents the scheduler from
    // hot-looping a structurally broken dispatch (mcp_server_url_missing,
    // auth_missing, etc.). Silent-class failures are caught above by the
    // tighter MAX_SILENT_DISPATCH_FAILURES gate; this generic cap is for
    // transient transport failures. Operators see the failure verbatim
    // in the substrate and can re-open the task once the underlying gap is
    // fixed (the next `acc task` call gets a fresh task_id).
    const failureStreak = consecutiveBridgeFailures(db, task.id);
    if (failureStreak >= MAX_CONSECUTIVE_BRIDGE_FAILURES) {
      skippedFailureCapped.push(task.id);
      const failureEvidence = consecutiveBridgeFailureEvidence(db, task.id);
      emitEvent(db, {
        kind: "task_failed",
        substrate_origin: "substrate_auto",
        directive_id: task.directive_id,
        task_id: task.id,
        failure_kind: "consecutive_bridge_failures",
        payload: {
          consecutive_failures: failureStreak,
          cap: MAX_CONSECUTIVE_BRIDGE_FAILURES,
          reason: "consecutive_bridge_failures_exceeded_cap",
          backoff_mode: "terminal_after_consecutive_bridge_failures",
          retry_evidence_event_ids: failureEvidence.map((e) => e.id),
          retry_evidence: failureEvidence,
        } as JsonValue,
      });
      continue;
    }

    // Cross-directive interference (Phase DAG): defer when a peer directive
    // joined by `mutual_exclusion` / `resource_conflict` is in-flight. We
    // assemble the in-flight directive set from the live registry (the same
    // tick's dispatches are appended below so two intra-tick conflicts also
    // serialise).
    const inFlightDirectives = new Set<string>(IN_FLIGHT_DIRECTIVE.values());
    const conflict = findDeferringConflict(db, task.directive_id, inFlightDirectives);
    if (conflict !== null) {
      skippedInterference.push(task.id);
      emitEvent(db, {
        kind: "task_deferred_for_interference",
        substrate_origin: "substrate_auto",
        directive_id: task.directive_id,
        task_id: task.id,
        payload: {
          from_directive: task.directive_id,
          conflicting_directive: conflict.conflicting_directive,
          interaction: conflict.kind,
          reason: "concurrency_conflict_with_in_flight_directive",
        } as JsonValue,
      });
      emitSchedulerAdmissionGate(db, task, "scheduler_interference_deferred", {
        reason: "concurrency_conflict_with_in_flight_directive",
        conflicting_directive: conflict.conflicting_directive,
        interaction: conflict.kind,
      });
      continue;
    }

    const slotsLeft = maxConcurrent - IN_FLIGHT.size;
    if (slotsLeft <= 0) {
      skippedConcurrencyCap.push(task.id);
      emitSchedulerAdmissionGate(db, task, "scheduler_global_concurrency_cap", {
        reason: "scheduler_global_in_flight_at_cap",
        in_flight: IN_FLIGHT.size,
        cap: maxConcurrent,
      });
      continue;
    }
    // Per-directive cap: how many slots is THIS directive already using?
    // When ≥ maxConcurrentPerDirective, defer this task so peer goals
    // get a turn. Logged via skippedConcurrencyCap so the scheduler-
    // tick payload shows the queue pressure.
    let perDirCount = 0;
    for (const d of IN_FLIGHT_DIRECTIVE.values()) {
      if (d === task.directive_id) perDirCount++;
    }
    if (perDirCount >= maxConcurrentPerDirective && !hasParallelSiblingSlot(db, task)) {
      skippedConcurrencyCap.push(task.id);
      emitSchedulerAdmissionGate(db, task, "scheduler_per_directive_concurrency_cap", {
        reason: "scheduler_directive_in_flight_at_cap",
        directive_in_flight: perDirCount,
        cap: maxConcurrentPerDirective,
      });
      continue;
    }

    const decision = decideDispatch(db, task);
    const dispatchDecisionEvidence = dispatchEvidencePayload(decision);
    if (decision.route === "deferred_blocked") {
      skippedBlocked.push(task.id);
      emitEvent(db, {
        kind: "dispatch_decided",
        substrate_origin: "substrate_auto",
        directive_id: task.directive_id,
        task_id: task.id,
        payload: {
          ...dispatchDecisionEvidence,
        } as JsonValue,
      });
      emitEvent(db, {
        kind: "constitutional_gate_decision",
        substrate_origin: "substrate_auto",
        directive_id: task.directive_id,
        task_id: task.id,
        payload: {
          gate: "directive_blocked_deferred",
          blockers: decision.blockers,
          ...dispatchDecisionEvidence,
        } as JsonValue,
      });
      continue;
    }

    // substrate_replay falls through to dispatchReadyTask below, which calls
    // replayRecipe (runtime/recipe_replay.ts) internally. The scheduler used
    // to short-circuit this route with a Phase-J stub (returning
    // {ok:false, error:"phase_j"} on every tick — tight loop emitting
    // `substrate_replay_skipped` because readyTasks kept returning the same
    // task forever). Real Tier-0 replay now runs.

    if (decision.route === "claude_inline") {
      emitEvent(db, {
        kind: "dispatch_decided",
        substrate_origin: "substrate_auto",
        directive_id: task.directive_id,
        task_id: task.id,
        payload: {
          ...dispatchDecisionEvidence,
        } as JsonValue,
      });
      skippedInline.push(task.id);
      emitInlineLaneRouted(db, task, decision.reason);
      continue;
    }

    // Batch 8.A bridge-health gate (cite brain lesson 5SWP11NZFS3YX68Y95T164HT9W):
    // when ≥ BRIDGE_DEGRADATION_THRESHOLD bridge_failed events fired within
    // BRIDGE_FAILURE_WINDOW_MS, the substrate flips to degraded. The brain
    // surfaced this pattern in a workflow-policy lesson_extracted:
    //   "Add a pre-dispatch bridge-health gate or scheduler backoff that
    //    pauses repeated opencode dispatch after bridge_stuck/no-frame
    //    streaks and opens a diagnostic task instead of spawning duplicate
    //    stale dispatches."
    // Tier-0 substrate_replay and claude_inline lanes still dispatch; only
    // the opencode_brain lane is paused. Auto-clears via bridge_health_recovered
    // when BRIDGE_HEALTH_COOLDOWN_MS passes with no further failures.
    if (decision.route === "opencode_brain" && isBridgeHealthDegraded(db)) {
      const key = gateKey(task.id, "bridge_health_degraded");
      if (!GATE_NOTIFIED.has(key)) {
        GATE_NOTIFIED.add(key);
        emitEvent(db, {
          kind: "constitutional_gate_decision",
          substrate_origin: "substrate_auto",
          directive_id: task.directive_id,
          task_id: task.id,
          payload: {
            gate: "bridge_health_degraded",
            reason: "opencode_brain_dispatch_paused_pending_bridge_recovery",
            note: "single notification per task while gate closed; cleared on recovery or task settle",
          } as JsonValue,
        });
      }
      continue;
    }

    // OOM defence: each opencode subprocess consumes ~1-2GB. The global
    // maxConcurrent cap counts ALL routes (substrate_replay + claude_inline
    // + opencode_brain) — cheap routes shouldn't squeeze brain runs out, but
    // ALSO brain runs shouldn't pile up unbounded on top of cheap ones. The
    // brain cap is computed dynamically from live host RAM at dispatch time
    // (computeBrainDispatchCap) so the same daemon runs correctly on hosts
    // with 4GB / 8GB / 32GB / 64GB RAM without operator tuning. When full,
    // the task stays in ready state and re-attempts next tick.
    if (decision.route === "opencode_brain") {
      const daemonHeap = computeDaemonHeapPressureState();
      if (daemonHeap.under_pressure) {
        skippedConcurrencyCap.push(task.id);
        emitSchedulerAdmissionGate(db, task, "daemon_heap_pressure", {
          reason: "opencode_brain_dispatch_paused_for_daemon_heap_pressure",
          daemon_rss_bytes: daemonHeap.rss_bytes,
          daemon_heap_used_bytes: daemonHeap.heap_used_bytes,
          rss_pressure_threshold_bytes: daemonHeap.rss_pressure_threshold_bytes,
          in_flight_brain: IN_FLIGHT_BRAIN.size,
          note: "new opencode_brain admission is deferred until daemon RSS falls below the pressure threshold; existing in-flight work may settle",
        });
        continue;
      }

      const brainCap = computeBrainDispatchCap();
      // FOUNDATIONAL anti-starve gate: only admit a brain when the bridge has
      // a FREE handshake permit. The RAM cap alone over-admitted relative to
      // the handshake capacity (cap 2), so excess dispatches failed-open and
      // spawned doomed opencode subprocesses that starved at the MCP handshake.
      // Gating admission on handshake availability keeps the excess queued
      // (retries next tick) instead of spawning a starving subprocess. Permits
      // free after the brief handshake, so run-concurrency still reaches the
      // RAM cap — only the handshake phase is staggered (no starvation).
      if (IN_FLIGHT_BRAIN.size >= brainCap || !hasFreeHandshakePermit() || brainHandshakeBudget <= 0) {
        // Dedupe at_cap notifications per (task_id, gate) — see GATE_NOTIFIED.
        const key = gateKey(task.id, "brain_concurrency_cap");
        if (!GATE_NOTIFIED.has(key)) {
          GATE_NOTIFIED.add(key);
          emitEvent(db, {
            kind: "constitutional_gate_decision",
            substrate_origin: "substrate_auto",
            directive_id: task.directive_id,
            task_id: task.id,
            payload: {
              gate: "brain_concurrency_cap",
              reason: IN_FLIGHT_BRAIN.size >= brainCap
                ? "opencode_brain_in_flight_at_cap"
                : "no_free_handshake_permit",
              in_flight_brain: IN_FLIGHT_BRAIN.size,
              cap: brainCap,
              cap_source: IN_FLIGHT_BRAIN.size >= brainCap ? "dynamic_host_ram" : "bridge_handshake_capacity",
              handshake_permit_free: hasFreeHandshakePermit(),
              note: "single notification per saturation cycle; tick keeps trying silently until cap clears (anti-starve: excess queues, never spawns a doomed subprocess)",
            } as JsonValue,
          });
        }
        continue;
      }
    }

    // opencode_brain lane → actual dispatch.
    if (decision.route === "opencode_brain") {
      // DURABLE CROSS-PROCESS CLAIM (multi-worker-daemon coordination).
      // IN_FLIGHT.has(task.id) above is the in-process fast-path cache.
      // The lease is the cross-process AUTHORITY: atomically claim it
      // before launching the brain. If another worker daemon holds an
      // UNEXPIRED lease, defer (skip this task this tick). On lease-write
      // error, FAIL OPEN — degrade to the in-memory dedup we just passed
      // rather than wedging dispatch. Expired leases are always reclaimed
      // by the atomic upsert, so a crashed holder never blocks forever.
      const claim = claimDispatchLease(db, task.id, leaseHolder());
      if (claim.status === "held") {
        skippedConcurrencyCap.push(task.id);
        emitSchedulerAdmissionGate(db, task, "dispatch_lease_held_by_peer", {
          reason: "dispatch_lease_held_by_another_holder",
          holder: claim.holder,
          expires_at: claim.expires_at,
          note: "another worker daemon owns the durable brain-dispatch lease for this task; deferring (expired leases are always reclaimable, so this never blocks permanently)",
        });
        continue;
      }
      // claim.status === "claimed" → we own the durable lease.
      // claim.status === "error"  → fall open to in-memory dedup.
      IN_FLIGHT_BRAIN.add(task.id);
      brainHandshakeBudget -= 1; // consume one handshake slot this tick (anti-starve)
    }
    const promise = dispatchReadyTask(db, task, {
      fixtureTargetPath: opts.fixtureTargetPath,
      index: opts.index,
    })
      .catch((err: Error) => {
        // Per-dispatch error isolation. Record a failure event so the audit
        // trail stays complete; the tick continues.
        try {
          emitEvent(db, {
            kind: "dispatcher_violation",
            substrate_origin: "substrate_auto",
            directive_id: task.directive_id,
            task_id: task.id,
            failure_kind: "bridge_killed",
            payload: {
              gate: "scheduler_dispatch_isolated_error",
              error: err.message ?? String(err),
            } as JsonValue,
          });
        } catch { /* swallow */ }
      })
      .finally(() => {
        clearInFlightTask(task.id, db);
      });
    // Mark settled-flag accessor lazily — best-effort cleanup helper.
    (promise as Promise<unknown> & { _settled?: boolean })._settled = false;
    void promise.then(
      () => ((promise as Promise<unknown> & { _settled?: boolean })._settled = true),
      () => ((promise as Promise<unknown> & { _settled?: boolean })._settled = true),
    );
    IN_FLIGHT.set(task.id, promise);
    IN_FLIGHT_DIRECTIVE.set(task.id, task.directive_id);
    IN_FLIGHT_PARENT.set(task.id, refinementParent(db, task));
    pending.push(promise);
    dispatched.push(task.id);
  }

  // Production scheduler ticks return after launching dispatches so sibling
  // brain leaves can run concurrently across poll cycles. Tests that need a
  // drain point should await the tracked promises (IN_FLIGHT registry) via
  // `drainInFlightDispatches(db)` instead.
  if (pending.length > 0) {
    // Track but DON'T await — sibling leaves dispatch concurrently.
    // Each promise self-cleans from IN_FLIGHT via its .finally() handler.
  }

  return {
    dispatched,
    in_flight: Array.from(IN_FLIGHT.keys()),
    skipped_concurrency_cap: skippedConcurrencyCap,
    skipped_recipe: skippedRecipe,
    skipped_inline: skippedInline,
    skipped_blocked: skippedBlocked,
    skipped_draining: [],
    skipped_interference: skippedInterference,
    skipped_failure_capped: skippedFailureCapped,
  };
};

export type SchedulerLoopOpts = SchedulerOpts & {
  stopAfterTicks?: number;
  abort?: AbortSignal;
};

/** setInterval-style loop suitable for the daemon to run continuously.
 *  Stops when (a) the AbortSignal fires, (b) stopAfterTicks is reached, or
 *  (c) readyTasks returns empty AND IN_FLIGHT is empty for two consecutive
 *  ticks (a "drained" quiescence — the loop yields rather than spinning). */
export const schedulerLoop = async (
  db: Database,
  opts: SchedulerLoopOpts = {},
): Promise<void> => {
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const stopAfterTicks = opts.stopAfterTicks ?? Infinity;
  let ticks = 0;
  let drainedStreak = 0;

  // Brain elegance bc8je5f3x (2026-05-15): wake immediately when a new
  // ready-task signal lands on the activation bus instead of waiting
  // for the next poll tick. Polling stays as the safety-net max-timeout
  // so a missed publish (cross-process / subscriber crash) still drains.
  const { waitForActivation, onEvent } = await import("./activation_bus");
  const WAKE_KINDS = [
    "directive_opened",
    "task_node_opened",
    "task_committed",
    "task_failed",
    "directive_resumed",
  ] as const;
  const clearOnEventKinds = [
    "brain_dispatch_closed",
    "dispatch_recovered_orphan",
    "dispatcher_violation",
    "task_committed",
    "task_failed",
    "task_abandoned",
    "task_blocked",
    "task_committed_superseded",
  ] as const;
  const clearDisposers = clearOnEventKinds.map((kind) => onEvent(kind, (payload) => {
    if (payload.task_id) clearInFlightTask(payload.task_id, db);
  }));

  try {
  while (ticks < stopAfterTicks) {
    if (opts.abort?.aborted) return;
    const tick = await schedulerTick(db, opts);
    ticks++;
    if (tick.dispatched.length === 0 && tick.in_flight.length === 0) {
      drainedStreak++;
      if (drainedStreak >= 2 && stopAfterTicks === Infinity) {
        // Quiescent — yield. The daemon can call schedulerLoop again when a
        // new directive arrives.
        return;
      }
    } else {
      drainedStreak = 0;
    }
    if (ticks >= stopAfterTicks) return;
    // Wait for either the next poll tick OR an activation event. The race
    // means a fresh directive_opened wakes the scheduler within ~1ms
    // instead of pollIntervalMs (default 500ms). When activation fires,
    // the returned promise resolves with the payload; we ignore it and
    // just loop — the next tick will see the row in ready_tasks_view.
    await Promise.race([
      new Promise((r) => setTimeout(r, pollIntervalMs)),
      waitForActivation(WAKE_KINDS, opts.abort),
    ]);
  }
  } finally {
    for (const dispose of clearDisposers) dispose();
  }
};

/** Test-only: clear the process-local in-flight registry. */
export const _resetSchedulerForTests = (): void => {
  IN_FLIGHT.clear();
  IN_FLIGHT_DIRECTIVE.clear();
  IN_FLIGHT_PARENT.clear();
  // Parallel-DAG contract (1826363): schedulerTick returns after launch,
  // so a test that didn't drain leaves IN_FLIGHT_BRAIN populated. Cleared
  // here so the next test's brain dispatch isn't artificially capped.
  IN_FLIGHT_BRAIN.clear();
  GATE_NOTIFIED.clear();
  SCHEDULER_DRAINING = false;
};

/** Await every in-flight dispatch tracked in the process-local IN_FLIGHT
 *  registry. Production schedulerTick returns after launching (so siblings
 *  run concurrently); callers that need post-dispatch state — tests, the
 *  schedulerLoop's quiescence detector, and any consumer that wants to
 *  assert ledger rows synchronously — call this helper to drain. The
 *  promises self-clean from IN_FLIGHT via their .finally() handlers, so
 *  the registry shrinks naturally as each dispatch resolves. The function
 *  is safe to call when nothing is in flight (Promise.all on []) and may
 *  be called repeatedly. */
export const drainInFlightDispatches = async (
  opts: { timeoutMs?: number } = {},
): Promise<{ completed: boolean; timed_out_task_ids: string[] }> => {
  // Snapshot first — IN_FLIGHT mutates as promises resolve.
  const snapshot = Array.from(IN_FLIGHT.entries());
  if (snapshot.length === 0) return { completed: true, timed_out_task_ids: [] };
  const allSettled = Promise.allSettled(snapshot.map(([, promise]) => promise));
  if (opts.timeoutMs === undefined) {
    await allSettled;
    return { completed: true, timed_out_task_ids: [] };
  }
  const timeout = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), opts.timeoutMs));
  const result = await Promise.race([allSettled, timeout]);
  if (result !== "timeout") return { completed: true, timed_out_task_ids: [] };
  return { completed: false, timed_out_task_ids: Array.from(IN_FLIGHT.keys()) };
};

// ── Multi-process in-flight detection (SQL-backed) ────────────────────
//
// The IN_FLIGHT Map above is process-local. Two daemons sharing one substrate
// (Phase G+ when uv / camofox runtimes show up alongside the bun daemon, or
// any operator running `acc daemon` plus `acc task` from another shell) need
// a substrate-visible signal. The pair `brain_dispatched` (open) /
// `brain_dispatch_closed` (close) is one such signal — every dispatch the
// runtime begins is bracketed by these two events with a stable
// `payload.dispatch_id`. A directive is in-flight regardless of process iff
// at least one of its `brain_dispatched` rows lacks a matching
// `brain_dispatch_closed` (same dispatch_id).

/** Return the set of directive_ids that have an open brain dispatch (a
 *  `brain_dispatched` event whose `payload.dispatch_id` has no matching
 *  `brain_dispatch_closed`). Process-independent — multiple daemons can call
 *  this concurrently and observe the same in-flight set. The OR-fold against
 *  any in-memory IN_FLIGHT Map happens at the caller. */
export const inFlightDirectivesFromSql = (db: Database): Set<string> => {
  // Pull every open + close pair. Substrate is append-only — closes always
  // follow opens — so a "set-difference by dispatch_id" projects the live set
  // exactly. Reading both columns in one pass keeps this O(rows) and avoids
  // a correlated subquery.
  const openRows = db
    .query(
      `SELECT directive_id, payload FROM events
       WHERE kind = 'brain_dispatched'`,
    )
    .all() as Array<{ directive_id: string; payload: string }>;

  const closeIds = new Set<string>();
  const closeRows = db
    .query(
      `SELECT payload FROM events
       WHERE kind = 'brain_dispatch_closed'`,
    )
    .all() as Array<{ payload: string }>;
  for (const r of closeRows) {
    try {
      const p = JSON.parse(r.payload ?? "{}") as { dispatch_id?: string };
      if (p.dispatch_id) closeIds.add(p.dispatch_id);
    } catch { /* skip malformed payload */ }
  }

  const inFlight = new Set<string>();
  for (const r of openRows) {
    try {
      const p = JSON.parse(r.payload ?? "{}") as { dispatch_id?: string };
      if (!p.dispatch_id) continue;
      if (closeIds.has(p.dispatch_id)) continue;
      if (r.directive_id) inFlight.add(r.directive_id);
    } catch { /* skip malformed payload */ }
  }
  return inFlight;
};

/** Find the first cross-directive interference edge (kind = `mutual_exclusion`
 *  or `resource_conflict`) between `candidateDirectiveId` and any in-flight
 *  directive (per `inFlightDirectivesFromSql`). Returns `null` when no
 *  conflict exists. This is the multi-process-safe equivalent of the helper
 *  C's Phase DAG branch will add as `findDeferringConflict`. The scheduler
 *  dispatch site (which C's branch will introduce) reads this; the
 *  `task_deferred_for_interference` event is emitted there, NOT here.
 *
 *  The query walks `directive_interference_edge` events both directions —
 *  `mutual_exclusion` is symmetric, so an edge `candidate → in_flight` or
 *  `in_flight → candidate` both deferring this candidate. `resource_conflict`
 *  is treated the same way: a shared resource is shared regardless of which
 *  side declared the edge first. */
export const findCrossDirectiveConflict = (
  db: Database,
  candidateDirectiveId: string,
): { conflicting_directive: string; interaction: string } | null => {
  const inFlight = inFlightDirectivesFromSql(db);
  // The candidate's own directive being in-flight doesn't count — only OTHER
  // in-flight directives produce a conflict.
  inFlight.delete(candidateDirectiveId);
  if (inFlight.size === 0) return null;

  const rows = db
    .query(
      `SELECT payload FROM events
       WHERE kind = 'directive_interference_edge'
       ORDER BY ts ASC`,
    )
    .all() as Array<{ payload: string }>;

  for (const r of rows) {
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(r.payload ?? "{}") as Record<string, unknown>;
    } catch {
      continue;
    }
    const from = payload.from_directive as string | undefined;
    const to = payload.to_directive as string | undefined;
    // Some emitters use `interaction`, others use `kind` (the InterferenceEdge
    // shape canonicalises both into `kind` on read, but here we read raw).
    const interaction =
      (payload.interaction as string | undefined) ??
      (payload.kind as string | undefined);
    if (!from || !to || !interaction) continue;
    if (!CROSS_DIRECTIVE_BLOCKING_INTERACTIONS.has(interaction)) continue;

    if (from === candidateDirectiveId && inFlight.has(to)) {
      return { conflicting_directive: to, interaction };
    }
    if (to === candidateDirectiveId && inFlight.has(from)) {
      return { conflicting_directive: from, interaction };
    }
  }
  return null;
};
