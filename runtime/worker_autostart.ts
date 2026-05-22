// Canonical worker autostart resolver — one env var, all workers.
//
// The canonical shape is ONE env var, comma-separated, listing workers to
// DISABLE. Empty / unset = all workers run (the production default). Tests
// pin every worker off via `tests/preload.ts` so the unit suite stays hermetic.
//
//   ACC2_DISABLE_WORKERS=                            # all on (default)
//   ACC2_DISABLE_WORKERS=embedder                    # disable one
//   ACC2_DISABLE_WORKERS=embedder, father, scheduler # whitespace tolerated
//
// Unknown worker names in the list are accepted silently. `isWorkerEnabled`
// only consults the set for canonical names, so a misspelled entry is a no-op
// rather than a hard failure.

/** Canonical worker names gated by `ACC2_DISABLE_WORKERS`. */
export type WorkerName =
  | "embedder"
  | "scheduler"
  | "father"
  | "rolling_reviewer"
  | "rehabilitation"
  | "integrity"
  | "supervisor"
  | "compaction"
  // Brain audit B (2026-05-15): Model-D promotion pipeline was relying on
  // Father opening maintenance directives to scan candidates — chance
  // dispatch only. A first-class extractors tick scans candidates on a
  // bounded cadence and emits knowledge_promoted / act_artifact_promoted
  // (including recipe-shape knowledge rows) when posteriors cross promotion
  // thresholds.
  | "extractors"
  // Brain audit D (2026-05-15): amendment + metrics_gauge_refresh workers
  // were registered + ticked in daemon.ts but absent from
  // ACC2_DISABLE_WORKERS taxonomy. Operators couldn't turn them off via
  // the canonical env knob and tests/preload.ts didn't pin them OFF.
  | "amendment"
  | "metrics_gauge_refresh"
  // Axis E alignment: source hotreload is a daemon-started periodic subsystem
  // and should use the same ACC2_DISABLE_WORKERS taxonomy as other workers.
  | "hotreload"
  // Brain audit QQEHAW97 SMART-axis lesson (2026-05-15): Layer-2 intelligence
  // should decay inert rows, not just promote successful rows. Periodic worker
  // calls applyRecipeInertiaDecay (runtime/recipe_inertia.ts) to multiply the
  // confidence of recipes that haven't been replayed in N days by 0.95, with
  // a 0.1 floor. Ticks hourly; idempotent per-second.
  | "recipe_inertia"
  // Self-healing chain Layer 3 (owner-approved 2026-05-16): when acc verify
  // detects drift and Layer 2 emits knowledge_contradiction_observed, this
  // worker periodically scans for drift contradictions older than the age
  // threshold (default 24h) and auto-opens a corrective directive so the
  // brain designs the fix. Dispatch capped per tick to bound brain spend.
  | "verify_heal"
  // Primitive #3 (SZG5PQ01): standalone experience compression tick that mines
  // low-residual closed trajectories into existing recipe/knowledge events.
  | "experience_compression"
  // F3 (2026-05-18): periodic sweep that closes open lifecycles.
  // contract_amendment_proposed / owner_input_required /
  // task_node_opened rows that never received a terminator pile up
  // forever; the sweep emits closure_complete / closure_obsolete /
  // closure_owner_required so read-models stop returning them.
  // Default interval 6h.
  | "lifecycle_closure_sweep"
  // F11 (2026-05-18): proactive contract amendment flywheel consumer.
  // Triages live contract_amendment_proposed rows BEFORE
  // lifecycle_closure_sweep retires them as stuck. Per-proposal
  // verdicts: route_to_implementation, route_to_clarification,
  // supersession (closure_obsolete on older proposal), redundancy
  // (closure_complete when already applied). Default interval 5min.
  | "contract_amendment_consumer"
  // F-resilience (2026-05-18, contract C33Q10NV557DDEMMHH4TD42MVR):
  // opportunistic WAL pressure observation. Stats the WAL sidecar
  // size every 30s and runs PRAGMA wal_checkpoint(PASSIVE) when the
  // size crosses a configurable threshold (default 100MB, override
  // via ACC2_WAL_PRESSURE_THRESHOLD_MB). PASSIVE never blocks
  // writers — purely opportunistic checkpoint advancement.
  | "wal_pressure_check"
  // 2026-05-19 (KCs YKJYRGVJJX21XAMQS042PMK7JG +
  // G3CBVAGY2S5QN5XDC1GR7GJP0G): auto-retire stale / test-file /
  // anchor-missing rows in the pending_owner_decision_queue_view.
  // The view kept piling up noise (40+ rows including test-file
  // targets the brain should never have routed for owner review)
  // while the operator-visibility surface stayed valuable. The
  // worker scans, emits pending_decision_retired per retire, and
  // the new pending_owner_decision_queue_live_view filters them
  // out. Historical view stays for audit. Default 1h cadence.
  | "pending_decision_retire"
  // 2026-05-19 (brain dispatch J4HP5SYT3N4GK45S Candidate A):
  // one-shot substrate-wide sweep that backfills concrete `kind`
  // values onto act_artifact rows still carrying the legacy
  // `code_artifact` default. Single-sweep semantics: the daemon
  // kicks the worker once after boot, NOT on a periodic cadence.
  // Opt-out via ACC2_DISABLE_WORKERS=artifact_kind_backfill. See
  // runtime/artifact_kind_backfill_worker.ts for the inference
  // evidence ladder.
  | "artifact_kind_backfill"
  // 2026-05-19 (brain amendment 1Z3PMEYE7X44343E7K8ARCDY20, T1.1):
  // owner-outcome follow-up worker. Substrate had 287K events but
  // only 2 owner_observed_outcome_recorded rows — the load-bearing
  // primitive for non-technical universality was structurally
  // starved. The worker scans applied_change_committed events older
  // than the feedback window (default 24h) with affected_resources,
  // emits one hidl_action_required per eligible change asking the
  // owner whether the change worked. Owner's reply becomes
  // owner_observed_outcome_recorded (existing CLI path), credit
  // flows through the act-tuple chain. Default 30min cadence.
  // Opt-out via ACC2_DISABLE_WORKERS=owner_outcome_followup.
  | "owner_outcome_followup"
  // 2026-05-20 (T4.1 counterfactual credit, docs/roadmap.md Tier 6):
  // counterfactual credit scorer worker. Scans
  // counterfactual_alternative_recorded events older than their
  // window_seconds and emits act_artifact_score_updated against each
  // rejected candidate. Selectors learn from the chosen path's
  // outcome. Default 5min cadence. Opt-out via
  // ACC2_DISABLE_WORKERS=counterfactual_credit.
  | "counterfactual_credit"
  // Tier -1 floor enforcement workers (docs/roadmap.md). Each emits
  // absence-of-violation evidence on its predicate's behalf:
  //   - event_authenticity        — 60s tick (sample last-hour events)
  //   - storage_integrity_floor   — 5min tick (PRAGMA integrity_check + wal_checkpoint(TRUNCATE))
  //   - deterministic_computation — 10min tick (verifier residual agreement)
  //   - kernel_sandbox            — 5min tick (artifact_invoked ↔ sandbox_enforced parity)
  //   - owner_identity            — 5min tick (actor-token sha continuity vs. admin_token_rotated)
  // Predicate rows admitted in substrate/seed.ts. Workers fail-soft —
  // SQL/emit errors are logged but never crash the daemon.
  | "event_authenticity"
  | "storage_integrity_floor"
  | "deterministic_computation"
  | "kernel_sandbox"
  | "owner_identity"
  // 2026-05-20 (T-1 storage longevity floor, docs/Architecture.md
  // commit 6b8ebea + brain KC TE6P3958): hot/cold archival worker.
  // 6h tick. Moves events older than archival_retention_days into
  // sibling state-archive-YYYY-MM.db files; verify-then-delete keeps
  // the hot ledger bounded as the daily event rate grows. Without
  // this floor, aggregate-scan cost grows linearly with production
  // rate (live: 301K events / 5.5d → 50 GB/year projection).
  // Opt-out via ACC2_DISABLE_WORKERS=archival.
  | "archival"
  // 2026-05-20 (substrate-side brain dispatch primitive, per brain
  // HCWM88JN0H6NDB8V amendment GMZ08ASMTD7W): any substrate component
  // can emit a brain_invocation_request event when a verifier/view
  // detects design ambiguity, structural fault, repeated silent exits,
  // or insufficient synthesis. This worker (30s tick) reads the queue,
  // applies per-emitter loop prevention (COSMIC SSA pattern), dedups
  // by topic+triggering_event_ids, composes a directive, and
  // dispatches through the existing acc task path. Opt-out via
  // ACC2_DISABLE_WORKERS=brain_invocation.
  | "brain_invocation"
  // 2026-05-20 (SSGM Lam et al. 2026 arXiv:2603.11768): memory
  // reconciliation worker — 5min tick. Computes per-cache ledger
  // projection hashes; emits memory_reconciliation_completed on
  // clean tick and memory_reconciliation_drift_detected on mismatch.
  // Opt-out via ACC2_DISABLE_WORKERS=memory_reconciliation.
  | "memory_reconciliation"
  // 2026-05-20 (SAHOO Sahoo et al. 2026 arXiv:2603.06333): recursive
  // self-improvement governor — 10min tick. Emits sahoo_diagnostics
  // _recorded (5-tuple). The pure evaluateGoNoGo function is the
  // Go/No-Go gate (callable from amendment apply path).
  // Opt-out via ACC2_DISABLE_WORKERS=sahoo_governor.
  | "sahoo_governor"
  // 2026-05-22 (phase-2 SJPF3VB9 observability-fidelity ceiling):
  // standing observability-fidelity guard. Hourly tick that
  // institutionalizes two bug classes as permanent self-audits:
  // loop_inert_alert when a wired loop emits 0 while its upstream
  // trigger fired (counterfactual / coalition / meta_credit), and
  // metric_veracity_alert when a status metric diverges from ground
  // truth (retrieval index). Built Claude-side after the brain could
  // not build the worker across 3 dispatches. Default ON; opt-out via
  // ACC2_DISABLE_WORKERS=observability_guard.
  | "observability_guard";

/** The full canonical list — useful for tests/preload.ts to disable
 *  everything in one assignment, and for documentation surfaces that want
 *  to print the canonical set. */
export const ALL_WORKER_NAMES: readonly WorkerName[] = [
  "embedder",
  "scheduler",
  "father",
  "rolling_reviewer",
  "rehabilitation",
  "integrity",
  "supervisor",
  "compaction",
  "extractors",
  "amendment",
  "metrics_gauge_refresh",
  "hotreload",
  "recipe_inertia",
  "verify_heal",
  "experience_compression",
  "lifecycle_closure_sweep",
  "contract_amendment_consumer",
  "wal_pressure_check",
  "pending_decision_retire",
  "artifact_kind_backfill",
  "owner_outcome_followup",
  "counterfactual_credit",
  "event_authenticity",
  "storage_integrity_floor",
  "deterministic_computation",
  "kernel_sandbox",
  "owner_identity",
  "archival",
  "brain_invocation",
  "memory_reconciliation",
  "sahoo_governor",
  "observability_guard",
] as const;

/** Parse `ACC2_DISABLE_WORKERS` (comma-separated, whitespace-tolerant) into
 *  a Set of disabled worker names. Empty / unset → empty Set. */
const parseDisabledWorkers = (raw: string | undefined): Set<string> => {
  const value = raw ?? "";
  return new Set(
    value
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );
};

/** Returns `true` iff the named worker should autostart. The daemon calls
 *  this once per worker at boot; tests/preload.ts pins the full set OFF so
 *  the unit suite never hits OpenAI / mutates long-lived substrate state. */
export const isWorkerEnabled = (name: WorkerName): boolean => {
  const disabled = parseDisabledWorkers(process.env.ACC2_DISABLE_WORKERS);
  return !disabled.has(name);
};
