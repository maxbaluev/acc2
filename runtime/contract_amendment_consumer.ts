// acc2 contract amendment flywheel consumer — F11 (2026-05-18,
// contract 2AMJKN0GTX32790173EPYH6YT4). Closes the
// "flywheel persisted but unconsumed" gap (KC 88ESCTN8XN6J) by
// triaging unsettled contract_amendment_proposed rows BEFORE
// lifecycle_closure_sweep sees them as stuck. Per-proposal verdicts:
//
//   route_to_implementation — predicate is a concrete non-empty
//     string AND target_files is a non-empty array AND no open
//     dependency entries remain. Emits a synthetic task_node_opened
//     so the scheduler can pick it up and route via dispatch_decided.
//
//   route_to_clarification — predicate is missing/null OR
//     target_files is missing/empty. Emits owner_input_required
//     citing the proposal so the owner can supply the missing piece.
//
//   closure_obsolete (supersession) — a NEWER proposal exists for
//     the same target_resource (the view's supersession_state column).
//     Emits closure_obsolete on the OLDER proposal so the newer one
//     becomes the canonical live row.
//
//   closure_complete (redundancy) — an applied_change_committed row
//     exists for the same target_resource emitted AFTER the proposal,
//     citing a different amendment id. The change already shipped;
//     marking the proposal closure_complete prevents re-implementation.
//
// Idempotency: every verdict carries a deterministic projection key
// `f11_consumer_verdict:<proposal_id>` in payload AND the per-verdict
// kind. The scan skips proposals whose ledger already contains that
// projection key under the same verdict kind. Re-running on the same
// proposal is a structural no-op.
//
// REUSE-FIRST (KC 8265T7YM3S103E0DBFM7WP09D4): no new event kinds.
// Reuses contract_amendment_proposed, closure_complete,
// closure_obsolete, owner_input_required, applied_change_committed,
// task_node_opened, worker_tick_completed.

import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { JsonValue } from "../substrate/types";
import { emitEvent } from "./events";
import { newId } from "./ids";
import { pendingContractAmendments, type PendingContractAmendmentRow } from "../substrate/views";

type OutflowWrite = { source_event_id: string; task_id: string; path: string; resource_uri: string };
const OUTFLOW_EVENT_KINDS = ["applied_change_committed", "knowledge_promoted", "task_closure_audited", "closure_complete"] as const;
const outflowRoot = (): string => join(process.env.ACC2_STATE_DIR ?? join(homedir(), ".accint"), "outflow");
const eventScore = (payload: Record<string, unknown>): number => Number(payload.score ?? payload.promotion_score ?? payload.closure_residual ?? payload.residual);
const shouldWriteOutflow = (kind: string, payload: Record<string, unknown>): boolean => {
  if (kind === "knowledge_promoted") return payload.owner_readable === true && eventScore(payload) >= 0.75;
  if (kind === "task_closure_audited") return eventScore(payload) < 0.3;
  return true;
};
const conciseStatus = (kind: string, payload: Record<string, unknown>): string => String(payload.summary ?? payload.claim ?? payload.reason ?? kind).slice(0, 1200);
const writeOutflowArtifacts = (db: Database): OutflowWrite[] => {
  const rows = db.query<{ id: string; kind: string; task_id: string | null; payload: string }, []>(`SELECT id, kind, task_id, payload FROM events WHERE kind IN ('applied_change_committed','knowledge_promoted','task_closure_audited','closure_complete') AND task_id IS NOT NULL ORDER BY ts DESC LIMIT 200`).all();
  const root = outflowRoot();
  if (!existsSync(root)) mkdirSync(root, { recursive: true, mode: 0o700 });
  const writes: OutflowWrite[] = [];
  for (const row of rows) {
    let payload: Record<string, unknown> = {};
    try { payload = JSON.parse(row.payload ?? "{}"); } catch {}
    if (!row.task_id || !shouldWriteOutflow(row.kind, payload)) continue;
    const path = join(root, `${row.task_id}.md`);
    writeFileSync(path, `# Status\n\n${conciseStatus(row.kind, payload)}\n\n---\nledger_id: ${row.id}\nevent_kind: ${row.kind}\ntask_id: ${row.task_id}\noutflow_resource: outflow:${row.task_id}:md\n`, { mode: 0o600 });
    writes.push({ source_event_id: row.id, task_id: row.task_id, path, resource_uri: `outflow:${row.task_id}:md` });
  }
  return writes;
};

export type ConsumerVerdictKind =
  | "route_to_implementation"
  | "route_to_clarification"
  | "closure_obsolete_supersession"
  | "closure_complete_redundancy"
  | "noop_unscored"
  | "noop_dependencies_open"
  | "noop_already_settled";

export type ConsumerVerdict = {
  proposal_id: string;
  verdict: ConsumerVerdictKind;
  target_resource: string | null;
  reason: string;
  emitted_event_ids: string[];
};

export type ConsumerSummary = {
  scanned: number;
  emitted_count: number;
  route_to_implementation_count: number;
  route_to_clarification_count: number;
  closure_obsolete_count: number;
  closure_complete_count: number;
  noop_count: number;
  verdicts: ConsumerVerdict[];
  errors: string[];
};

export type ConsumerOptions = {
  /** Max proposals scanned per tick. Bounded so the worker can't starve
   *  normal dispatch under heavy backlog. Default 100. */
  maxRows?: number;
  /** Dry-run: compute verdicts but emit nothing. Used by the operator
   *  preview before pointing the worker at production. */
  dryRun?: boolean;
};

const VERDICT_KEY_PREFIX = "f11_consumer_verdict";

/** Build the deterministic projection key for a proposal+verdict pair.
 *  Used both as the payload field and as the LIKE-search anchor in the
 *  ledger to detect prior emissions. */
const projectionKey = (proposalId: string, verdict: ConsumerVerdictKind): string =>
  `${VERDICT_KEY_PREFIX}:${verdict}:${proposalId}`;

/** Has the consumer already emitted this exact (proposal, verdict) pair?
 *  Searches the events table for the projection_key string in payload.
 *  Sqlite's LIKE on the payload column is fast enough at our scale
 *  (proposals are O(thousands), not millions). */
const hasPriorEmission = (db: Database, proposalId: string, verdict: ConsumerVerdictKind): boolean => {
  const key = projectionKey(proposalId, verdict);
  const row = db
    .query<{ c: number }, [string]>(
      `SELECT COUNT(*) AS c FROM events
        WHERE payload LIKE ?`,
    )
    .get(`%${key}%`);
  return (row?.c ?? 0) > 0;
};

/** Are the proposal's declared dependencies all closed? A "dependency"
 *  shape in this codebase is either:
 *    - a string: the id of another contract_amendment_proposed event
 *      that must reach closure_complete / applied_change_committed
 *      before THIS one is implementable;
 *    - an object with `event_id` plus optional `kind` discriminator.
 *  Anything we don't understand we treat as open (fail-closed). When
 *  dependencies is null / empty array, there are no open dependencies
 *  and the proposal can route to implementation. */
const allDependenciesClosed = (db: Database, dependencies: unknown[] | null): boolean => {
  if (!dependencies || dependencies.length === 0) return true;
  for (const dep of dependencies) {
    const depId = typeof dep === "string"
      ? dep
      : (dep && typeof dep === "object" && typeof (dep as Record<string, unknown>).event_id === "string"
          ? ((dep as Record<string, unknown>).event_id as string)
          : null);
    if (!depId) return false;
    const row = db
      .query<{ c: number }, [string, string]>(
        `SELECT COUNT(*) AS c FROM events
          WHERE kind IN ('closure_complete', 'applied_change_committed')
            AND (id = ? OR context_refs LIKE ?)`,
      )
      .get(depId, `%${depId}%`);
    if ((row?.c ?? 0) === 0) return false;
  }
  return true;
};

/** Look for an applied_change_committed row that targets the same
 *  resource as the proposal AND was emitted AFTER the proposal ts
 *  AND cites a DIFFERENT proposal id. Returns the citing event id when
 *  redundancy is detected, null otherwise.
 *
 *  Bounded scan per KC GJ2KN1J3KD1Z (bounded amendments per worker —
 *  prevent event-loop starvation): the `applied_change_committed` table
 *  grows monotonically. A 280K-event ledger has thousands of apply rows;
 *  walking them all for every proposal in the triage loop blocked the
 *  Bun event loop. Cap at REDUNDANCY_SCAN_LIMIT=500 most-recent applies —
 *  the redundancy signal is most-relevant immediately after the proposal,
 *  and old applies that haven't been picked up by prior triage runs are
 *  already credited (idempotency via projection_key catches the rest). */
const REDUNDANCY_SCAN_LIMIT = 500;

const findRedundancyApply = (
  db: Database,
  proposalId: string,
  targetResource: string | null,
  proposalTs: string,
): string | null => {
  if (!targetResource) return null;
  // Pull recent applied_change_committed rows and check their payload
  // for matching target_resource. The set is small enough (apply events
  // are rare) that an in-memory filter is cheaper than a json_extract
  // index lookup at this scale.
  const rows = db
    .query<{ id: string; payload: string }, [string, number]>(
      `SELECT id, payload FROM events
        WHERE kind = 'applied_change_committed'
          AND ts > ?
        ORDER BY ts ASC
        LIMIT ?`,
    )
    .all(proposalTs, REDUNDANCY_SCAN_LIMIT);
  for (const row of rows) {
    try {
      const payload = JSON.parse(row.payload ?? "{}") as Record<string, unknown>;
      const tr = (payload.target_resource as string | undefined)
        ?? (payload.resource_uri as string | undefined);
      if (tr !== targetResource) continue;
      // Skip when the apply cites THIS proposal — that's the normal
      // completion path, not a redundancy.
      const sourceEventId = payload.source_event_id as string | undefined;
      if (sourceEventId === proposalId) continue;
      return row.id;
    } catch { /* malformed payload — skip row */ }
  }
  return null;
};

/** Build a synthetic task_node_opened payload for the implementation
 *  route. The scheduler will pick up the open task on its next tick
 *  and route it via dispatch_decided (claude_inline / opencode_brain
 *  per existing routing rules). */
const buildImplementationTaskPayload = (row: PendingContractAmendmentRow): JsonValue => {
  const proposed = (row.payload.proposed_behavior ?? {}) as Record<string, unknown>;
  const summary = (proposed.summary as string | undefined)
    ?? `Implement contract amendment ${row.proposal_id} for ${row.target_resource ?? "unspecified resource"}`;
  return {
    goal: summary,
    target_resource: row.target_resource,
    target_files: row.target_files ?? [],
    predicate: row.predicate ?? null,
    source_proposal_id: row.proposal_id,
    requires_deliverable: true,
    expected_outputs: [
      { kind: "applied_change_committed", source_event_id: row.proposal_id },
    ],
    [VERDICT_KEY_PREFIX]: projectionKey(row.proposal_id, "route_to_implementation"),
    reason: "f11_consumer_route_to_implementation",
  } as JsonValue;
};

const buildObsoletePayload = (row: PendingContractAmendmentRow): JsonValue => {
  return {
    source_kind: "contract_amendment_proposed",
    source_event_id: row.proposal_id,
    superseded_by: row.newer_proposal_id,
    target_resource: row.target_resource,
    [VERDICT_KEY_PREFIX]: projectionKey(row.proposal_id, "closure_obsolete_supersession"),
    reason: "f11_consumer_supersession",
  } as JsonValue;
};

const buildRedundancyPayload = (row: PendingContractAmendmentRow, applyEventId: string): JsonValue => {
  return {
    source_kind: "contract_amendment_proposed",
    source_event_id: row.proposal_id,
    resolving_event_id: applyEventId,
    resolution_kind: "applied_change_committed",
    target_resource: row.target_resource,
    [VERDICT_KEY_PREFIX]: projectionKey(row.proposal_id, "closure_complete_redundancy"),
    reason: "f11_consumer_redundancy_already_applied",
  } as JsonValue;
};

/** Triage one proposal row. Pure of side effects — returns the verdict
 *  the runner should act on, or null when the proposal is in a
 *  steady-state (dependencies still open, already-settled). */
const triage = (
  db: Database,
  row: PendingContractAmendmentRow,
): {
  verdict: ConsumerVerdictKind;
  payload?: JsonValue;
  emitKind?: "task_node_opened" | "owner_input_required" | "closure_obsolete" | "closure_complete";
  contextRefs?: string[];
  reason: string;
} => {
  // Supersession dominates other verdicts: if a newer proposal exists
  // for the same target_resource, the older one is obsolete regardless
  // of its predicate / target_files completeness.
  if (row.supersession_state === "superseded_by" && row.newer_proposal_id) {
    if (hasPriorEmission(db, row.proposal_id, "closure_obsolete_supersession")) {
      return { verdict: "noop_already_settled", reason: "supersession verdict already emitted" };
    }
    return {
      verdict: "closure_obsolete_supersession",
      payload: buildObsoletePayload(row),
      emitKind: "closure_obsolete",
      // Cite ONLY the older proposal in context_refs. The newer proposal
      // id is captured in payload.superseded_by; keeping it out of
      // context_refs prevents the view's `closure terminator cites
      // proposal_id` LIKE match from spuriously marking the newer
      // proposal as settled. The newer remains live until it itself is
      // implemented, superseded, or aged-out.
      contextRefs: [row.proposal_id],
      reason: `superseded by ${row.newer_proposal_id}`,
    };
  }

  // Redundancy: a different amendment shipped against the same
  // target_resource after this proposal — mark complete to drain.
  const redundantApplyId = findRedundancyApply(db, row.proposal_id, row.target_resource, row.ts);
  if (redundantApplyId) {
    if (hasPriorEmission(db, row.proposal_id, "closure_complete_redundancy")) {
      return { verdict: "noop_already_settled", reason: "redundancy verdict already emitted" };
    }
    return {
      verdict: "closure_complete_redundancy",
      payload: buildRedundancyPayload(row, redundantApplyId),
      emitKind: "closure_complete",
      // Only the proposal itself is cited so the view filter recognises
      // THIS proposal as settled without also masking the
      // applied_change_committed row that proved redundancy.
      contextRefs: [row.proposal_id],
      reason: `redundant; target already covered by ${redundantApplyId}`,
    };
  }

  // Dependencies still open: hold off, neither implement nor close.
  if (!allDependenciesClosed(db, row.dependencies)) {
    return { verdict: "noop_dependencies_open", reason: "one or more dependencies still open" };
  }

  // Universal implementation gate: the proposal is implementable only when
  // its latest action_scored evidence says residual < 0.3. Missing score is
  // an unscored backlog item, not an owner clarification about repo fields.
  if (row.triage_state === "unscored") {
    return { verdict: "noop_unscored", reason: "proposal has no action_scored residual yet" };
  }
  if (row.triage_state !== "ready_for_implementation") {
    return { verdict: "noop_dependencies_open", reason: row.triage_reason || "proposal is not implementation-ready" };
  }

  if (hasPriorEmission(db, row.proposal_id, "route_to_implementation")) {
    return { verdict: "noop_already_settled", reason: "implementation route already emitted" };
  }
  return {
    verdict: "route_to_implementation",
    payload: buildImplementationTaskPayload(row),
    emitKind: "task_node_opened",
    contextRefs: [row.proposal_id],
    reason: "latest verifier residual is below implementation threshold and dependencies are closed",
  };
};

/** Cooperative yield helper — releases the event loop so the daemon's
 *  /health route, the bridge SSE pumps, and other workers can run while
 *  this consumer walks a proposal backlog on a 280K-event ledger.
 *  Per substrate KC GJ2KN1J3KD1Z (bounded amendments per worker —
 *  event-loop starvation surfaced as wedged daemon in role=all). */
const yieldToEventLoop = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

/** Yield every 25 proposals matches the bounded-amendments cadence
 *  used by embedder / artifact_kind_backfill_worker. Each iteration
 *  runs hasPriorEmission (LIKE scan), findRedundancyApply (bounded to
 *  500 most-recent applies), and 0-2 emitEvent calls — non-trivial
 *  but bounded; yielding every 25 keeps the daemon /health sub-second
 *  even when the proposal backlog spans the full maxRows cap. */
const YIELD_INTERVAL_ROWS = 25;

/** Run the consumer once. The daemon's supervisedTick wrapper calls
 *  this on each interval. Idempotent: re-running on the same ledger
 *  state emits zero events.
 *
 *  Async per KC GJ2KN1J3KD1Z — yields the event loop every
 *  YIELD_INTERVAL_ROWS proposals.
 */
export const runContractAmendmentConsumer = async (
  db: Database,
  options: ConsumerOptions = {},
): Promise<ConsumerSummary> => {
  const maxRows = options.maxRows ?? 100;
  const dryRun = options.dryRun ?? false;
  const summary: ConsumerSummary = {
    scanned: 0,
    emitted_count: 0,
    route_to_implementation_count: 0,
    route_to_clarification_count: 0,
    closure_obsolete_count: 0,
    closure_complete_count: 0,
    noop_count: 0,
    verdicts: [],
    errors: [],
  };

  try {
    writeOutflowArtifacts(db);
  } catch (err) {
    summary.errors.push(`outflow_write_failed:${(err as Error).message}`);
  }

  let rows: PendingContractAmendmentRow[];
  try {
    rows = pendingContractAmendments(db, { limit: maxRows });
  } catch (err) {
    summary.errors.push(`scan_pending_failed:${(err as Error).message}`);
    return summary;
  }

  let processed = 0;
  for (const row of rows) {
    if (processed > 0 && processed % YIELD_INTERVAL_ROWS === 0) {
      await yieldToEventLoop();
    }
    processed += 1;
    summary.scanned++;
    let decision: ReturnType<typeof triage>;
    try {
      decision = triage(db, row);
    } catch (err) {
      summary.errors.push(`triage_failed:${row.proposal_id}:${(err as Error).message}`);
      continue;
    }

    // Update verdict counters before any emit so dryRun still reports
    // accurate totals.
    if (decision.verdict === "route_to_implementation") summary.route_to_implementation_count++;
    else if (decision.verdict === "route_to_clarification") summary.route_to_clarification_count++;
    else if (decision.verdict === "closure_obsolete_supersession") summary.closure_obsolete_count++;
    else if (decision.verdict === "closure_complete_redundancy") summary.closure_complete_count++;
    else summary.noop_count++;

    const emittedEventIds: string[] = [];
    if (!dryRun && decision.emitKind && decision.payload) {
      try {
        if (decision.emitKind === "task_node_opened") {
          // Mint a fresh task id so the synthetic node has its own
          // claim slot; the scheduler will pair it with a refines edge
          // to the proposal's directive on the next tick.
          const newTaskId = newId();
          const emitted = emitEvent(db, {
            kind: "task_node_opened",
            substrate_origin: "substrate_auto",
            directive_id: row.directive_id ?? undefined,
            task_id: newTaskId,
            context_refs: decision.contextRefs,
            payload: decision.payload,
          });
          emittedEventIds.push(emitted.id);
        } else {
          const emitted = emitEvent(db, {
            kind: decision.emitKind,
            substrate_origin: "substrate_auto",
            directive_id: row.directive_id ?? undefined,
            task_id: row.task_id ?? undefined,
            context_refs: decision.contextRefs,
            payload: decision.payload,
          });
          emittedEventIds.push(emitted.id);
        }
        summary.emitted_count++;
      } catch (err) {
        summary.errors.push(`emit_${decision.emitKind}_failed:${row.proposal_id}:${(err as Error).message}`);
      }
    }

    summary.verdicts.push({
      proposal_id: row.proposal_id,
      verdict: decision.verdict,
      target_resource: row.target_resource,
      reason: decision.reason,
      emitted_event_ids: emittedEventIds,
    });
  }

  return summary;
};
