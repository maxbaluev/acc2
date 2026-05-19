// Canonical worker autostart resolver — one env var, all workers.
//
// Background. The daemon starts six always-on workers (embedder, scheduler,
// father, rolling-reviewer, rehabilitation, integrity). Each used to carry
// its OWN opt-OUT env var (`ACC2_EMBEDDER_AUTOSTART`, `ACC2_FATHER_AUTOSTART`,
// `ACC2_AUTOSCHEDULER`, ...). Operators had to remember six exact names and
// every new worker added a seventh — per-worker env-var drift waiting to
// happen. Per the CLAUDE.md "No legacy/fallback/backward-compatibility code"
// rule, the legacy per-worker env vars are REMOVED — clean break, no
// back-compat.
//
// The canonical shape is ONE env var, comma-separated, listing workers to
// DISABLE. Empty / unset = all workers run (the production default). Tests
// pin every worker off via `tests/preload.ts` so the unit suite stays
// hermetic.
//
//   ACC2_DISABLE_WORKERS=                            # all six on (default)
//   ACC2_DISABLE_WORKERS=embedder                    # disable embedder only
//   ACC2_DISABLE_WORKERS=embedder,father             # disable two
//   ACC2_DISABLE_WORKERS=embedder, father, scheduler # whitespace tolerated
//
// Unknown worker names in the list are accepted silently (no crash). They
// simply have no effect because `isWorkerEnabled` only consults the set for
// the canonical names. This keeps the helper forward-compatible if an
// operator's env-var still references a deprecated worker spelling — it
// becomes a no-op rather than a hard failure.
//
// The legacy per-worker env vars (`ACC2_EMBEDDER_AUTOSTART`,
// `ACC2_FATHER_AUTOSTART`, `ACC2_ROLLING_AUTOSTART`, `ACC2_REHAB_AUTOSTART`,
// `ACC2_INTEGRITY_AUTOSTART`, `ACC2_AUTOSCHEDULER`) are NO LONGER read by
// the daemon. Use `ACC2_DISABLE_WORKERS` instead.

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
  // bounded cadence and emits knowledge_promoted / act_artifact_promoted /
  // recipe_promoted when posteriors cross promotion thresholds.
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
  | "lifecycle_closure_sweep";

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
