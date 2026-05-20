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
  // Brain contract Q471RAN88X0H513V8BC3BTW0AW Phase F (2026-05-17):
  // periodic auditor that closes the 88ESCTN8XN6J gap — the rendering
  // flywheel was persisted+exposed but unconsumed by any always-on
  // worker. The tick scans recent rendered_owner_message_recorded rows
  // that lack feedback, runs verifyRendering against the current policy,
  // and emits owner_rendering_feedback_recorded with feedback_kind=
  // auto_verifier|auto_verifier_clean so the policy posterior moves
  // on machine evidence before any owner reacts.
  | "rendering_audit"
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
  | "owner_identity";

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
  "rendering_audit",
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
