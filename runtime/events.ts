// acc2 event emission helper — single INSERT path so daemon, MCP, ingress,
// and tests all write rows the same way. Mirrors the Event type shape from
// substrate/types.ts but accepts a partial; we fill required slots with
// sane defaults (loop_id falls back to "loop_root" before the DAG layer
// is wired in Phase D).

import type { Database } from "bun:sqlite";
import type { Event, EventKind, JsonValue, SubstrateOrigin } from "../substrate/types";
import { EVENT_KINDS, getCurrentEventKinds } from "../substrate/event_kinds";
import { newId, nowIso } from "./ids";
import { decompositionDescendantTaskIds } from "./task_descendants";
import { publishEvent } from "./event_bus";
import { publishActivation } from "./activation_bus";
import { recordEventEmission } from "./metrics";
import { screenActArtifactCandidate } from "./artifact_candidate_screen";
import {
  PostCommitProjectionQueue,
  type PostCommitProjectionTask,
} from "./post_commit_projection_queue";
import { withImmediateTransaction } from "../substrate/db";

// ── Non-blocking post-commit projection cascade ──────────────────────────
// (directive NHY908W0EX5Q72KGWXMASPFEY0, amendment B0DVM2APWX, 2026-05-24).
//
// emitEvent INSERTs the row + fires the synchronous bus/activation
// notification, then returns its {id, ts} ack the moment the row is durable
// (durability-before-ack). Every HEAVY post-insert projection branch is
// enqueued onto this single bounded FIFO queue instead of running on the MCP
// handler's call stack. The queue drains in event-loop-yielding slices, so a
// heavy write cascade can no longer monopolize the loop past the MCP client
// deadline. See runtime/post_commit_projection_queue.ts for the full
// deadlock-safety contract (durability-before-ack / no-dropped-events /
// fire-once watchdog / bounded backpressure).
//
// The queue's overflow + watchdog sinks emit through emitEvent itself. They
// are wired lazily (the queue module cannot import events.ts — that is a
// cycle) and stamped projectActTuple:false so the diagnostic emit does not
// itself spawn an act_tuple cascade. The sink db is captured from the first
// enqueue's db handle (the daemon uses a single shared Database).
let postCommitQueueDb: Database | null = null;
const postCommitQueue = new PostCommitProjectionQueue(undefined, {
  onOverflow: ({ droppedLabel, droppedEventId, queueDepth, cap }) => {
    if (!postCommitQueueDb) return;
    try {
      emitEvent(postCommitQueueDb, {
        kind: "post_commit_projection_overflow",
        substrate_origin: "substrate_auto",
        projectActTuple: false,
        payload: {
          dropped_kind: droppedLabel,
          dropped_event_id: droppedEventId,
          queue_depth: queueDepth,
          cap,
        },
      });
    } catch { /* fail-soft: overflow signal is best-effort */ }
  },
  onWatchdog: ({ watchdogId, queueDepth, lastDrainedSeq, hungForMs }) => {
    if (!postCommitQueueDb) return;
    try {
      emitEvent(postCommitQueueDb, {
        kind: "mcp_operation_watchdog_fired",
        substrate_origin: "substrate_auto",
        projectActTuple: false,
        payload: {
          watchdog_id: watchdogId,
          queue_depth: queueDepth,
          last_drained_seq: lastDrainedSeq,
          hung_for_ms: hungForMs,
        },
      });
    } catch { /* fail-soft: watchdog signal is best-effort */ }
  },
});

/** Enqueue one deferred projection branch onto the bounded post-commit
 *  queue. Captures the db handle for the queue's sink emits. Drops (with a
 *  loud overflow event) only when the bounded cap is hit — the durable
 *  source row already landed. */
const enqueuePostCommitProjection = (db: Database, task: PostCommitProjectionTask): void => {
  postCommitQueueDb = db;
  postCommitQueue.enqueue(task);
};

/** Test/diagnostic surface: drain the post-commit queue to empty. Tests that
 *  assert a projection landed call this after emitEvent returns its ack. */
export const flushPostCommitProjectionsForTest = async (): Promise<void> => {
  await postCommitQueue.flushForTest();
};

/** Test/diagnostic surface: hard-reset the post-commit queue between cases.
 *  The queue is a process-lived singleton; without a reset a prior test's
 *  un-drained deferred tasks (which captured a now-closed db) would bleed
 *  into the next test when it drains. Wire into beforeEach. */
export const resetPostCommitProjectionsForTest = (): void => {
  postCommitQueue.resetForTest();
  postCommitQueueDb = null;
};

/** Test/diagnostic: current pending depth of the post-commit queue. */
export const postCommitProjectionDepth = (): number => postCommitQueue.depth();

/** Empty-blob sentinel (maps to SQLite X'') written to the `embedding`
 *  column for non-embeddable event kinds at INSERT time. Keeps the
 *  `embedding IS NULL` partial index (idx_events_unembedded_by_ts)
 *  matching ONLY genuinely-pending embeddable rows — see the
 *  foundational-fix comment at the INSERT site in emitEvent. The
 *  embedder's no-text path uses the identical X'' marker, so vec_events
 *  (vec0) never receives these rows. */
const EMPTY_EMBEDDING_SENTINEL = new Uint8Array(0);

export type EmitEventInput = {
  kind: EventKind;
  substrate_origin?: SubstrateOrigin;
  directive_id?: string;
  task_id?: string;
  parent_task_id?: string | null;
  loop_id?: string;
  payload?: JsonValue;
  context_refs?: string[];
  predicted_residual?: number;
  action_artifact_id?: string;
  verifier_artifact_id?: string;
  outcome?: Event["outcome"];
  residual?: number;
  payload_hash?: string;
  blob_ref?: string;
  failure_kind?: Event["failure_kind"];
  invoker?: SubstrateOrigin;
  /** Internal recursion guard for substrate-side source-event projectors. */
  projectActTuple?: boolean;
  /** Raw float32 little-endian bytes of the embedding vector. The events
   *  table BLOB column accepts this directly. Set ONLY by the embedder
   *  worker — most call sites leave it undefined. */
  embedding?: Uint8Array;
  /** Embedding model/version stamp. Stored alongside the BLOB so the
   *  reranker can exclude mixed-version sets (Architecture risk 16). */
  embedding_version?: string;
};

export type EmittedEvent = { id: string; ts: string };

type JsonObject = { [k: string]: JsonValue };

const updateEventRollups = (db: Database, row: { kind: string; ts: string; substrate_origin: string }): void => {
  const day = row.ts.slice(0, 10);
  db.run(
    `INSERT INTO event_kind_rollup (kind, total_count, live_count, first_ts, last_ts)
     VALUES (?, 1, 1, ?, ?)
     ON CONFLICT(kind) DO UPDATE SET
       total_count = total_count + 1,
       live_count = live_count + 1,
       first_ts = CASE WHEN excluded.first_ts < first_ts THEN excluded.first_ts ELSE first_ts END,
       last_ts = CASE WHEN excluded.last_ts > last_ts THEN excluded.last_ts ELSE last_ts END`,
    [row.kind, row.ts, row.ts],
  );
  db.run(
    `INSERT INTO event_day_kind_rollup (day, kind, total_count, live_count, first_ts, last_ts)
     VALUES (?, ?, 1, 1, ?, ?)
     ON CONFLICT(day, kind) DO UPDATE SET
       total_count = total_count + 1,
       live_count = live_count + 1,
       first_ts = CASE WHEN excluded.first_ts < first_ts THEN excluded.first_ts ELSE first_ts END,
       last_ts = CASE WHEN excluded.last_ts > last_ts THEN excluded.last_ts ELSE last_ts END`,
    [day, row.kind, row.ts, row.ts],
  );
  db.run(
    `INSERT OR IGNORE INTO event_kind_origin_rollup (kind, substrate_origin) VALUES (?, ?)`,
    [row.kind, row.substrate_origin],
  );
};

type NormalizedActTuple = {
  intent: string;
  reasoning_summary: string;
  effect_summary: string;
  verifier_kind: string;
  predicted_residual: number;
  observed_residual: number;
  action_artifact_id: string;
  verifier_artifact_id: string;
  outcome: Event["outcome"];
  source_act_id?: string;
  /** Original source event id (lesson_extracted /
   *  contract_amendment_proposed / etc.) that this act applies. When the
   *  apply lifecycle is projected from act_tuple_recorded, the projected
   *  action_predicted / action_scored / candidate_confirmed /
   *  applied_change_committed rows carry this id in payload.source_event_id
   *  so lesson_implementation_status_view can join by the original
   *  proposal id rather than the act-tuple id. Brain amendment
   *  7D4VK9EYJX63V0K2WD40VXT5WG (FINDING 4). */
  source_event_id?: string;
  cited_knowledge_ids: string[];
  cited_artifact_ids: string[];
  affected_resources: string[];
  candidate_event_ids: string[];
  co_actors: string[];
  owner_observed_outcome?: JsonValue;
};

const isObject = (value: JsonValue | undefined): value is JsonObject =>
  !!value && typeof value === "object" && !Array.isArray(value);

const hasStructuredFailureClassification = (payload: JsonObject | null): boolean => {
  if (!payload) return false;
  if (typeof payload.failure_kind === "string" && payload.failure_kind.trim().length > 0) return true;
  const source = payload.classification_source;
  return !!source && typeof source === "object" && !Array.isArray(source);
};

const normalizeTaskFailedPayload = (input: EmitEventInput): { payload: JsonValue; failure_kind?: string } => {
  const payload = isObject(input.payload) ? input.payload : {};
  const explicitFailureKind = input.failure_kind ?? (typeof payload.failure_kind === "string" && payload.failure_kind.trim().length > 0
    ? payload.failure_kind.trim()
    : undefined);
  if (explicitFailureKind || hasStructuredFailureClassification(payload)) {
    return { payload, failure_kind: explicitFailureKind };
  }
  return {
    payload: {
      ...payload,
      classification_source: {
        source: "runtime.emitEvent",
        basis: "task_failed_without_emitter_failure_kind",
        note: "Emitter did not provide a failure_kind; classification remains open-ended and should be refined by the producing runtime.",
      },
    },
  };
};

/** Closure-audit normalization (parallel to task_failed). When the brain
 *  emits task_closure_audited without a numeric closure_residual, the
 *  TUI renders `closure_residual=undefined` which is meaningless — and
 *  downstream credit/scoring code coerces undefined→NaN. Inject a
 *  classification_source marker so the substrate retains the provenance
 *  while the renderer + downstream consumers can detect "unmeasured"
 *  vs "measured zero". */
const normalizeClosureAuditPayload = (input: EmitEventInput): JsonValue => {
  const payload = isObject(input.payload) ? input.payload : {};
  const residual = payload.closure_residual;
  const hasNumericResidual = typeof residual === "number" && Number.isFinite(residual);
  const hasSource = !!payload.classification_source && typeof payload.classification_source === "object";
  if (hasNumericResidual || hasSource) return payload;
  return {
    ...payload,
    classification_source: {
      source: "runtime.emitEvent",
      basis: "task_closure_audited_without_numeric_residual",
      note: "Emitter did not provide a numeric closure_residual; the closure verifier should refine this. Renderers should treat residual as <unset>.",
    },
  };
};

/** T0.1 substrate-truth gate at the closure-audit emit boundary.
 *
 *  Brain dispatch TFZ6AJXNPS6655QMFWT6KPB3QM, amendment
 *  ZC7HF4Y3HN1BK91FXVQE77S4GC. Commit 177b4e7 landed verifyClosureAudit
 *  as a callable gate but did NOT wire it at the emit boundary —
 *  brain-emitted task_closure_audited rows still slipped through the
 *  substrate without independent verification. This hook closes that
 *  trust gap.
 *
 *  Trigger shape (T0.1 payload): a task_closure_audited input carries
 *  `closure_predicate` (with optional `target_files`). `checks` may ride
 *  along as structure once the predicate opts the row into the T0.1
 *  substrate-verified closure contract, but checks alone do not modernize
 *  a legacy row.
 *
 *  Legacy emit shapes without closure_predicate — including numeric-only
 *  residuals and covered_sub_tasks/uncovered_aspects rows — preserve their
 *  pre-T0.1 path unchanged. This keeps historical self-reported residuals
 *  verbatim while tightening only closures that declare what they are
 *  closing against.
 *
 *  When triggered:
 *   - Call verifyClosureAudit(db, …) with the brain-declared predicate,
 *     checks, and asserted residual.
 *   - Replace the eventPayload with the augmented shape (brain_claims,
 *     substrate_verifications, discrepancies, asserted_residual,
 *     substrate-derived closure_residual).
 *   - When the hard precondition refuses (target_files declared +
 *     asserted_residual < 0.3 + zero matching contract_amendment_proposed),
 *     verifyClosureAudit emits closure_blocked_no_amendments as a sibling
 *     event AND bumps the augmented payload's closure_residual to 1.0.
 *
 *  Returns null when the input is NOT a T0.1-shape payload — the caller
 *  falls back to normalizeClosureAuditPayload's legacy path. */
const runClosureAuditTruthGate = (db: Database, input: EmitEventInput): JsonValue | null => {
  const payload = isObject(input.payload) ? input.payload : null;
  if (!payload) return null;
  const closurePredicate = isObject(payload.closure_predicate) ? payload.closure_predicate : null;
  const checks = isObject(payload.checks) ? payload.checks : null;
  // T0.1 shape requires closure_predicate. Legacy rows without predicate
  // (including plain closure_residual, covered_sub_tasks/uncovered_aspects,
  // or checks-only payloads) fall through unchanged.
  if (!closurePredicate) return null;
  // verifyClosureAudit needs a directive_id — without it the substrate
  // cannot scope the contract_amendment_proposed SELECT. Skip the gate
  // when missing; the legacy normalizer still adds the classification
  // marker for unmeasured-residual rows.
  if (!input.directive_id) return null;

  const assertedResidualRaw = payload.closure_residual;
  const assertedResidual = typeof assertedResidualRaw === "number" && Number.isFinite(assertedResidualRaw)
    ? assertedResidualRaw
    : 0.5; // open-ended fallback when the brain emits checks without a number

  // Brain-claim coercion: payload.checks may carry non-boolean values
  // (the brain's own enum strings). The gate accepts booleans only;
  // non-boolean entries land in discrepancies via the fail-closed path
  // inside verifyClosureAudit. We project here so the type narrows.
  const brainClaims: Record<string, boolean> = {};
  if (checks) {
    for (const [name, value] of Object.entries(checks)) {
      if (typeof value === "boolean") brainClaims[name] = value;
    }
  }

  // Predicate target_files extraction (the only field the gate's hard
  // precondition reads). Other predicate fields ride along on the
  // augmented payload via verifyClosureAudit's `closure_predicate`
  // passthrough.
  const targetFilesRaw = closurePredicate && Array.isArray(closurePredicate.target_files)
    ? closurePredicate.target_files
    : [];
  const targetFiles = targetFilesRaw.filter((s): s is string => typeof s === "string");

  // Preserve every payload field the gate does not own so historical
  // readers see the same shape (k_204 save richness). closure_predicate,
  // brain_claims, substrate_verifications, asserted_residual,
  // closure_residual, and discrepancies are stamped by verifyClosureAudit.
  const legacyFields: Record<string, unknown> = { ...payload };
  delete legacyFields.closure_residual;
  delete legacyFields.closure_predicate;
  delete legacyFields.brain_claims;
  delete legacyFields.substrate_verifications;
  delete legacyFields.discrepancies;
  delete legacyFields.asserted_residual;
  delete legacyFields.checks;

  // Lazy import to avoid the cyclic-import edge case at module load:
  // closure_audit.ts already imports emitEvent from events.ts; the
  // reverse-direction static import resolves under Bun but lazy keeps
  // the boundary explicit.
  const { verifyClosureAudit } = require("./closure_audit") as typeof import("./closure_audit");
  const result = verifyClosureAudit(db, {
    directive_id: input.directive_id,
    task_id: input.task_id,
    closure_predicate: closurePredicate
      ? { ...closurePredicate, target_files: targetFiles }
      : (targetFiles.length > 0 ? { target_files: targetFiles } : undefined),
    brain_claims: brainClaims,
    asserted_residual: assertedResidual,
    // Raw check count (boolean + non-boolean) so the gate can fail-closed
    // when the brain emitted checks the substrate couldn't verify as
    // booleans — instead of silently falling back to the asserted residual
    // (the 0.08-with-0/6-checks leniency bug).
    raw_claim_count: checks ? Object.keys(checks).length : 0,
    legacy_fields: legacyFields,
  });
  // Project brain_claims back onto `checks` for legacy renderers that
  // branch on payload.checks (cli/observe.ts, experience compression).
  // verifyClosureAudit returns brain_claims under the new key — we add
  // a checks mirror so the row remains backward-readable.
  const augmented: Record<string, unknown> = { ...result.payload };
  if (Object.keys(brainClaims).length > 0) augmented.checks = brainClaims;
  return augmented as JsonValue;
};

/** Dispatcher-violation classification gate (Hole 6 — 2026-05-19).
 *
 *  Pre-fix evidence: 21 production dispatcher_violation events had
 *  failure_kind=NULL — silent failures the substrate could not classify.
 *  Operator-side audits joining by failure_kind lost ~4% of failures to
 *  NULL. The gate at the emit boundary defaults a missing classification
 *  to "unclassified_emit_bug" AND stamps payload.classification_source =
 *  "default_unclassified" so audits surface the gap rather than silently
 *  accepting NULL. The default must NEVER replace an emitter-provided
 *  classification — when failure_kind is set on the input column OR
 *  inside payload.failure_kind, that classification stands.
 *
 *  Idempotency: when an emitter already classified the violation (via
 *  input.failure_kind or payload.failure_kind), the function returns the
 *  payload untouched. Re-emits with the same shape are no-ops. */
const normalizeDispatcherViolationPayload = (input: EmitEventInput): { payload: JsonValue; failure_kind: string } => {
  const payload = isObject(input.payload) ? input.payload : {};
  const explicitFailureKind = typeof input.failure_kind === "string" && input.failure_kind.trim().length > 0
    ? input.failure_kind.trim()
    : (typeof payload.failure_kind === "string" && payload.failure_kind.trim().length > 0
      ? payload.failure_kind.trim()
      : null);
  const payloadViolation = typeof payload.violation === "string" && payload.violation.trim().length > 0
    ? payload.violation.trim()
    : (typeof payload.kind === "string" && payload.kind.trim().length > 0
      ? payload.kind.trim()
      : null);
  const failure_kind = explicitFailureKind ?? payloadViolation ?? "unclassified_emit_bug";
  const reason = typeof payload.reason === "string" && payload.reason.trim().length > 0
    ? payload.reason.trim()
    : (failure_kind === "unclassified_emit_bug"
      ? "Emitter did not provide failure_kind, payload.failure_kind, payload.violation, or payload.kind; substrate defaulted to unclassified_emit_bug at the emit boundary so audits surface the gap."
      : `Dispatcher violation classified as ${failure_kind}; emitter did not provide payload.reason.`);
  const augmented: Record<string, unknown> = {
    ...payload,
    violation: typeof payload.violation === "string" && payload.violation.trim().length > 0 ? payload.violation.trim() : failure_kind,
    reason,
    directive_id: input.directive_id ?? (typeof payload.directive_id === "string" ? payload.directive_id : null),
    task_id: input.task_id ?? (typeof payload.task_id === "string" ? payload.task_id : null),
  };
  if (typeof payload.dispatch_id === "string" && payload.dispatch_id.trim().length > 0) {
    augmented.dispatch_id = payload.dispatch_id.trim();
  }
  if (explicitFailureKind) {
    return { payload: augmented as JsonValue, failure_kind };
  }
  return {
    payload: {
      ...augmented,
      classification_source: "default_unclassified",
      classification_default_note: "emitter did not provide failure_kind; substrate defaulted to unclassified_emit_bug at the emit boundary so audits surface the gap. Cite Hole 6 (2026-05-19) — 21 historical NULL rows.",
    },
    failure_kind,
  };
};

/** action_scored normalization (null-action_artifact_id lift gate).
 *
 *  Brain lesson TA4X4Q36XH38789BWQMV2AYB3W identified 102 historical
 *  action_scored events with action_artifact_id IS NULL — the dominant
 *  pattern was peer-LLM reviews (verifier_kind ∈ {peer_llm_claude,
 *  peer_llm_claude_diagnostic, peer_llm_opencode,
 *  peer_llm_opencode_diagnostic, peer_llm_opencode_adversarial_review,
 *  peer_llm_opencode_inline_catalog_completeness_check,
 *  peer_llm_opencode_manual_requirement_check,
 *  peer_llm_opencode_structural_check, ...}) emitted by a peer to
 *  score OTHER actors' work without a registered action artifact. These
 *  bypass artifact-credit because the canonical action_artifact_id is
 *  null.
 *
 *  The substrate-truth gate at the projection boundary:
 *    1) action_artifact_id present  → preserve (no lift, no violation).
 *    2) action_artifact_id null AND verifier_kind set
 *       → lift verifier_kind as action_artifact_id, AND emit a sibling
 *         dispatcher_violation kind "null_action_artifact_id_lifted" so
 *         the upstream emit-site bug stays visible for follow-up.
 *    3) BOTH null
 *       → emit dispatcher_violation kind "null_action_artifact_id_unresolvable"
 *         and REFUSE the projection (no action_scored row created).
 *
 *  Idempotency: if verifier_kind already equals input.action_artifact_id,
 *  no lift happens and no violation fires (case 1 above). */
type ActionScoredLiftResult =
  | { verdict: "preserved"; action_artifact_id: string | undefined }
  | { verdict: "lifted"; action_artifact_id: string; lifted_to: string; original_action_artifact_id: null }
  | { verdict: "unresolvable" };

const normalizeActionScoredPayload = (input: EmitEventInput): ActionScoredLiftResult => {
  const payload = isObject(input.payload) ? input.payload : null;
  const inputActionId = typeof input.action_artifact_id === "string" && input.action_artifact_id.trim().length > 0
    ? input.action_artifact_id.trim()
    : null;
  // Fall back to payload.action_artifact_id only when the input column
  // is null — direct emits sometimes carry it nested in payload.
  const payloadActionId = payload && typeof payload.action_artifact_id === "string" && payload.action_artifact_id.trim().length > 0
    ? payload.action_artifact_id.trim()
    : null;
  const resolvedActionId = inputActionId ?? payloadActionId;
  if (resolvedActionId) {
    return { verdict: "preserved", action_artifact_id: resolvedActionId };
  }
  const verifierKind = payload && typeof payload.verifier_kind === "string" && payload.verifier_kind.trim().length > 0
    ? payload.verifier_kind.trim()
    : null;
  if (verifierKind) {
    return {
      verdict: "lifted",
      action_artifact_id: verifierKind,
      lifted_to: verifierKind,
      original_action_artifact_id: null,
    };
  }
  return { verdict: "unresolvable" };
};

/** Emit a lifted action_scored row plus a sibling dispatcher_violation.
 *  The action_scored row is emitted via emitEvent recursion — because the
 *  caller has already populated input.action_artifact_id, the lift gate
 *  inside emitEvent classifies the recursive call as "preserved" and
 *  falls through to the normal INSERT path. The sibling violation
 *  references the scored id in context_refs so audits can correlate the
 *  lift back to its source row. */
const emitActionScoredWithLift = (
  db: Database,
  liftedInput: EmitEventInput,
  liftedTo: string,
): EmittedEvent => {
  // Recursive emitEvent — because liftedInput.action_artifact_id is now
  // populated, normalizeActionScoredPayload returns "preserved" on this
  // pass and the call falls through to the normal INSERT path.
  const scored = emitEvent(db, liftedInput);
  emitEvent(db, {
    kind: "dispatcher_violation",
    substrate_origin: "substrate_auto",
    directive_id: liftedInput.directive_id,
    task_id: liftedInput.task_id,
    parent_task_id: liftedInput.parent_task_id ?? null,
    loop_id: liftedInput.loop_id,
    context_refs: [scored.id, ...(liftedInput.context_refs ?? [])],
    failure_kind: "null_action_artifact_id_lifted",
    payload: {
      source_kind: "action_scored",
      source_event_id: scored.id,
      original_action_artifact_id: null,
      lifted_to: liftedTo,
      verifier_kind: liftedTo,
      substrate_origin: liftedInput.substrate_origin ?? "substrate_auto",
      note: "action_scored emitted with action_artifact_id=null; substrate lifted payload.verifier_kind as the canonical action_artifact_id at the projection boundary. Upstream emitter should pass a registered handle. Cite brain lesson TA4X4Q36XH38789BWQMV2AYB3W.",
    },
  });
  return scored;
};

/** Auto-admit unseen verifier_kinds at the action_scored projection
 *  boundary (brain EH5A37DPHX0GSCJKBSRNZDX700, 2026-05-19).
 *
 *  Companion to commit d84618d's lift gate (which sets
 *  action_artifact_id = verifier_kind verbatim). When an action_scored
 *  carries a verifier_kind whose canonical name has NO matching
 *  act_artifact row, the substrate creates a kind="verifier" row with a
 *  neutral Beta(1,1) prior (score=0.5, confidence=0.5) so credit accrues
 *  on every subsequent action_scored. Emits verifier_kind_auto_admitted
 *  for operator audit.
 *
 *  Idempotency: this runs INSIDE emitEvent. The recursive lift path calls
 *  emitEvent twice for one logical action_scored — once with
 *  action_artifact_id=null (which falls into the lift branch and never
 *  reaches the INSERT) and once with the lifted handle (which DOES reach
 *  the INSERT). We anchor auto-admit on the action_artifact_id-populated
 *  pass so it fires exactly once per logical event. SELECT-before-INSERT
 *  also makes repeated emissions of the same verifier_kind no-op the
 *  second time onward.
 *
 *  peer_llm_opencode_* collapse rule: variants store
 *  parent_kind=peer_llm_opencode, variant_tag, rollup=true as METADATA.
 *  Credit pipeline still routes to payload.verifier_kind directly; a
 *  follow-up verifier_rollup_evaluator worker will route variants to the
 *  parent until promotion criteria are met (≥3 obs, ≥2 directives, OR
 *  residual diverges by ≥ 0.20). */
/** File/test-style refs (containing ':' or '#', e.g. "repo:test-fixture",
 *  "runtime/events.ts#L1") are inline fixtures, NOT registry handles —
 *  they must never be auto-admitted as creditable act_artifact rows. */
const looksLikeFixtureRef = (id: string): boolean => id.includes(":") || id.includes("#");

const VERIFIER_AUTO_ADMIT_SANDBOX = JSON.stringify({
  runtime: "bun",
  substrate_access: "rw",
  cpu_ms: 5000,
  wall_ms: 10000,
  memory_mb: 64,
  fs_read: [],
  fs_write: [],
  net_allow: [],
  proc_allow: [],
});

const maybeAutoAdmitVerifierKind = (
  db: Database,
  input: EmitEventInput,
  sourceEventId: string,
): void => {
  if (input.kind !== "action_scored") return;
  const payload = isObject(input.payload) ? input.payload : null;
  if (!payload) return;
  const verifierKind = typeof payload.verifier_kind === "string" && payload.verifier_kind.trim().length > 0
    ? payload.verifier_kind.trim()
    : null;
  if (!verifierKind) return;
  // File/test-style refs are inline fixtures, never registry handles —
  // do not admit them as creditable rows (phase-2 four-link skip rule).
  if (looksLikeFixtureRef(verifierKind)) return;
  // Auto-admit hooks on the INSERT pass — the action_artifact_id column
  // is populated (either originally or post-lift). Skip pre-lift passes
  // where the column is still null; they will recurse with the lifted
  // handle.
  const resolvedActionId = typeof input.action_artifact_id === "string" && input.action_artifact_id.trim().length > 0
    ? input.action_artifact_id.trim()
    : (typeof payload.action_artifact_id === "string" && payload.action_artifact_id.trim().length > 0
      ? payload.action_artifact_id.trim()
      : null);
  if (!resolvedActionId) return;
  // Idempotent: do nothing when the canonical row already exists.
  const existing = db
    .query<{ id: string }, [string]>("SELECT id FROM act_artifact WHERE id = ? LIMIT 1")
    .get(verifierKind);
  if (existing) return;
  // peer_llm_<hemisphere>_* variant detection (metadata-only collapse rule).
  let parentKind: string | null = null;
  let variantTag: string | null = null;
  let rollup = false;
  const peerVariantMatch = verifierKind.match(/^peer_llm_([^_]+)_(.+)$/);
  if (peerVariantMatch) {
    parentKind = `peer_llm_${peerVariantMatch[1]}`;
    variantTag = peerVariantMatch[2];
    rollup = true;
  }
  const ts = nowIso();
  // Decide which admissions are needed in this first-observation. Two
  // distinct ids can become registered from one action_scored event:
  //   (a) the verifier_kind category (e.g., "peer_llm_opencode")
  //   (b) the specific verifier_artifact_id handle (e.g.,
  //       "future_citation_utility", "opencode_inline_a1_audit_check")
  // Both are admitted as separate act_artifact rows (so credit can flow
  // to either id), but ONE audit event consolidates the admissions so
  // the operator sees a single first-observation row, not duplicates.
  const verifierArtifactId = typeof input.verifier_artifact_id === "string" && input.verifier_artifact_id.trim().length > 0
    ? input.verifier_artifact_id.trim()
    : null;
  const handleNeedsAdmit = verifierArtifactId !== null
    && verifierArtifactId !== verifierKind
    && !looksLikeFixtureRef(verifierArtifactId)
    && !db
      .query<{ id: string }, [string]>("SELECT id FROM act_artifact WHERE id = ? LIMIT 1")
      .get(verifierArtifactId);

  const insertVerifier = (
    id: string,
    role: "category" | "specific_verifier_handle",
    extraFixture: Record<string, unknown>,
  ): void => {
    const body = `Auto-admitted verifier (${role}) — first observed in action_scored event ${sourceEventId}. Created by runtime/events.ts auto-admit gate${role === "category" && parentKind ? `; parent_kind=${parentKind}, variant_tag=${variantTag}` : ""}.`;
    const fixtureInput = JSON.stringify({
      admission_source: role === "category" ? "action_scored_projection" : "action_scored_projection_verifier_handle",
      first_observed_action_scored_event_id: sourceEventId,
      role,
      ...extraFixture,
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
        VERIFIER_AUTO_ADMIT_SANDBOX,
        `substrate/auto_admit/${role === "category" ? "verifier" : "verifier_handle"}/${id}`,
        "verifier",
        1.0,
        1.0,
        0.5,
        0.5,
        0.0,
        0,
        "admitted",
        id,
        fixtureInput,
        0.5,
        ts,
        ts,
      ],
    );
  };

  const admissions: Array<{ act_artifact_id: string; role: "category" | "specific_verifier_handle" }> = [];

  insertVerifier(verifierKind, "category", { parent_kind: parentKind, variant_tag: variantTag, rollup });
  admissions.push({ act_artifact_id: verifierKind, role: "category" });

  if (handleNeedsAdmit) {
    insertVerifier(verifierArtifactId!, "specific_verifier_handle", { verifier_kind: verifierKind });
    admissions.push({ act_artifact_id: verifierArtifactId!, role: "specific_verifier_handle" });
  }

  // ONE audit event per logical first-observation. Payload describes all
  // admissions in this gate-firing, not one event per admitted row.
  emitEvent(db, {
    kind: "verifier_kind_auto_admitted",
    substrate_origin: "substrate_auto",
    directive_id: input.directive_id,
    task_id: input.task_id,
    parent_task_id: input.parent_task_id ?? null,
    loop_id: input.loop_id,
    context_refs: [sourceEventId, ...(input.context_refs ?? [])],
    payload: {
      verifier_kind: verifierKind,
      // For backwards-compat audits: top-level act_artifact_id mirrors the
      // category admission. The full list is in `admissions`.
      act_artifact_id: verifierKind,
      admissions,
      source_action_scored_event_id: sourceEventId,
      parent_kind: parentKind,
      variant_tag: variantTag,
      rollup,
      promotion_criteria: {
        min_observations: 3,
        min_directives: 2,
        residual_delta_from_parent: 0.20,
      },
    },
  });
};

/** Lesson-extracted normalization. Same shape as task_failed: when
 *  lesson_kind is missing, surface it as a classification_source so the
 *  tail/observability layer doesn't render `lesson_kind=?` (which the
 *  operator reads as "the substrate doesn't know what kind of lesson
 *  this is"). The producing brain or worker should refine. */
const normalizeLessonExtractedPayload = (input: EmitEventInput): JsonValue => {
  const payload = isObject(input.payload) ? input.payload : {};
  const lessonKind = payload.lesson_kind;
  const hasKind = typeof lessonKind === "string" && lessonKind.trim().length > 0;
  const hasSource = !!payload.classification_source && typeof payload.classification_source === "object";
  if (hasKind) return payload;
  return {
    ...payload,
    lesson_kind: "unclassified",
    ...(hasSource ? {} : {
      classification_source: {
        source: "runtime.emitEvent",
        basis: "lesson_extracted_without_lesson_kind",
        note: "Emitter did not provide a lesson_kind; defaulted to unclassified and should be refined by the producing runtime.",
      },
    }),
  };
};

const projectionKey = (sourceActId: string, projectionKind: string, targetIdOrRole: string): string =>
  sourceActId + ":" + projectionKind + ":" + targetIdOrRole;

const existingProjection = (db: Database, kind: EventKind, key: string): EmittedEvent | null => {
  const row = db
    .query<{ id: string; ts: string }, [string, string]>(
      "SELECT id, ts FROM events WHERE kind = ? AND json_extract(payload, '$.projection_key') = ? ORDER BY ts ASC LIMIT 1",
    )
    .get(kind, key);
  return row ? { id: row.id, ts: row.ts } : null;
};

type RootCommitBlocker = { reason: "missing_clean_closure_audit" | "nonterminal_descendants"; closure_audit_event_id: string | null; closure_residual: number | null; nonterminal_descendant_task_ids: string[] };
const rootTaskCommitBlocker = (db: Database, taskId: string): RootCommitBlocker | null => {
  const root = db.query(`SELECT 1 FROM events WHERE kind = 'task_node_opened' AND task_id = ? AND parent_task_id IS NULL LIMIT 1`).get(taskId) as { 1: number } | null;
  if (!root) return null;
  // Decomposition descendants only (parent_task_id chain) — see the rationale in
  // runtime/task_descendants.ts (requires/refines deliberately do NOT gate
  // commit). Shared with directive_closure via that cycle-free module.
  const descendants = new Set(decompositionDescendantTaskIds(db, taskId));
  if (descendants.size === 0) return null;
  const audit = db.query(`SELECT id, residual, payload FROM events WHERE kind = 'task_closure_audited' AND task_id = ? ORDER BY ts DESC, rowid DESC LIMIT 1`).get(taskId) as { id: string; residual: number | null; payload: string } | null;
  let closureResidual: number | null = null;
  if (audit) { try { const p = JSON.parse(audit.payload ?? '{}') as { closure_residual?: unknown }; closureResidual = typeof p.closure_residual === 'number' && Number.isFinite(p.closure_residual) ? p.closure_residual : typeof audit.residual === 'number' && Number.isFinite(audit.residual) ? audit.residual : null; } catch { closureResidual = typeof audit.residual === 'number' && Number.isFinite(audit.residual) ? audit.residual : null; } }
  if (closureResidual === null || closureResidual >= 0.3) return { reason: "missing_clean_closure_audit", closure_audit_event_id: audit?.id ?? null, closure_residual: closureResidual, nonterminal_descendant_task_ids: [] };
  const nonterminal: string[] = [];
  for (const descendant of descendants) { const terminal = db.query(`SELECT 1 FROM events WHERE task_id = ? AND kind IN ('task_committed', 'task_failed', 'task_abandoned', 'task_committed_superseded') LIMIT 1`).get(descendant) as { 1: number } | null; if (!terminal) nonterminal.push(descendant); }
  return nonterminal.length > 0 ? { reason: "nonterminal_descendants", closure_audit_event_id: audit?.id ?? null, closure_residual: closureResidual, nonterminal_descendant_task_ids: nonterminal } : null;
};

const emitProjectedEvent = (
  db: Database,
  sourceActId: string,
  projectionKind: string,
  targetIdOrRole: string,
  input: EmitEventInput,
): EmittedEvent => {
  const key = projectionKey(sourceActId, projectionKind, targetIdOrRole);
  const existing = existingProjection(db, input.kind, key);
  if (existing) return existing;
  const payload = isObject(input.payload) ? input.payload : {};
  return emitEvent(db, {
    ...input,
    payload: {
      ...payload,
      projection_key: key,
    },
  });
};

const requireString = (payload: JsonObject, key: string): string => {
  const value = payload[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("invalid_act_tuple_recorded:" + key + "_required");
  }
  return value;
};

const optionalStringArray = (payload: JsonObject, key: string): string[] => {
  const value = payload[key];
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim().length === 0)) {
    throw new Error("invalid_act_tuple_recorded:" + key + "_must_be_string_array");
  }
  // Runtime check above narrows every element to a non-empty string,
  // but TypeScript can't carry the narrowing through Array's structural
  // type. Cast is safe — every escape path throws.
  return value as string[];
};

const requireResidual = (value: unknown, key: string): number => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error("invalid_act_tuple_recorded:" + key + "_must_be_number_0_1");
  }
  return value;
};

const isBridgeExitArtifactPair = (actionArtifactId: string, verifierArtifactId: string): boolean =>
  actionArtifactId === "opencode_brain_exit_action" && verifierArtifactId === "opencode_bridge_exit_verifier";

const appendUniqueString = (items: string[], item: string): void => {
  if (!items.includes(item)) items.push(item);
};

/** Lazy registry admission for act-tuple artifact handles (phase-2,
 *  four-link credit completion).
 *
 *  Autonomous audit finding: of 14 distinct verifier_artifact_id values
 *  cited in act_tuple_recorded events, 10 were SEMANTIC NAMES never
 *  admitted as act_artifact rows (lane_match_verifier,
 *  owner_observed_completeness, future_failure_prevention_rate, …).
 *  Because the named handle has no row, the credit projector
 *  (runtime/credit.ts) takes the synthetic-actuator branch and SKIPS the
 *  posterior update — link 4 (credit) has nothing to mutate, so the
 *  substrate never learns which verifiers are reliable (k_555 four-link:
 *  create → retrieve → use → credit).
 *
 *  Fix: when an act tuple references an action_artifact_id /
 *  verifier_artifact_id that is NOT yet an act_artifact row, lazily admit
 *  a minimal cold-start row (Beta(1,1): score=0.5, confidence=0.5,
 *  runtime=null so it stays retrievable as a registry handle, not a
 *  runnable executor) so subsequent outcome credit completes the chain.
 *
 *  Idempotent: existence-guarded + `INSERT OR IGNORE`. Existing rows are
 *  untouched (posteriors preserved). Re-projecting the same act tuple on
 *  replay/retry is a clean no-op.
 *
 *  Skip rule: ids that look like file/test fixtures (contain ':' or '#',
 *  e.g. "repo:test-fixture", "runtime/events.ts#L1") are inline
 *  references, NOT registry handles — they must never be admitted as
 *  creditable rows. The bridge-exit synthetic pair is also skipped (it is
 *  deliberately not auto-bound or credited). */
const ACT_TUPLE_LAZY_ADMIT_SANDBOX = JSON.stringify({
  runtime: "bun",
  substrate_access: "rw",
  cpu_ms: 5000,
  wall_ms: 10000,
  memory_mb: 64,
  fs_read: [],
  fs_write: [],
  net_allow: [],
  proc_allow: [],
});

const lazilyAdmitActTupleArtifacts = (
  db: Database,
  args: { actionArtifactId: string; verifierArtifactId: string; sourceEventId: string },
): void => {
  // The bridge-exit synthetic pair is intentionally never credited — do
  // not manufacture creditable rows for it.
  if (isBridgeExitArtifactPair(args.actionArtifactId, args.verifierArtifactId)) return;
  const ts = nowIso();
  const targets: Array<{ id: string; kind: "action" | "verifier" }> = [
    { id: args.actionArtifactId, kind: "action" },
    { id: args.verifierArtifactId, kind: "verifier" },
  ];
  for (const { id, kind } of targets) {
    if (!id || id.trim().length === 0) continue;
    // File/test-style refs are inline fixtures, not registry handles.
    if (looksLikeFixtureRef(id)) continue;
    // Idempotent: leave any existing row (and its accumulated posterior)
    // untouched. INSERT OR IGNORE is a second guard against same-ms races.
    const existing = db
      .query<{ id: string }, [string]>("SELECT id FROM act_artifact WHERE id = ? LIMIT 1")
      .get(id);
    if (existing) continue;
    const body = `Lazily-admitted ${kind} handle — first observed in act_tuple_recorded event ${args.sourceEventId}. Created by runtime/events.ts act-tuple lazy-admission gate so credit can accrue (k_555 four-link). Audit: 10/14 verifier handles were unregistered.`;
    const fixtureInput = JSON.stringify({
      admission_source: "act_tuple_projection",
      role: kind,
      first_observed_act_tuple_event_id: args.sourceEventId,
    });
    db.run(
      `INSERT OR IGNORE INTO act_artifact (
         id, runtime, body, declared_sandbox, state_root, kind,
         posterior_alpha, posterior_beta, score, confidence,
         recent_residual_mean, recent_kill_count, status, name,
         fixture_input, fixture_expected_residual,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        null, // runtime=null: retrievable registry handle, not a runnable executor
        body,
        ACT_TUPLE_LAZY_ADMIT_SANDBOX,
        `substrate/auto_admit/act_tuple/${kind}/${id}`,
        kind,
        1.0,
        1.0,
        0.5,
        0.5,
        0.0,
        0,
        "admitted",
        id,
        fixtureInput,
        0.5,
        ts,
        ts,
      ],
    );
  }
};

const normalizeActTuple = (input: EmitEventInput): NormalizedActTuple => {
  if (!isObject(input.payload)) throw new Error("invalid_act_tuple_recorded:payload_object_required");
  const payload = input.payload;
  const predicted = requireResidual(input.predicted_residual ?? payload.predicted_residual, "predicted_residual");
  const observed = requireResidual(input.residual ?? payload.observed_residual ?? payload.residual, "observed_residual");
  const actionArtifact = input.action_artifact_id ?? (typeof payload.action_artifact_id === "string" ? payload.action_artifact_id : undefined);
  const verifierArtifact = input.verifier_artifact_id ?? (typeof payload.verifier_artifact_id === "string" ? payload.verifier_artifact_id : undefined);
  if (!actionArtifact) throw new Error("invalid_act_tuple_recorded:action_artifact_id_required");
  if (!verifierArtifact) throw new Error("invalid_act_tuple_recorded:verifier_artifact_id_required");
  const outcome = input.outcome ?? (observed < 0.3 ? "succeeded" : "failed");
  if (outcome !== "succeeded" && outcome !== "failed" && outcome !== "pending" && outcome !== "abandoned" && outcome !== "rolling_active" && outcome !== "amended") {
    throw new Error("invalid_act_tuple_recorded:outcome_invalid");
  }
  const logicalSourceActId = typeof payload.source_act_id === "string" && payload.source_act_id.trim().length > 0
    ? payload.source_act_id.trim()
    : undefined;
  // Path-A FINDING-4 amendment 7D4VK9EYJX63V0K2WD40VXT5WG: when the
  // act_tuple represents an apply lifecycle (cli/apply.ts), extract
  // payload.source_event_id so the projection chain carries the
  // original proposal id (lesson_extracted / contract_amendment_proposed)
  // through to the projected action_predicted / action_scored /
  // candidate_confirmed / applied_change_committed payloads. Without
  // this, lesson_implementation_status_view can't join the projected
  // rows back to the original proposal id.
  const sourceEventId = typeof payload.source_event_id === "string" && payload.source_event_id.trim().length > 0
    ? payload.source_event_id.trim()
    : undefined;
  const citedArtifactIds = optionalStringArray(payload, "cited_artifact_ids");
  if (!isBridgeExitArtifactPair(actionArtifact, verifierArtifact)) {
    appendUniqueString(citedArtifactIds, actionArtifact);
    appendUniqueString(citedArtifactIds, verifierArtifact);
  }
  return {
    intent: requireString(payload, "intent"),
    reasoning_summary: requireString(payload, "reasoning_summary"),
    effect_summary: requireString(payload, "effect_summary"),
    verifier_kind: requireString(payload, "verifier_kind"),
    predicted_residual: predicted,
    observed_residual: observed,
    action_artifact_id: actionArtifact,
    verifier_artifact_id: verifierArtifact,
    outcome,
    source_act_id: logicalSourceActId,
    source_event_id: sourceEventId,
    cited_knowledge_ids: optionalStringArray(payload, "cited_knowledge_ids"),
    cited_artifact_ids: citedArtifactIds,
    affected_resources: optionalStringArray(payload, "affected_resources"),
    candidate_event_ids: optionalStringArray(payload, "candidate_event_ids"),
    co_actors: optionalStringArray(payload, "co_actors"),
    owner_observed_outcome: payload.owner_observed_outcome,
  };
};

const projectActTupleRecorded = (db: Database, source: {
  id: string;
  directive_id: string;
  task_id: string;
  parent_task_id: string | null;
  loop_id: string;
  context_refs: string[];
  act: NormalizedActTuple;
}): { predicted: EmittedEvent; scored: EmittedEvent } => {
  const sourceActId = source.act.source_act_id ?? source.id;
  const sourceEventId = source.id;
  const sourceRefs = sourceActId === sourceEventId ? [sourceEventId] : [sourceEventId, sourceActId];
  // Phase-2 four-link credit completion: admit any unregistered
  // action/verifier handle as a minimal creditable row BEFORE the credit
  // projector runs on the projected action_scored row, so link 4 has a
  // posterior to mutate (k_555). Idempotent; file/test refs skipped.
  lazilyAdmitActTupleArtifacts(db, {
    actionArtifactId: source.act.action_artifact_id,
    verifierArtifactId: source.act.verifier_artifact_id,
    sourceEventId,
  });
  const base = {
    directive_id: source.directive_id,
    task_id: source.task_id,
    parent_task_id: source.parent_task_id,
    loop_id: source.loop_id,
    substrate_origin: "substrate_auto" as const,
    projectActTuple: false,
  };
  const bindings: EmittedEvent[] = [];
  for (const [role, ids] of [
    ["knowledge", source.act.cited_knowledge_ids],
    ["artifact", source.act.cited_artifact_ids],
  ] as const) {
    for (let rank = 0; rank < ids.length; rank++) {
      const targetId = ids[rank]!;
      bindings.push(emitProjectedEvent(db, sourceActId, "retrieval_binding", role + ":" + targetId, {
        ...base,
        kind: "retrieval_binding",
        context_refs: [...sourceRefs, targetId],
        payload: {
          source_act_id: sourceActId,
          source_act_event_id: sourceEventId,
          projected_from: "act_tuple_recorded",
          ...(role === "knowledge" ? { source_event_id: targetId } : { source_artifact_id: targetId }),
          rank,
          binding_surface: "act_tuple_projection",
          co_actors: source.act.co_actors,
          cited_role: role,
        },
      }));
    }
  }
  const projectedContext = [...sourceRefs, ...bindings.map((binding) => binding.id), ...source.context_refs];
  // Path-A FINDING-4: surface the original proposal id on every
  // projected payload so lesson_implementation_status_view can join
  // by it. Empty spread when not provided keeps the payload shape
  // unchanged for non-apply act_tuples (internal decision acts etc.).
  const originalProposalId = source.act.source_event_id;
  const predicted = emitProjectedEvent(db, sourceActId, "action_predicted", "primary", {
    ...base,
    kind: "action_predicted",
    action_artifact_id: source.act.action_artifact_id,
    verifier_artifact_id: source.act.verifier_artifact_id,
    predicted_residual: source.act.predicted_residual,
    context_refs: projectedContext,
    payload: {
      source_act_id: sourceActId,
      source_act_event_id: sourceEventId,
      ...(originalProposalId ? { source_event_id: originalProposalId } : {}),
      projected_from: "act_tuple_recorded",
      intent: source.act.intent,
      reasoning_summary: source.act.reasoning_summary,
      effect_summary: source.act.effect_summary,
      verifier_kind: source.act.verifier_kind,
      cited_knowledge_ids: source.act.cited_knowledge_ids,
      cited_artifact_ids: source.act.cited_artifact_ids,
      co_actors: source.act.co_actors,
      affected_resources: source.act.affected_resources,
    },
  });
  const scored = emitProjectedEvent(db, sourceActId, "action_scored", "primary", {
    ...base,
    kind: "action_scored",
    action_artifact_id: source.act.action_artifact_id,
    verifier_artifact_id: source.act.verifier_artifact_id,
    predicted_residual: source.act.predicted_residual,
    residual: source.act.observed_residual,
    outcome: source.act.outcome,
    context_refs: [...sourceRefs, predicted.id, ...source.context_refs],
    payload: {
      source_act_id: sourceActId,
      source_act_event_id: sourceEventId,
      ...(originalProposalId ? { source_event_id: originalProposalId } : {}),
      action_predicted_event_id: predicted.id,
      projected_from: "act_tuple_recorded",
      verifier_kind: source.act.verifier_kind,
      co_actors: source.act.co_actors,
      residual: source.act.observed_residual,
      // OutcomeStatus | undefined → coerce to null. JsonValue forbids
      // undefined; passing it through would silently omit the field
      // from JSON.stringify and break audit-trail completeness.
      outcome: source.act.outcome ?? null,
    },
  });
  const confirmationTargets = source.act.candidate_event_ids.length > 0
    ? source.act.candidate_event_ids.map((candidateId) => ({ candidateId, projectionTarget: candidateId }))
    : [{ candidateId: sourceEventId, projectionTarget: "source" }];
  for (const { candidateId, projectionTarget } of confirmationTargets) {
    emitProjectedEvent(db, sourceActId, "candidate_confirmed", projectionTarget, {
      ...base,
      kind: "candidate_confirmed",
      context_refs: [candidateId, ...sourceRefs, scored.id],
      payload: {
        source_act_id: sourceActId,
        source_act_event_id: sourceEventId,
        ...(originalProposalId ? { source_event_id: originalProposalId } : {}),
        action_scored_event_id: scored.id,
        projected_from: "act_tuple_recorded",
        reason: "act_tuple_lifecycle_projection",
      },
    });
  }
  // Phantom-apply gate: skip applied_change_committed projection when
  // the source act is the bridge-cycle EXIT boundary, not a real
  // mutation. Pre-fix every opencode brain cycle wrote an
  // applied_change_committed event with summary="bridge_completed
  // final_response_chars=N" and affected_resources=[] — operator
  // dashboards saw "Δ✓ applied" on every brain cycle while working
  // tree never moved, and substrate audit envelopes were vacuous (cite
  // KC H3PXSDV32X47: auto_apply worker writes phantom rows; this is
  // the substrate-side closure). The discriminator is precise:
  // bridge-exit acts use the fixed artifact-id pair
  // (opencode_brain_exit_action, opencode_bridge_exit_verifier).
  // Legitimate non-mutation acts (owner-credit, observation, research)
  // with empty affected_resources still project — they aren't bridge
  // closures.
  const isBridgeExitAct = source.act.action_artifact_id === "opencode_brain_exit_action"
    && source.act.verifier_artifact_id === "opencode_bridge_exit_verifier";
  const correlatedFailure = db
    .query<{ c: number }, [string, string, string, string]>(
      `SELECT COUNT(*) AS c FROM events
       WHERE kind IN ('dispatcher_violation', 'error_caught', 'task_failed')
         AND (json_extract(payload, '$.source_act_id') = ?
           OR json_extract(payload, '$.source_act_event_id') = ?
           OR EXISTS (SELECT 1 FROM json_each(context_refs) WHERE value = ?)
           OR EXISTS (SELECT 1 FROM json_each(context_refs) WHERE value = ?))`,
    )
    .get(sourceActId, sourceEventId, sourceActId, sourceEventId);
  const appliedStatus = (correlatedFailure?.c ?? 0) > 0 ? "failed" : "applied";
  if (!isBridgeExitAct) emitProjectedEvent(db, sourceActId, "applied_change_committed", "primary", {
    ...base,
    kind: "applied_change_committed",
    action_artifact_id: source.act.action_artifact_id,
    verifier_artifact_id: source.act.verifier_artifact_id,
    predicted_residual: source.act.predicted_residual,
    residual: source.act.observed_residual,
    outcome: source.act.outcome,
    context_refs: [...sourceRefs, predicted.id, scored.id, ...source.context_refs],
    payload: {
      source_act_id: sourceActId,
      source_act_event_id: sourceEventId,
      ...(originalProposalId ? { source_event_id: originalProposalId } : {}),
      action_predicted_event_id: predicted.id,
      action_scored_event_id: scored.id,
      projected_from: "act_tuple_recorded",
      status: appliedStatus,
      source_kind: "act_tuple_recorded",
      summary: source.act.effect_summary,
      co_actors: source.act.co_actors,
      affected_resources: source.act.affected_resources,
    },
  });
  if (source.act.owner_observed_outcome !== undefined) {
    emitProjectedEvent(db, sourceActId, "owner_observed_outcome_recorded", "primary", {
      ...base,
      kind: "owner_observed_outcome_recorded",
      residual: source.act.observed_residual,
      outcome: source.act.outcome,
      context_refs: [...sourceRefs, scored.id],
      payload: {
        source_act_id: sourceActId,
        source_act_event_id: sourceEventId,
        action_scored_event_id: scored.id,
        projected_from: "act_tuple_recorded",
        observed_outcome: source.act.owner_observed_outcome,
      },
    });
  }
  return { predicted, scored };
};
/** Insert a single event row and return its id + timestamp. The caller owns
 *  selecting `substrate_origin` — daemon events use `substrate_auto`, MCP
 *  RPC events tag the actual invoker, external-push tags `owner` etc. */
export const emitEvent = (db: Database, input: EmitEventInput): EmittedEvent => {
  // Brain convergence audit boxbz1d1q axis I (2026-05-15): the substrate.emit
  // MCP handler rejects unknown event kinds at the wire boundary, but
  // daemon-side workers writing through this helper could persist any
  // string cast to EventKind. Apply the same gate so the rule is uniform
  // — typos in worker code surface as a thrown error instead of silently
  // landing in the ledger and bypassing embedding / health-metric / view
  // routing.
  //
  // Test bypass: the test suite uses synthetic `*_test_*` kinds (catalogued
  // in substrate/event_kinds.test.ts TEST_ONLY_KINDS) to exercise the bus
  // surface without polluting the production registry. We accept those
  // under the convention plus the explicit ACC2_BRIDGE_MODE=mock env that
  // tests/preload.ts pins. Production daemon (no env, no `*_test_*` kind)
  // gets the strict gate.
  // Hot-reload (2026-05-17): consult the live cachedKinds map through
  // getCurrentEventKinds() so kinds registered after a substrate/event_kinds.ts
  // swap (via runtime/reloadable.ts) become valid without a daemon restart.
  // Importing EVENT_KINDS captures the value at module-load time; that
  // binding cannot be updated, but getCurrentEventKinds() reads the
  // mutable cache the reloadable slot swaps.
  if (!(input.kind in getCurrentEventKinds())) {
    const isTestKind = typeof input.kind === "string" && input.kind.includes("_test_");
    const isTestMode = process.env.ACC2_BRIDGE_MODE === "mock" || process.env.NODE_ENV === "test";
    if (!isTestKind && !isTestMode) {
      throw new Error(
        `unknown_event_kind:${input.kind}; register it in substrate/event_kinds.ts EVENT_KINDS before emitting`,
      );
    }
  }
  // SINGLE-TERMINAL-PER-TASK GATE (FOUNDATIONAL FIX 2026-05-17):
  // Live ledger evidence — task A5G7ZPNQV13634WX received BOTH task_committed
  // (from brain via MCP) at 03:36:51 AND task_failed (from dispatcher
  // refinement-depth-cap via direct emitEvent) at 03:36:57. Two competing
  // terminal events for the same task is a substrate-integrity violation:
  // dispatch_resolved_view classification, closure scoring, credit
  // distribution, and supervisor logic all assume at most one terminal
  // per task. The gate refuses the SECOND terminal emit when a first is
  // already in the ledger. First-wins semantics — whichever code path
  // reached the substrate first claims the outcome; subsequent emits get
  // a structured refusal (thrown, since this is a substrate invariant).
  const actTuple = input.kind === "act_tuple_recorded" ? normalizeActTuple(input) : null;

  const projectionPayload = isObject(input.payload) ? input.payload : null;
  const inputProjectionKey = typeof projectionPayload?.projection_key === "string" ? projectionPayload.projection_key : null;
  if (inputProjectionKey) {
    const existing = existingProjection(db, input.kind, inputProjectionKey);
    if (existing) return existing;
  }
  if (input.kind === "task_committed" && input.task_id) {
    const blocker = rootTaskCommitBlocker(db, input.task_id);
    if (blocker) {
      return emitEvent(db, { kind: "dispatcher_violation", substrate_origin: "substrate_auto", directive_id: input.directive_id, task_id: input.task_id, parent_task_id: input.parent_task_id ?? null, loop_id: input.loop_id, context_refs: input.context_refs ?? [], failure_kind: "root_commit_blocked", payload: { source_kind: "task_committed", refused_reason: blocker.reason, closure_audit_event_id: blocker.closure_audit_event_id, closure_residual: blocker.closure_residual, nonterminal_descendant_task_ids: blocker.nonterminal_descendant_task_ids, note: "Root task_committed refused: roots with descendants require a current task_closure_audited residual < 0.3 and terminal descendants." } });
    }
  }
  if (input.kind === "task_committed" || input.kind === "task_failed") {
    if (input.task_id) {
      const existing = db
        .query<{ kind: string; id: string }, [string]>(
          `SELECT id, kind FROM events
           WHERE task_id = ? AND kind IN ('task_committed', 'task_failed')
           ORDER BY ts ASC LIMIT 1`,
        )
        .get(input.task_id);
      if (existing) {
        // Idempotent re-emit of the SAME terminal kind is allowed (returns
        // the existing event's id+ts so callers' downstream wiring still
        // resolves). Conflicting terminal (other kind) is REFUSED to
        // preserve the substrate invariant.
        if (existing.kind === input.kind) {
          const existingTs = db
            .query<{ ts: string }, [string]>(`SELECT ts FROM events WHERE id = ?`)
            .get(existing.id);
          return { id: existing.id, ts: existingTs?.ts ?? "" };
        }
        // Test bypass: same env discipline as the kind gate above so
        // existing test fixtures that intentionally emit conflicting
        // terminals (testing edge-case classifiers) still work.
        const isTestMode = process.env.ACC2_BRIDGE_MODE === "mock" || process.env.NODE_ENV === "test";
        if (!isTestMode) {
          throw new Error(
            `terminal_event_conflict:task=${input.task_id};existing=${existing.kind} (id=${existing.id});refused_emit=${input.kind};hint=a task can have at most one terminal event. First-wins semantics — the existing ${existing.kind} stands. If the dispatcher/worker emitting this competing terminal needs to record a non-terminal observation (e.g. refinement-depth concern, late-arriving residual), use a non-terminal kind like dispatcher_violation or knowledge_candidate instead.`,
          );
        }
      }
    }
  }
  // action_scored null-id lift gate (brain lesson TA4X4Q36XH38789BWQMV2AYB3W).
  // Runs BEFORE id minting + INSERT so the unresolvable refusal short-
  // circuits without leaving a half-formed row. The gate is idempotent:
  // when input.action_artifact_id is already populated, lift returns
  // "preserved" and no sibling dispatcher_violation fires.
  if (input.kind === "action_scored") {
    const lift = normalizeActionScoredPayload(input);
    if (lift.verdict === "unresolvable") {
      const violation = emitEvent(db, {
        kind: "dispatcher_violation",
        substrate_origin: "substrate_auto",
        directive_id: input.directive_id,
        task_id: input.task_id,
        parent_task_id: input.parent_task_id ?? null,
        loop_id: input.loop_id,
        context_refs: input.context_refs ?? [],
        failure_kind: "null_action_artifact_id_unresolvable",
        payload: {
          source_kind: "action_scored",
          original_action_artifact_id: null,
          verifier_kind: null,
          substrate_origin: input.substrate_origin ?? "substrate_auto",
          note: "action_scored refused at projection boundary: both action_artifact_id and payload.verifier_kind are null/empty — no canonical handle to lift. Cite brain lesson TA4X4Q36XH38789BWQMV2AYB3W.",
        },
      });
      return violation;
    }
    if (lift.verdict === "lifted") {
      // Mutate the input so the rest of emitEvent (INSERT, bus publish,
      // downstream credit hooks) sees the lifted handle uniformly.
      // Sibling dispatcher_violation is emitted AFTER the action_scored
      // row so its context_refs can point at the scored id; emitted
      // pre-insert here as a deferred call after we have the id.
      const liftedInput = { ...input, action_artifact_id: lift.action_artifact_id };
      // Lifted handle also lands in payload so downstream readers that
      // walk payload.action_artifact_id (not just the column) see it.
      const liftedPayload: JsonObject = isObject(input.payload) ? { ...input.payload } : {};
      liftedPayload.action_artifact_id = lift.action_artifact_id;
      liftedPayload.action_artifact_id_lifted_from_verifier_kind = true;
      liftedInput.payload = liftedPayload;
      const result = emitActionScoredWithLift(db, liftedInput, lift.lifted_to);
      return result;
    }
  }

  const id = newId();
  const ts = nowIso();
  const directive_id = input.directive_id ?? id; // self-rooted if not supplied
  const task_id = input.task_id ?? id;
  const loop_id = input.loop_id ?? "loop_root";
  const substrate_origin = input.substrate_origin ?? "substrate_auto";
  const taskFailure = input.kind === "task_failed" ? normalizeTaskFailedPayload(input) : null;
  // Closure-audit + lesson-extracted normalization run at the same
  // emit boundary so missing classifier fields surface as a structured
  // classification_source (NOT as renderer "undefined" / "?" — see
  // cli/observe.ts task_closure_audited + lesson_extracted renderers).
  // Closure-audit emit path runs the T0.1 substrate-truth gate FIRST
  // (when the payload declares a closure_predicate or checks map), then
  // falls back to the legacy classification_source normalizer when the
  // T0.1 shape is absent. The gate may emit a sibling
  // closure_blocked_no_amendments event before this row's INSERT so the
  // refusal lands on the timeline ahead of the augmented closure_audited
  // row it modifies.
  const closurePayload = input.kind === "task_closure_audited"
    ? (runClosureAuditTruthGate(db, input) ?? normalizeClosureAuditPayload(input))
    : null;
  const lessonPayload = input.kind === "lesson_extracted" ? normalizeLessonExtractedPayload(input) : null;
  // Dispatcher-violation classification gate (Hole 6 — 2026-05-19). Default
  // missing failure_kind to "unclassified_emit_bug" + stamp payload
  // classification_source so audits joining by failure_kind never silently
  // skip NULL rows. Emitter-provided classifications stand untouched.
  const dispatcherViolation = input.kind === "dispatcher_violation" ? normalizeDispatcherViolationPayload(input) : null;
  const eventPayload = taskFailure?.payload
    ?? closurePayload
    ?? lessonPayload
    ?? dispatcherViolation?.payload
    ?? input.payload
    ?? {};
  const eventFailureKind = taskFailure?.failure_kind
    ?? dispatcherViolation?.failure_kind
    ?? input.failure_kind;
  const payload = JSON.stringify(eventPayload);
  const context_refs = JSON.stringify(input.context_refs ?? []);

  // FOUNDATIONAL embedding-scan fix (2026-05-21): non-embeddable kinds
  // get the empty-blob sentinel (X'') at INSERT time instead of NULL.
  // Root cause this fixed: 286,204 rows had `embedding IS NULL` because
  // they were non-embeddable kinds (worker_tick_completed,
  // candidate_confirmed, origin_calibration_recorded, etc.) that the
  // embedder filters OUT of its scan (`kind IN (EMBEDDABLE_KINDS)`) and
  // therefore NEVER sentinel-marks. They accumulated forever, bloating
  // the `idx_events_unembedded_by_ts ... WHERE embedding IS NULL` partial
  // index to 286K entries. Every embedder reactive fire (minReactiveGapMs:0
  // = fires on every embeddable event) ran pendingEmbeddableCount + a scan
  // against that bloated index, pinning the daemon main thread at 98% CPU
  // with a REAL embeddable backlog of ZERO. Stamping the sentinel here
  // keeps `embedding IS NULL` matching ONLY genuinely-pending embeddable
  // rows, so the partial index stays small and the scans stay O(few).
  // Embeddable kinds keep NULL (caller's input.embedding wins when the
  // embedder back-fills the real vector). The empty Uint8Array maps to
  // SQLite X'' — same sentinel the embedder's no-text path already uses.
  const kindMeta = getCurrentEventKinds()[input.kind];
  const isEmbeddableKind = kindMeta?.embeddable === true;
  const embeddingValue = input.embedding ?? (isEmbeddableKind ? null : EMPTY_EMBEDDING_SENTINEL);

  // Atomicity (bounded-ledger-retention safety-a): the durable event row and
  // its retained per-kind aggregate must commit together so the rollup can
  // never drift from a real COUNT(*) over events. Wrapping the INSERT + the
  // three rollup UPSERTs in one BEGIN IMMEDIATE keeps them a single commit;
  // the ack still fires durability-before-bus-publish. emitEvent is never
  // called inside an outer withImmediateTransaction, so no nesting hazard.
  const insertEventAndRollup = (): void => {
    db.run(
      `INSERT INTO events (
         id, ts, directive_id, task_id, parent_task_id, loop_id,
         substrate_origin, kind, payload, context_refs,
         predicted_residual, action_artifact_id, verifier_artifact_id,
         outcome, residual, embedding, embedding_version,
         payload_hash, blob_ref, failure_kind, invoker
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id, ts, directive_id, task_id, input.parent_task_id ?? null, loop_id,
        substrate_origin, input.kind, payload, context_refs,
        input.predicted_residual ?? null,
        input.action_artifact_id ?? null,
        input.verifier_artifact_id ?? null,
        input.outcome ?? null,
        input.residual ?? null,
        embeddingValue,
        input.embedding_version ?? null,
        input.payload_hash ?? null,
        input.blob_ref ?? null,
        eventFailureKind ?? null,
        input.invoker ?? null,
      ],
    );
    updateEventRollups(db, { kind: input.kind, ts, substrate_origin });
  };
  try {
    withImmediateTransaction(db, insertEventAndRollup);
  } catch {
    // Pre-rollup DBs (older schema, mid-migration) may lack the rollup
    // tables; the append-only event must still land durably. Fall back to a
    // bare INSERT — the next ensureEventRollupTables backfill reconciles
    // live_count from a real COUNT(*), so the aggregate self-heals.
    db.run(
      `INSERT INTO events (
         id, ts, directive_id, task_id, parent_task_id, loop_id,
         substrate_origin, kind, payload, context_refs,
         predicted_residual, action_artifact_id, verifier_artifact_id,
         outcome, residual, embedding, embedding_version,
         payload_hash, blob_ref, failure_kind, invoker
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id, ts, directive_id, task_id, input.parent_task_id ?? null, loop_id,
        substrate_origin, input.kind, payload, context_refs,
        input.predicted_residual ?? null,
        input.action_artifact_id ?? null,
        input.verifier_artifact_id ?? null,
        input.outcome ?? null,
        input.residual ?? null,
        embeddingValue,
        input.embedding_version ?? null,
        input.payload_hash ?? null,
        input.blob_ref ?? null,
        eventFailureKind ?? null,
        input.invoker ?? null,
      ],
    );
  }
  // Phase 1.β: broadcast to the in-process bus so SSE subscribers and tests
  // see the event without polling SQLite. The bus catches subscriber errors
  // so this is fail-soft.
  // FOUNDATIONAL FIX 2026-05-17: include the top-level act-loop columns
  // (action_artifact_id, verifier_artifact_id, predicted_residual, outcome,
  // residual, failure_kind, invoker, parent_task_id, loop_id) so SSE
  // consumers see the full event shape. Pre-fix the bus omitted these,
  // and the acc tail renderer showed "action=— verifier=—" for every
  // action_predicted because the bus frame had no act-loop fields to read.
  publishEvent({
    event_id: id,
    kind: input.kind,
    ts,
    directive_id,
    task_id,
    substrate_origin,
    payload: eventPayload as JsonValue,
    invoker: input.invoker ?? null,
    parent_task_id: input.parent_task_id ?? null,
    loop_id: input.loop_id ?? null,
    action_artifact_id: input.action_artifact_id ?? null,
    verifier_artifact_id: input.verifier_artifact_id ?? null,
    predicted_residual: input.predicted_residual ?? null,
    outcome: input.outcome ?? null,
    residual: input.residual ?? null,
    failure_kind: eventFailureKind ?? null,
  });
  // Brain elegance bc8je5f3x (2026-05-15): also publish to the activation
  // bus so workers awaiting specific event kinds wake immediately
  // instead of polling. Polling remains the safety-net fallback.
  publishActivation({
    event_id: id,
    kind: input.kind,
    ts,
    directive_id,
    task_id,
    // Auto-share-knowledge (2026-05-16): propagate payload so subscribers
    // can act on content mid-flight (knowledge propagation worker, cross-
    // terminal mirror, in-flight brain dispatches).
    payload: eventPayload as JsonValue,
  });
  // Batch 3.OPS: Prometheus counter — one increment per kind. Fail-soft
  // so a metrics misconfiguration cannot block emission. The kind is the
  // only context we need; full err goes to the logger so audits can spot
  // a metrics provider misconfiguration.
  try {
    recordEventEmission(input.kind);
  } catch (err) {
    // Lazy-import to keep the hot path free of the logger import cycle.
    void err;
  }
  if (actTuple && input.projectActTuple !== false) {
    const projection = projectActTupleRecorded(db, {
      id,
      directive_id,
      task_id,
      parent_task_id: input.parent_task_id ?? null,
      loop_id,
      context_refs: input.context_refs ?? [],
      act: actTuple,
    });
    // Close the projected act's credit tail through the canonical Shapley
    // distributor. emitEvent stays synchronous; posterior refresh is
    // best-effort and idempotent via source_act_id projection keys.
    void import("./credit").then(({ distributeCredit }) => distributeCredit(db, {
      action_event_id: projection.predicted.id,
      observation_event_id: projection.scored.id,
      scored_event_id: projection.scored.id,
      predicted_residual: actTuple.predicted_residual,
      observed_residual: actTuple.observed_residual,
    })).catch(() => { /* credit retry can be driven from projected rows */ });
  }
  if (input.kind === "owner_observed_outcome_recorded") {
    void import("./credit").then(({ distributeOwnerObservedOutcomeCredit }) => distributeOwnerObservedOutcomeCredit(db, id)).catch(() => {
      /* owner-observed credit retry can be driven from the ledger row */
    });
  }
  // F6 — universal internal Act scoring for closure audit verdicts.
  // task_closure_audited is a substrate-internal verdict (the closure
  // verifier judged whether the directive met its goal). Record it
  // as an act_tuple so the owner-observed completeness signal that
  // arrives later (or the contradicting failure that arrives if the
  // verdict was wrong) credits the closure verifier posterior.
  if (input.kind === "task_closure_audited") {
    enqueuePostCommitProjection(db, {
      label: "task_closure_audited:internal_act",
      sourceEventId: id,
      run: () => {
        const payload = isObject(input.payload) ? input.payload : {};
        const closureResidual = typeof payload.closure_residual === "number" && Number.isFinite(payload.closure_residual)
          ? payload.closure_residual
          : 0.5;
        const verdict = typeof payload.verdict === "string" ? payload.verdict : "audited";
        const { recordInternalAct } = require("./internal_act_projection") as typeof import("./internal_act_projection");
        recordInternalAct(db, {
          intent: "score closure verdict",
          actionHandle: "closure_verifier_v1",
          verifierHandle: "owner_observed_completeness",
          verifierKind: "deterministic_code",
          predictedResidual: closureResidual,
          reasoningSummary: `closure verdict=${verdict} residual=${closureResidual.toFixed(2)}`,
          actionSummary: `task_closure_audited emitted for task ${input.task_id ?? id}`,
          effectSummary: `closure verdict landed; commit-gate threshold reads residual`,
          directiveId: input.directive_id,
          taskId: input.task_id,
          sourceEventId: id,
          sourceActId: "closure_verifier_v1:" + (input.task_id ?? id),
          extra: {
            verdict,
            closure_residual: closureResidual,
          },
        });
      },
    });
  }
  // Dense post-closure credit — DAG-backprop of closure_residual
  // (HCAPO arXiv:2603.08754 / Mem-T arXiv:2601.23014: dense/hindsight
  // credit beats coarse terminal credit for long-horizon agents). When a
  // ROOT task's closure verdict lands with a numeric closure_residual, walk
  // the directive's OWN task DAG + the act/retrieval citation graph under it
  // and apply the EXISTING credit primitives to the INTERMEDIATE
  // contributors (decompositions/acts/retrievals/artifacts), weighted by
  // closure_residual and damped by graph distance. ADDITIVE: it does not
  // touch dispatch, the four-link chain, or the per-act terminal credit;
  // idempotent via projection_key dense_closure_credit:{audit_id}:{target};
  // bounded to the closing directive's DAG. Synchronous so the idempotency
  // guard is race-free. Gated to root tasks: the dense pass only fires when
  // input.task_id resolves to the directive's root node, so a child task's
  // own closure audit does not re-walk the whole directive.
  if (input.kind === "task_closure_audited") {
    enqueuePostCommitProjection(db, {
      label: "task_closure_audited:dense_credit",
      sourceEventId: id,
      run: () => {
        const closurePayloadObj = isObject(input.payload) ? input.payload : {};
        const numericResidual = typeof closurePayloadObj.closure_residual === "number" && Number.isFinite(closurePayloadObj.closure_residual)
          ? closurePayloadObj.closure_residual
          : null;
        const closingTaskId = typeof input.task_id === "string" ? input.task_id : null;
        const closingDirectiveId = typeof input.directive_id === "string" ? input.directive_id : null;
        if (numericResidual !== null && closingTaskId && closingDirectiveId) {
          const { distributeDenseClosureCredit, resolveDirectiveRootTaskId } = require("./dense_closure_credit") as typeof import("./dense_closure_credit");
          const rootTaskId = resolveDirectiveRootTaskId(db, closingDirectiveId);
          // Only fire on the directive ROOT closure (the most-grounded
          // outcome). A non-root child audit is skipped — its acts already
          // received per-act credit and will be backpropped when the root
          // closes.
          if (rootTaskId && rootTaskId === closingTaskId) {
            distributeDenseClosureCredit(db, {
              closure_audit_event_id: id,
              directive_id: closingDirectiveId,
              root_task_id: rootTaskId,
              closure_residual: numericResidual,
            });
          }
        }
      },
    });
  }
  // F6 extension — universal internal Act scoring for lesson
  // extraction. Each lesson_extracted row IS a bet: the substrate (or
  // brain, when it emits) is asserting "this pattern will help
  // prevent future failures of the same shape". The verifier
  // (future_failure_prevention_rate) closes the credit chain when
  // later closure audits / owner-observed outcomes either confirm or
  // contradict the prediction. One act per lesson emit is the right
  // scoping: lessons are individually retrievable and individually
  // citeable, so each one earns or loses posterior independently.
  if (input.kind === "lesson_extracted") {
    enqueuePostCommitProjection(db, {
      label: "lesson_extracted:internal_act",
      sourceEventId: id,
      run: () => {
        const payload = isObject(eventPayload) ? eventPayload : {};
        const summary = typeof payload.summary === "string" ? payload.summary : "lesson extracted";
        const lessonKind = typeof payload.kind === "string"
          ? payload.kind
          : (typeof payload.lesson_kind === "string" ? payload.lesson_kind : "unclassified");
        const defaultedLessonKind = isObject(payload.classification_source)
          && payload.classification_source.basis === "lesson_extracted_without_lesson_kind";
        if (defaultedLessonKind) {
          emitEvent(db, {
            kind: "knowledge_uncertainty_observed",
            substrate_origin: "substrate_auto",
            directive_id,
            task_id,
            parent_task_id: input.parent_task_id ?? null,
            loop_id,
            context_refs: [id, ...(input.context_refs ?? [])],
            payload: {
              lesson_event_id: id,
              uncertainty_kind: "lesson_extracted_without_lesson_kind",
              normalized_lesson_kind: lessonKind,
              note: "runtime.emitEvent filled lesson_kind=unclassified; emitter should provide a more specific open-ended lesson_kind.",
            },
          });
        }
        const { recordInternalAct } = require("./internal_act_projection") as typeof import("./internal_act_projection");
        recordInternalAct(db, {
          intent: "extract reusable lesson",
          actionHandle: "lesson_extractor_v1",
          verifierHandle: "future_failure_prevention_rate",
          verifierKind: "deterministic_code",
          // Lessons are moderate-confidence bets — they generalize from
          // one trajectory and may not transfer cleanly. 0.4 mirrors the
          // F6 brief's predicted_residual for this decision class.
          predictedResidual: 0.4,
          reasoningSummary: `lesson_extracted kind=${lessonKind}`,
          actionSummary: `lesson_extracted emitted for task ${input.task_id ?? id}`,
          effectSummary: summary.length > 0 ? summary.slice(0, 200) : "lesson row landed on ledger",
          directiveId: input.directive_id,
          taskId: input.task_id,
          sourceEventId: id,
          // One act per lesson emit — projection key derives from the
          // lesson event id so re-emitting the same row collapses to
          // the same projection.
          sourceActId: "lesson_extractor_v1:" + id,
          extra: {
            lesson_kind: lessonKind,
            lesson_event_id: id,
          },
        });
      },
    });
  }
  // F6 completion (decision 9) — entity model attribute write. Every
  // stakeholder_state_recorded row commits one declared_utility +
  // inferred_constraints + visibility tuple to the entity model; that
  // commitment is a substrate decision whose accuracy later evidence
  // either confirms or contradicts. recordEntityAttributeAct projects
  // the write as an act so subsequent_evidence_agreement closes the
  // credit chain when downstream observations either match or refute
  // the recorded value.
  if (input.kind === "stakeholder_state_recorded") {
    enqueuePostCommitProjection(db, {
      label: "stakeholder_state_recorded:entity_attr",
      sourceEventId: id,
      run: () => {
        const payload = isObject(input.payload) ? input.payload : {};
        const entityId = typeof payload.stakeholder_id === "string" ? payload.stakeholder_id : (input.task_id ?? id);
        const { recordEntityAttributeAct } = require("./owner_entity_acts") as typeof import("./owner_entity_acts");
        recordEntityAttributeAct(db, {
          entityId,
          attributeName: "declared_utility",
          attributeValue: (payload.declared_utility ?? null) as JsonValue,
          sourceEventId: id,
          directiveId: input.directive_id,
          taskId: input.task_id,
          extra: {
            inferred_constraints: (payload.inferred_constraints ?? null) as JsonValue,
            information_visibility: (payload.information_visibility ?? null) as JsonValue,
          },
        });
      },
    });
  }
  // F6 completion (decision 10) — owner profile attribute write. The
  // adjudicator emits two related kinds: owner_insight_candidate
  // proposes a single field/value, owner_profile_recorded commits a
  // merged snapshot. We wire ONLY the snapshot here — the commit is
  // the actual attribute write. Candidates are intermediate proposals
  // whose own credit closes when the promoter either merges them into a
  // snapshot or rejects them; wiring the candidate kind at this boundary
  // would cascade act_tuple_recorded → applied_change_committed
  // projections back into the autonomy_adjuster's outcome window and
  // create a feedback loop (the adjuster reads applied_change_committed
  // to compute its delta, and a synthetic projection makes the loop
  // self-feeding). Direct call sites that propose a candidate from
  // owner-stated intent can still invoke recordOwnerProfileAttributeAct
  // explicitly; the emit boundary stays scoped to commits.
  if (input.kind === "owner_profile_recorded") {
    enqueuePostCommitProjection(db, {
      label: "owner_profile_recorded:profile_attr",
      sourceEventId: id,
      run: () => {
        const payload = isObject(input.payload) ? input.payload : {};
        const source = typeof payload.promotion_route === "string"
          ? `promoter:${payload.promotion_route}`
          : "promoter";
        const { recordOwnerProfileAttributeAct } = require("./owner_entity_acts") as typeof import("./owner_entity_acts");
        recordOwnerProfileAttributeAct(db, {
          field: "*",
          value: payload as JsonValue,
          source,
          sourceEventId: id,
          directiveId: input.directive_id,
          taskId: input.task_id,
          extra: {
            owner_event_kind: input.kind,
          },
        });
      },
    });
  }
  // RLM retrieval credit attribution (brain task FX9PZDQ3W932,
  // 2026-05-18). Every action_scored event walks its context_refs for
  // retrieval_binding rows and emits retrieval_credit_attributed per
  // binding so retrieval_credit_view.credit_attributed_count is
  // non-zero in production. Closes the 88ESCTN8XN6J always-on-consumer
  // gap for the new credit loop without a 5-min worker delay —
  // attribution is deterministic given the inputs, so we fire at the
  // write boundary (same pattern as distributeCredit for
  // act_tuple_recorded). Synchronous, idempotent via projection_key.
  if (input.kind === "action_scored") {
    try {
      void import("./retrieval_credit").then(({ attributeRetrievalCredit }) => {
        attributeRetrievalCredit(db, {
          scored_event_id: id,
          context_refs: input.context_refs ?? [],
          residual: input.residual,
          directive_id: input.directive_id,
          task_id: input.task_id,
        });
      }).catch(() => { /* swallow; can be re-driven from the action_scored row */ });
    } catch { /* defensive */ }
  }
  // T0.2 universal action_scored → act_artifact_score_updated projection.
  //
  // Live evidence (24h pre-fix): action_scored=2380,
  // act_artifact_score_updated=123, parity=5.17%. distributeCredit's rich
  // Shapley pipeline only fires for select code paths and silently skips
  // when the action_artifact_id isn't a registered act_artifact row
  // (synthetic-actuator branch). The universal projector closes the gap:
  // every action_scored emit walks source_act_event_id → action_predicted's
  // cited_artifact_ids and emits act_artifact_score_updated per cited
  // artifact, idempotently. The recursion guard
  // (payload.projected_from === "distribute_credit") prevents
  // double-credit when distributeCredit itself drives the action_scored
  // emit. Synchronous so idempotency is race-free.
  if (input.kind === "action_scored") {
    enqueuePostCommitProjection(db, {
      label: "action_scored:project_credit",
      sourceEventId: id,
      run: () => {
        const actionArtifactId = typeof input.action_artifact_id === "string" ? input.action_artifact_id : "";
        const verifierArtifactId = typeof input.verifier_artifact_id === "string" ? input.verifier_artifact_id : "";
        if (!isBridgeExitArtifactPair(actionArtifactId, verifierArtifactId)) {
          const { projectActionScoredToCredit } = require("./credit") as typeof import("./credit");
          projectActionScoredToCredit(db, {
            id,
            payload: JSON.stringify(eventPayload),
            context_refs: JSON.stringify(input.context_refs ?? []),
            directive_id: directive_id,
            task_id: task_id,
            residual: input.residual ?? null,
            action_artifact_id: input.action_artifact_id ?? null,
            verifier_artifact_id: input.verifier_artifact_id ?? null,
          });
        }
      },
    });
  }
  // Code-artifact-candidate emit-side screen (dark-gate observability,
  // 2026-05-18). The candidate row lands first so its id is stable; the
  // screen returns sibling refusal events (predicate_gate_rejected,
  // atms_strategy_first_violation, lane_routing_refused) that we then
  // emit synchronously with the candidate id in context_refs. The
  // candidate stays in the ledger so audit/replay see what was attempted;
  // the refusal events explain why downstream gates blocked it.
  if (input.kind === "act_artifact_candidate") {
    enqueuePostCommitProjection(db, {
      label: "act_artifact_candidate:screen",
      sourceEventId: id,
      run: () => {
      const { refusals } = screenActArtifactCandidate(db, {
        payload: input.payload,
        directive_id: input.directive_id,
        task_id: input.task_id,
      });
      for (const refusal of refusals) {
        const refusalEvent = emitEvent(db, {
          kind: refusal.kind,
          substrate_origin: "substrate_auto",
          directive_id: input.directive_id,
          task_id: input.task_id,
          context_refs: [id],
          payload: refusal.payload,
        });
        // F6 — universal internal Act scoring. Each refusal is an
        // internal substrate decision (the gate fired and refused
        // the candidate). Record it as an act_tuple so an owner
        // confirmation that the refusal was correct later credits
        // the gate's posterior. Verifier handle stays conceptual
        // until the downstream confirmation lands. Lazy-import to
        // avoid the events ↔ internal_act_projection cycle.
        try {
          const { recordInternalAct } = require("./internal_act_projection") as typeof import("./internal_act_projection");
          recordInternalAct(db, {
            intent: "trigger predicate gate refusal",
            actionHandle: "predicate_gate_v1",
            verifierHandle: "owner_refusal_confirmation",
            verifierKind: "deterministic_code",
            // Refusals are high-confidence by construction: the gate
            // matched a structural rule. Predicted residual stays
            // low until owner evidence contradicts the refusal.
            predictedResidual: 0.1,
            reasoningSummary: `gate refused candidate via ${refusal.kind}`,
            actionSummary: `emitted ${refusal.kind} citing candidate ${id}`,
            effectSummary: `gate refusal blocks candidate from downstream admission`,
            directiveId: input.directive_id,
            taskId: input.task_id,
            sourceEventId: refusalEvent.id,
            sourceActId: "predicate_gate_v1:" + id + ":" + refusal.kind,
            extra: {
              refusal_kind: refusal.kind,
              candidate_event_id: id,
            },
          });
        } catch { /* fail-soft: screen refusal already landed */ }
      }
      },
    });
  }
  // Auto-admit unseen verifier_kinds (brain EH5A37DPHX0GSCJKBSRNZDX700).
  // Runs AFTER the source action_scored row has landed so the audit
  // event's context_refs can reference the source id. Idempotent SELECT-
  // before-INSERT inside the helper; safe to call on every action_scored.
  // The lift path's first pass (action_artifact_id=null) is skipped
  // because resolvedActionId is null; the recursive call with the lifted
  // handle is the one that fires the admit.
  if (input.kind === "action_scored") {
    enqueuePostCommitProjection(db, {
      label: "action_scored:auto_admit_verifier",
      sourceEventId: id,
      run: () => {
        maybeAutoAdmitVerifierKind(db, input, id);
      },
    });
  }
  // T0.3 citation binding enforcement — symmetric to T0.2 (commit
  // d8baa7e). Live evidence (brain_self_audit 168h): citations
  // kc_emitted=1745 promoted=0 — 1745 candidates cited, zero downstream
  // promotions. Citation = mutation was advisory (k_252: advisory = fake;
  // k_201: retrieval binding; k_554: citation = mutation). Fix: every
  // retrieval_binding emit walks payload.cited_knowledge_id (or
  // source_event_id) and emits a candidate_confirmed row with weight=
  // BINDING_WEIGHT carrying projected_from="bind_citation" so the
  // extractor's Beta-posterior recompute accumulates fractional wins.
  // Recursion guard: rows already stamped projected_from="bind_citation"
  // are skipped. Decorative citations (unresolvable id) emit
  // retrieval_rejected instead. Idempotent via projection_key
  // retrieval_binding_credit:{event_id}. Synchronous so idempotency is
  // race-free.
  if (input.kind === "retrieval_binding") {
    try {
      const payloadJson = JSON.stringify(eventPayload);
      // Skip the recursion case at the boundary too — defense in depth
      // against direct emit paths that stamp projected_from before
      // bindCitation's own checks.
      if (typeof eventPayload === "object" && eventPayload !== null
          && (eventPayload as Record<string, unknown>).projected_from !== "bind_citation") {
        const { bindCitation } = require("./credit") as typeof import("./credit");
        bindCitation(db, {
          id,
          payload: payloadJson,
          directive_id: directive_id,
          task_id: task_id,
        });
      }
    } catch (err) {
      // Fail-soft: parent retrieval_binding row already landed. The
      // helper emits its own projection_error rows on internal failure;
      // this outer guard only catches require/import-time exceptions.
      void err;
    }
  }
  // ALIAS_CHAI (directive 3XETJCYT): a new act_artifact_aliased edge changes
  // every OLD → CURRENT resolution downstream of the renamed id. Invalidate
  // the per-db memoized alias cache so the next resolveArtifactId reflects
  // the new hop. Lazy require avoids the events ↔ migration_runner import
  // cycle (migration_runner imports ./events for emitEvent).
  if (input.kind === "act_artifact_aliased") {
    try {
      const { invalidateAliasCache } = require("../substrate/migration_runner") as typeof import("../substrate/migration_runner");
      invalidateAliasCache(db);
    } catch { /* fail-soft: cold cache rebuilds on next miss */ }
  }
  return { id, ts };
};

/** Fetch one event by id, parsing the JSON payload + context_refs back to
 *  structured shape. Returns null if no row matches. */
export const getEventById = (db: Database, id: string): Event | null => {
  const row = db.query("SELECT * FROM events WHERE id = ?").get(id) as Record<string, unknown> | null;
  if (!row) return null;
  return {
    id: row.id as string,
    ts: row.ts as string,
    directive_id: row.directive_id as string,
    task_id: row.task_id as string,
    parent_task_id: (row.parent_task_id as string | null) ?? null,
    loop_id: row.loop_id as string,
    substrate_origin: row.substrate_origin as SubstrateOrigin,
    kind: row.kind as EventKind,
    payload: JSON.parse((row.payload as string) ?? "{}") as JsonValue,
    context_refs: JSON.parse((row.context_refs as string) ?? "[]") as string[],
    predicted_residual: (row.predicted_residual as number | null) ?? undefined,
    action_artifact_id: (row.action_artifact_id as string | null) ?? undefined,
    verifier_artifact_id: (row.verifier_artifact_id as string | null) ?? undefined,
    outcome: (row.outcome as Event["outcome"]) ?? undefined,
    residual: (row.residual as number | null) ?? undefined,
    payload_hash: (row.payload_hash as string | null) ?? undefined,
    blob_ref: (row.blob_ref as string | null) ?? undefined,
    failure_kind: (row.failure_kind as Event["failure_kind"]) ?? undefined,
    invoker: (row.invoker as SubstrateOrigin | null) ?? undefined,
  };
};
