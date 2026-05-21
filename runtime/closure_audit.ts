// acc2 closure audit selection — timestamp-scoped, current-root closure
// row selection helpers. F11 (2026-05-18, contract
// 2AMJKN0GTX32790173EPYH6YT4) cites lesson 7JE565S6016T: closure stop
// functions previously selected stale closure_audited rows when a root
// task_id was reused across directive amendments or when a directive's
// CURRENT root differs from a historical root id with its own closure
// audits. The substrate must select the MOST RECENT task_closure_audited
// row that is scoped to:
//
//   1. the directive id, AND
//   2. the directive's CURRENT root task id (the root after any
//      directive_amended row that may have changed the active root), AND
//   3. ts strictly greater than the most recent root-supersession or
//      directive_amended event that changed the active root.
//
// Without this, the plateau detector (task_dispatcher.ts) and the
// experience compression worker can pick up a closure_residual from a
// previous incarnation of the same task_id, suppress active refinement,
// or score a fresh trajectory as "already settled" against ancient
// evidence.
//
// The KC (JN8ND1TFQ11FHD178RNZSHH554) names this file explicitly as the
// canonical home for the helper.

import type { Database } from "bun:sqlite";
import { emitEvent } from "./events";
import { getThreshold } from "./threshold_registry";

export type ClosureAuditSelection = {
  /** Event id of the selected task_closure_audited row. */
  closure_audit_event_id: string;
  /** Numeric closure_residual extracted from the audit payload. */
  closure_residual: number;
  /** ts of the selected audit row. */
  ts: string;
  /** task_id stamped on the audit row. */
  task_id: string;
};

/** Resolve the LATEST directive_amended or directive_root_superseded ts
 *  on this directive. The current root is only considered "settled" by
 *  closure audits emitted AFTER this cutoff; older rows are stale even
 *  if they share the same task_id. Returns null when no amendment /
 *  supersession has fired (the directive's original root still owns
 *  every closure on it). */
const latestRootSupersessionTs = (
  db: Database,
  directiveId: string,
): string | null => {
  const row = db
    .query<{ ts: string }, [string]>(
      `SELECT ts FROM events
        WHERE directive_id = ?
          AND kind IN ('directive_amended', 'directive_root_superseded')
        ORDER BY ts DESC, rowid DESC
        LIMIT 1`,
    )
    .get(directiveId);
  return row?.ts ?? null;
};

/** Select the most recent task_closure_audited row whose:
 *    - directive_id matches the supplied directive,
 *    - task_id matches the directive's current root (the caller resolves
 *      "current root" — usually `task.id` when the dispatcher is iterating
 *      the root, or via task_graph projection),
 *    - ts is strictly newer than any directive_amended / root supersession
 *      event on the same directive.
 *
 *  Returns null when no qualifying row exists — callers must treat a null
 *  result as "no closure verdict yet" rather than falling back to an
 *  earlier (stale) row. Idempotent / pure: re-running with identical
 *  inputs returns identical output until a new audit lands. */
export const selectCurrentRootClosureAudit = (
  db: Database,
  directiveId: string,
  currentRootTaskId: string,
): ClosureAuditSelection | null => {
  const cutoff = latestRootSupersessionTs(db, directiveId);
  const rows = cutoff
    ? db
        .query<{ id: string; ts: string; task_id: string; payload: string }, [string, string, string]>(
          `SELECT id, ts, task_id, payload FROM events
            WHERE kind = 'task_closure_audited'
              AND directive_id = ?
              AND task_id = ?
              AND ts > ?
            ORDER BY ts DESC, rowid DESC`,
        )
        .all(directiveId, currentRootTaskId, cutoff)
    : db
        .query<{ id: string; ts: string; task_id: string; payload: string }, [string, string]>(
          `SELECT id, ts, task_id, payload FROM events
            WHERE kind = 'task_closure_audited'
              AND directive_id = ?
              AND task_id = ?
            ORDER BY ts DESC, rowid DESC`,
        )
        .all(directiveId, currentRootTaskId);
  for (const row of rows) {
    let residual: number | null = null;
    try {
      const payload = JSON.parse(row.payload ?? "{}") as Record<string, unknown>;
      if (typeof payload.closure_residual === "number") residual = payload.closure_residual;
    } catch { /* malformed payload — skip */ }
    if (residual === null) continue;
    return {
      closure_audit_event_id: row.id,
      closure_residual: residual,
      ts: row.ts,
      task_id: row.task_id,
    };
  }
  return null;
};

/** Time-ordered list of closure_residual values for a refinement lineage
 *  under a directive's CURRENT root window. The plateau detector in
 *  task_dispatcher.ts uses this to find "no improvement over N cycles" —
 *  it must operate over a window that excludes audits emitted before the
 *  current root took over (a previous amendment's audits would
 *  spuriously flatten the trend). Returns rows in ts ASC so callers can
 *  slice -N off the tail to get the most recent N values. */
export const closureResidualsForLineage = (
  db: Database,
  directiveId: string,
  lineageTaskIds: ReadonlySet<string>,
): number[] => {
  if (lineageTaskIds.size === 0) return [];
  const cutoff = latestRootSupersessionTs(db, directiveId);
  const rows = cutoff
    ? db
        .query<{ task_id: string; payload: string }, [string, string]>(
          `SELECT task_id, payload FROM events
            WHERE kind = 'task_closure_audited'
              AND directive_id = ?
              AND ts > ?
            ORDER BY ts ASC, rowid ASC`,
        )
        .all(directiveId, cutoff)
    : db
        .query<{ task_id: string; payload: string }, [string]>(
          `SELECT task_id, payload FROM events
            WHERE kind = 'task_closure_audited'
              AND directive_id = ?
            ORDER BY ts ASC, rowid ASC`,
        )
        .all(directiveId);
  const out: number[] = [];
  for (const row of rows) {
    if (!lineageTaskIds.has(row.task_id)) continue;
    try {
      const payload = JSON.parse(row.payload ?? "{}") as Record<string, unknown>;
      if (typeof payload.closure_residual === "number") out.push(payload.closure_residual);
    } catch { /* malformed payload — skip */ }
  }
  return out;
};

// ── T0.1 substrate-truth gate ──────────────────────────────────────
//
// Brain dispatch TFZ6AJXNPS6655QMFWT6KPB3QM, amendment
// ZC7HF4Y3HN1BK91FXVQE77S4GC. Closes the k_252 advisory-gate fake at
// the closure-audit boundary: pre-fix the brain emitted
// `checks={all_true}` for amendments it never wrote, and the substrate
// accepted the claim because no independent verification ran.
//
// The new shape is symmetric — every named check in `brain_claims`
// also appears in `substrate_verifications` with the substrate-side
// query result. Residual is DERIVED from the substrate-verifications,
// never from the brain's own boolean assertions.
//
// Hard precondition: when the closure_predicate declares `target_files`
// AND the brain asserts `closure_residual < 0.3`, the substrate
// SELECTs `contract_amendment_proposed` rows whose
// `target_resource`/`resource_uri` payload field matches any declared
// target_file (normalized to `repo:<path>`). Zero matches refuses
// closure — emits `closure_blocked_no_amendments`, bumps residual to
// 1.0, and stamps `substrate_verifications.target_files_have_amendments
// = { verified: false, evidence_event_ids: [], query }`.

export type BrainClaims = Record<string, boolean>;

export type SubstrateVerification = {
  verified: boolean;
  evidence_event_ids: string[];
  query: string;
};

export type SubstrateVerifications = Record<string, SubstrateVerification>;

export type ClosurePredicate = {
  /** Repo-relative file paths the brain promised to mutate as part of
   *  this closure. The substrate normalizes each entry to `repo:<path>`
   *  before matching against contract_amendment_proposed payloads. */
  target_files?: string[];
  /** Other open-ended predicate fields (verifier_kind, residual_below,
   *  required_events, …) — preserved verbatim on the audit payload. */
  [k: string]: unknown;
};

export type VerifyClosureAuditInput = {
  /** Directive scope for the substrate-side queries. Mandatory: every
   *  verification joins on directive_id so cross-directive amendments
   *  cannot silently satisfy a closure they were never proposed for. */
  directive_id: string;
  /** Root task the closure attempt is scored against. Stamped onto the
   *  refusal event so audit trails can pivot from a stuck closure to
   *  its trajectory. */
  task_id?: string;
  /** Closure predicate as declared by the brain. */
  closure_predicate?: ClosurePredicate;
  /** Named-check booleans the brain emitted. Advisory only — they are
   *  preserved on the payload but never lower the residual. */
  brain_claims?: BrainClaims;
  /** Residual the brain asserted. Used to gate the hard precondition
   *  (target_files check fires only when this is < 0.3). */
  asserted_residual: number;
  /** 2026-05-21 leniency fix: count of RAW checks the brain emitted
   *  (boolean AND non-boolean). The gate only verifies boolean claims, so
   *  when the brain emits non-boolean checks (axis values / verdict
   *  strings) they were silently dropped → empty substrate_verifications →
   *  residual fell back to the brain's asserted value. Both terminals hit
   *  this: a task committed at residual 0.08 with checks=0/6 satisfied.
   *  raw_claim_count lets the residual derivation distinguish "brain made
   *  claims the substrate couldn't verify" (fail-closed) from "brain made
   *  no claims at all" (legitimately falls back to asserted). */
  raw_claim_count?: number;
  /** Any other fields the brain stamped on the closure payload —
   *  preserved on the augmented output so historical readers keep
   *  working (k_204 save richness). */
  legacy_fields?: Record<string, unknown>;
};

export type VerifyClosureAuditResult = {
  /** The augmented payload the caller should stamp onto
   *  task_closure_audited. */
  payload: Record<string, unknown>;
  /** True when at least one substrate-side verification failed (hard
   *  precondition tripped OR a named check disagrees). */
  blocked: boolean;
  /** Event ids of any sibling events the gate emitted (today: at most
   *  one closure_blocked_no_amendments). */
  emitted_event_ids: string[];
};

/** Normalize a target_files entry to the canonical `repo:<path>` form.
 *  Accepts bare paths (`runtime/foo.ts`), `./`-prefixed paths
 *  (`./runtime/foo.ts`), absolute paths (stripped to repo-relative
 *  when they live under the working tree is the apply layer's
 *  problem — here we accept them verbatim under the `repo:` prefix so
 *  downstream LIKE-matching still works), and entries already
 *  prefixed (`repo:runtime/foo.ts`).
 *
 *  The output is always lowercase-stable and prefixed. Mirrors the
 *  conventions in cli/apply.ts and runtime/resource_uri.ts. */
const normalizeRepoUri = (entry: string): string => {
  const trimmed = entry.trim();
  if (trimmed.length === 0) return "";
  if (trimmed.startsWith("repo:")) return trimmed;
  return "repo:" + trimmed.replace(/^\.\//, "");
};

/** Hard precondition: target_files declared + asserted_residual < 0.3
 *  → at least one contract_amendment_proposed must exist for the
 *  declared files on the same directive. Returns the substrate
 *  verification (verified flag, evidence ids, raw SQL) and the
 *  evidence rows so callers can attach them to the augmented payload
 *  or the refusal event. */
const verifyTargetFilesHaveAmendments = (
  db: Database,
  directiveId: string,
  targetFiles: string[],
): { verification: SubstrateVerification; matched: { id: string }[] } => {
  // The substrate-side check: enumerate contract_amendment_proposed
  // rows on the same directive whose target_resource OR resource_uri
  // payload field equals any normalized target_file. Bare paths and
  // `repo:` prefixes both match because we substitute the normalized
  // form into the LIKE clause. We use json_extract on both keys so
  // the brain can stamp either field shape and the verification
  // still fires.
  const normalized = targetFiles.map(normalizeRepoUri).filter((s) => s.length > 0);
  if (normalized.length === 0) {
    return {
      verification: {
        verified: false,
        evidence_event_ids: [],
        query: "SELECT id FROM events WHERE 1=0 -- empty target_files after normalization",
      },
      matched: [],
    };
  }
  // Build the dynamic IN-clause carefully — sqlite parameter binding
  // means we cannot inject the list directly. Build placeholders and
  // bind each normalized URI twice (once for target_resource, once for
  // resource_uri).
  const placeholdersTarget = normalized.map(() => "?").join(",");
  const placeholdersResource = normalized.map(() => "?").join(",");
  const query =
    "SELECT id FROM events WHERE directive_id = ? AND kind = 'contract_amendment_proposed' " +
    `AND (json_extract(payload, '$.target_resource') IN (${placeholdersTarget}) ` +
    `OR json_extract(payload, '$.resource_uri') IN (${placeholdersResource}))`;
  const rows = db
    .query<{ id: string }, string[]>(query)
    .all(directiveId, ...normalized, ...normalized);
  return {
    verification: {
      verified: rows.length > 0,
      evidence_event_ids: rows.map((r) => r.id),
      // Echo the exact query the substrate ran so audit readers can
      // re-execute it without guessing at the gate's logic.
      query,
    },
    matched: rows,
  };
};

/** Verify a closure-audit attempt against substrate truth.
 *
 *  Returns the augmented payload the caller should stamp onto
 *  task_closure_audited. When the hard precondition fails the function
 *  also emits a sibling closure_blocked_no_amendments event so
 *  operators see the refusal in the narrative stream and dashboards
 *  count the rate.
 *
 *  Caller convention: pass the brain-claimed checks AND the brain's
 *  asserted residual exactly as received. The function preserves them
 *  on the augmented payload under `brain_claims` and `asserted_residual`
 *  (advisory) and stamps the verified `residual` independently. Legacy
 *  readers that branch on `checks/breakdown` keep working because we
 *  also project `brain_claims` back onto `checks` for backwards-compat
 *  (the renderer in cli/observe.ts branches on presence of
 *  substrate_verifications). */
export const verifyClosureAudit = (
  db: Database,
  input: VerifyClosureAuditInput,
): VerifyClosureAuditResult => {
  const brainClaims: BrainClaims = input.brain_claims ? { ...input.brain_claims } : {};
  const substrateVerifications: SubstrateVerifications = {};
  const emittedEventIds: string[] = [];
  let blocked = false;

  const targetFiles = Array.isArray(input.closure_predicate?.target_files)
    ? (input.closure_predicate!.target_files as unknown[]).filter((s): s is string => typeof s === "string")
    : [];

  // Hard precondition — only enforced when the brain asserts a passing
  // residual (< 0.3). Brains that already self-report failure don't
  // need substrate refusal; only those claiming clean closure with no
  // declared-file evidence behind them do.
  if (targetFiles.length > 0 && input.asserted_residual < 0.3) {
    const { verification, matched } = verifyTargetFilesHaveAmendments(
      db,
      input.directive_id,
      targetFiles,
    );
    substrateVerifications.target_files_have_amendments = verification;
    if (matched.length === 0) {
      blocked = true;
      const refusal = emitEvent(db, {
        kind: "closure_blocked_no_amendments",
        substrate_origin: "substrate_auto",
        directive_id: input.directive_id,
        task_id: input.task_id,
        payload: {
          directive_id: input.directive_id,
          task_id: input.task_id ?? null,
          target_files: targetFiles.map(normalizeRepoUri),
          query: verification.query,
          asserted_residual: input.asserted_residual,
          residual: 1.0,
          evidence_event_ids: [],
          reason: "no_contract_amendment_for_declared_target_files",
        },
      });
      emittedEventIds.push(refusal.id);
    }
  }

  // For every additional brain_claims entry NOT yet covered by the
  // hard precondition, run a generic substrate-side verification. We
  // do NOT invent new SQL queries here — the substrate only verifies
  // checks it has a registered query for. Unknown checks land in
  // substrate_verifications with verified=false + an empty query so
  // the discrepancy surfaces (brain says true, substrate says
  // unverified). This is fail-closed by design (k_252): substrate
  // never auto-passes a brain claim it cannot verify.
  for (const checkName of Object.keys(brainClaims)) {
    if (checkName in substrateVerifications) continue;
    substrateVerifications[checkName] = {
      verified: false,
      evidence_event_ids: [],
      query: "",
    };
  }

  // Residual derivation: substrate-truth only. Any failed substrate
  // verification → 1.0. All passing → 0. Brain claims never lower
  // residual on their own.
  const anyFailedVerification = Object.values(substrateVerifications).some(
    (v) => v.verified === false,
  );
  // When no checks ran at all (no target_files, no brain_claims), the
  // substrate has nothing to verify — fall back to the asserted
  // residual rather than synthesising a pass. This preserves the
  // legacy path where a closure is self-reported without opting into
  // the T0.1 closure_predicate contract.
  // 2026-05-21 leniency narrowing (k_252 lineage): the summary-only
  // bump applies ONLY to modern closures that declare closure_predicate,
  // produce zero substrate verifications, make zero raw claims, and assert
  // a passing residual. Legacy numeric-only/no-predicate payloads stay on
  // the pre-T0.1 pass-through path and keep their asserted residual.
  const rawClaims = input.raw_claim_count ?? 0;
  const noSubstrateVerifications = Object.keys(substrateVerifications).length === 0;
  const modernSummaryOnlyClosure = !!input.closure_predicate
    && rawClaims === 0
    && noSubstrateVerifications
    && input.asserted_residual < 0.3;
  const residual = noSubstrateVerifications
    ? (modernSummaryOnlyClosure ? 0.3 : input.asserted_residual)
    : (anyFailedVerification ? 1.0 : 0);

  // Discrepancies: claims that disagree with substrate verifications.
  const discrepancies: string[] = [];
  for (const [name, claim] of Object.entries(brainClaims)) {
    const verification = substrateVerifications[name];
    if (!verification) continue;
    if (claim !== verification.verified) discrepancies.push(name);
  }

  const payload: Record<string, unknown> = {
    ...(input.legacy_fields ?? {}),
    brain_claims: brainClaims,
    substrate_verifications: substrateVerifications,
    asserted_residual: input.asserted_residual,
    closure_residual: residual,
    discrepancies,
  };
  if (input.closure_predicate) payload.closure_predicate = input.closure_predicate;

  return { payload, blocked, emitted_event_ids: emittedEventIds };
};

// ── Hardened closure commit gate (2026-05-20) ─────────────────────────
//
// Closes the k_252 advisory-gate fake at the dispatcher boundary. Live
// evidence (24h): 10 task_committed events at closure_residual >= 0.3,
// including 3 at residual = 1.00 (max). The substrate's workflow
// documented "closure_residual >= 0.3 → refine, do NOT commit root" but
// the dispatcher committed anyway because the gate was advisory.
//
// The hardened gate intercepts task_committed emissions: when the
// referenced task carries a recent task_closure_audited row with
// closure_residual >= threshold (default 0.3, configurable via
// threshold registry's closure_gate_residual_threshold) AND no fresh
// owner_input_received{closure_override:true} is on file (override must
// be more recent than the audit, otherwise it does NOT unlock commit),
// the emission is refused. A closure_blocked_high_residual event
// records the refusal with task_id + closure_residual + discrepancies
// + recommended_action so operators see the structural refusal in real
// time and the brain can react via a refinement edge instead of
// re-emitting the same commit.
//
// When an owner override does post-date the audit, commit IS allowed
// and a closure_override_acknowledged event is stamped for audit.
//
// The gate is fail-OPEN when no task_closure_audited exists for the
// task at all — pre-closure-audit tasks (e.g. low-fanout leaf
// dispatches, test fixtures that bypass closure verification) keep
// working. The k_252 violation is specifically "audited high residual,
// committed anyway"; tasks without an audit are an orthogonal class.

export type ClosureGateDecision =
  | {
      /** Commit IS allowed. closure_residual was below threshold OR a
       *  fresh owner override post-dates the audit. */
      allow: true;
      /** Threshold value the gate evaluated against (from registry). */
      threshold: number;
      /** Most-recent closure_residual the gate saw, or null when no
       *  audit row exists for this task. */
      closure_residual: number | null;
      /** Audit event id the gate referenced. Null when no audit row. */
      closure_audit_event_id: string | null;
      /** Override event id when the gate unlocked via owner consent. */
      override_event_id?: string;
      /** Override ts when the gate unlocked via owner consent. */
      override_ts?: string;
      /** Event id of the closure_override_acknowledged row stamped on
       *  the ledger when the override fired. Undefined when no
       *  override was needed. */
      override_acknowledged_event_id?: string;
    }
  | {
      /** Commit is REFUSED. closure_residual >= threshold and no fresh
       *  owner override is on file. */
      allow: false;
      threshold: number;
      closure_residual: number;
      closure_audit_event_id: string;
      /** Event id of the closure_blocked_high_residual row the gate
       *  emitted for audit. */
      blocked_event_id: string;
      /** Discrepancies pulled from the audit payload (the brain_claims
       *  vs substrate_verifications delta). Passed through to the
       *  refusal payload so operators can pivot directly to the failed
       *  named checks. */
      discrepancies: string[];
    };

/** Evaluate the closure commit gate for a task before allowing
 *  task_committed to land. Callers (handleEmit in
 *  runtime/mcp_server/substrate_tools.ts, dispatcher auto-commit paths)
 *  pass the task_id and optional directive_id; the gate looks up the
 *  most recent task_closure_audited row scoped to that task, reads the
 *  threshold from the registry, checks for a fresh owner override, and
 *  emits the appropriate sibling event (closure_blocked_high_residual
 *  on refusal, closure_override_acknowledged on override-unlock).
 *
 *  Returns ClosureGateDecision. Refusal callers MUST treat allow=false
 *  as terminal (do NOT proceed with task_committed). */
export const evaluateClosureCommitGate = (
  db: Database,
  args: {
    /** task_id stamped on the task_committed the caller is about to
     *  emit. Required — the gate scopes the audit lookup to this id. */
    task_id: string;
    /** Optional directive_id scope so audit lookups across multi-root
     *  directives still resolve to the right audit row when a task_id
     *  is reused across directives (defensive — task_id should be
     *  globally unique but we filter here to be safe). */
    directive_id?: string;
  },
): ClosureGateDecision => {
  const threshold = getThreshold(db, "closure_gate_residual_threshold", 0.3);
  // Look up the MOST RECENT task_closure_audited row for this task.
  // We scope by task_id (and optionally directive_id) and read the
  // newest by (ts, rowid) so a refinement that audited a second time
  // gets evaluated against the latest verdict, not a stale row.
  const auditRow = args.directive_id
    ? db
        .query<{ id: string; ts: string; payload: string }, [string, string]>(
          `SELECT id, ts, payload FROM events
            WHERE kind = 'task_closure_audited'
              AND task_id = ?
              AND directive_id = ?
            ORDER BY ts DESC, rowid DESC
            LIMIT 1`,
        )
        .get(args.task_id, args.directive_id)
    : db
        .query<{ id: string; ts: string; payload: string }, [string]>(
          `SELECT id, ts, payload FROM events
            WHERE kind = 'task_closure_audited'
              AND task_id = ?
            ORDER BY ts DESC, rowid DESC
            LIMIT 1`,
        )
        .get(args.task_id);
  if (!auditRow) {
    // Fail-OPEN when no audit exists. The gate only refuses tasks that
    // HAVE been audited and scored >= threshold — pre-audit tasks fall
    // through to the existing commit path. The k_252 violation we're
    // closing is "audited high residual, committed anyway", not
    // "committed without an audit" (that's a separate gate elsewhere).
    return {
      allow: true,
      threshold,
      closure_residual: null,
      closure_audit_event_id: null,
    };
  }
  let closureResidual = 0;
  let discrepancies: string[] = [];
  try {
    const payload = JSON.parse(auditRow.payload ?? "{}") as Record<string, unknown>;
    if (typeof payload.closure_residual === "number") closureResidual = payload.closure_residual;
    if (Array.isArray(payload.discrepancies)) {
      discrepancies = (payload.discrepancies as unknown[]).filter((s): s is string => typeof s === "string");
    }
  } catch {
    // Malformed payload — treat as residual=0 so we don't block on
    // unparseable rows. The closure verifier should never emit
    // malformed JSON; this is defensive.
    closureResidual = 0;
  }
  // Residual below threshold → commit cleanly. No sibling event needed.
  if (closureResidual < threshold) {
    return {
      allow: true,
      threshold,
      closure_residual: closureResidual,
      closure_audit_event_id: auditRow.id,
    };
  }
  // Residual >= threshold. Check for a fresh owner consent override:
  // owner_input_received with payload.closure_override = true whose ts
  // is STRICTLY GREATER than the audit's ts. Stale overrides (emitted
  // before the audit) do NOT unlock commit — every fresh audit
  // re-locks the gate. We scope to task_id so an override on a
  // different task can't accidentally unlock this one.
  const overrideRow = args.directive_id
    ? db
        .query<{ id: string; ts: string }, [string, string, string]>(
          `SELECT id, ts FROM events
            WHERE kind = 'owner_input_received'
              AND task_id = ?
              AND directive_id = ?
              AND ts > ?
              AND json_extract(payload, '$.closure_override') = 1
            ORDER BY ts DESC, rowid DESC
            LIMIT 1`,
        )
        .get(args.task_id, args.directive_id, auditRow.ts)
    : db
        .query<{ id: string; ts: string }, [string, string]>(
          `SELECT id, ts FROM events
            WHERE kind = 'owner_input_received'
              AND task_id = ?
              AND ts > ?
              AND json_extract(payload, '$.closure_override') = 1
            ORDER BY ts DESC, rowid DESC
            LIMIT 1`,
        )
        .get(args.task_id, auditRow.ts);
  if (overrideRow) {
    // Owner consented post-audit — allow commit and stamp the
    // acknowledgement for audit. The acknowledgement is structural
    // (health_metric=true) so dashboards count the rate of overrides
    // independently from the rate of refusals.
    const ack = emitEvent(db, {
      kind: "closure_override_acknowledged",
      substrate_origin: "substrate_auto",
      directive_id: args.directive_id,
      task_id: args.task_id,
      payload: {
        task_id: args.task_id,
        closure_residual: closureResidual,
        threshold,
        closure_audit_event_id: auditRow.id,
        override_event_id: overrideRow.id,
        override_ts: overrideRow.ts,
      },
    });
    return {
      allow: true,
      threshold,
      closure_residual: closureResidual,
      closure_audit_event_id: auditRow.id,
      override_event_id: overrideRow.id,
      override_ts: overrideRow.ts,
      override_acknowledged_event_id: ack.id,
    };
  }
  // No fresh override — refuse the commit and emit
  // closure_blocked_high_residual for audit. The brain reading the
  // ledger will see the refusal and can react via a refinement edge.
  const blocked = emitEvent(db, {
    kind: "closure_blocked_high_residual",
    substrate_origin: "substrate_auto",
    directive_id: args.directive_id,
    task_id: args.task_id,
    payload: {
      task_id: args.task_id,
      closure_residual: closureResidual,
      threshold,
      discrepancies,
      closure_audit_event_id: auditRow.id,
      recommended_action: "refine_or_decline",
    },
  });
  return {
    allow: false,
    threshold,
    closure_residual: closureResidual,
    closure_audit_event_id: auditRow.id,
    blocked_event_id: blocked.id,
    discrepancies,
  };
};
