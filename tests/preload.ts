// Test preload — runs before every `bun test` test file.
//
// Pins `ACC2_BRIDGE_MODE=mock` for the test suite so the hermetic bridge
// fixtures (fixture_d_count_todos, example.com title fetch, high-residual,
// adversarial cycle-2) drive every dispatch path. Production code defaults
// to `real` — see runtime/bridge.ts opencodeQuery and .env.example.
//
// Individual tests MAY override (e.g. a test that asserts the real-spawn
// surface still does its own beforeEach swap). The default before any test
// runs is `mock`, set unconditionally here so a stray env-var leak from the
// operator's shell cannot route the suite through opencode.
//
// Worker autostart defaults are also pinned here. Production defaults all
// workers ON; tests opt OUT of every worker that would hit external
// services or alter long-lived substrate state, while leaving `integrity`
// and `amendment` on (they are pure-SQLite and required for /ready).
//
// The canonical opt-out is ONE env var — `ACC2_DISABLE_WORKERS` — carrying
// a comma-separated list of worker names (see runtime/worker_autostart.ts
// for the parser + canonical name set). We use `??=` (default-assign) so a
// test wanting to enable specific workers can set its own value FIRST and
// the preload won't clobber.
//
// Wired by bunfig.toml: `preload = ["./tests/preload.ts"]`.

if (process.env.ACC2_BRIDGE_MODE !== "mock") {
  process.env.ACC2_BRIDGE_MODE = "mock";
}

// Tests do NOT autostart any worker that hits external services or alters
// long-lived state. Production defaults to ON; tests explicitly opt out
// via the single canonical env var. `integrity` and `amendment` stay ON
// (pure-SQLite, required for /ready). Tests that boot a subprocess and
// need integrity off for that subprocess (e.g. tests/integration/
// crash_recovery.ts) override per-spawn.
process.env.ACC2_DISABLE_WORKERS ??=
  "embedder,scheduler,father,rolling_reviewer,rehabilitation,supervisor,compaction,extractors,metrics_gauge_refresh,hotreload,recipe_inertia,verify_heal,rendering_audit,lifecycle_closure_sweep,contract_amendment_consumer,wal_pressure_check,pending_decision_retire,artifact_kind_backfill,owner_outcome_followup,counterfactual_credit,event_authenticity,storage_integrity_floor,deterministic_computation,kernel_sandbox,owner_identity,archival,brain_invocation,memory_reconciliation,sahoo_governor";

// Tests must NEVER read or write the operator's live ~/.accint/state.db.
// Pin a per-suite hermetic state dir so admin / CLI tests that open the
// default substrate path don't inherit production substrate state (e.g.
// the updateOpencode cooldown gate would consult real opencode_upgrade_failed
// rows from operator usage and short-circuit the test path).
const homePrefix = process.env.HOME ?? "/no-such-prefix";
if (!process.env.ACC2_STATE_DIR || process.env.ACC2_STATE_DIR.startsWith(homePrefix)) {
  process.env.ACC2_STATE_DIR = `/tmp/acc2-test-state-${process.pid}`;
}
// ACC2_STATE_DB legacy alias removed (brain audit byaeuflif #7, 2026-05-15):
// ACC2_DB_PATH is the sole canonical override; tests pin ACC2_STATE_DIR and
// let runtime/state_paths.ts compose the DB path from it.
