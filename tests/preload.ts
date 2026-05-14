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
// workers ON (the daemon flips every ACC2_*_AUTOSTART gate to opt-OUT in
// runtime/daemon.ts). Tests explicitly opt OUT of every worker that would
// hit external services or alter long-lived substrate state, while leaving
// `integrity` and `amendment` on (they are pure-SQLite and required for
// /ready). We use `??=` (default-assign) so any test wanting to enable one
// of them (e.g. a future embedder integration test) can set its own value
// FIRST and the preload won't clobber.
//
// Wired by bunfig.toml: `preload = ["./tests/preload.ts"]`.

if (process.env.ACC2_BRIDGE_MODE !== "mock") {
  process.env.ACC2_BRIDGE_MODE = "mock";
}

// Tests do NOT autostart the workers that hit external services or alter
// long-lived state. Production defaults to ON; tests explicitly opt out.
process.env.ACC2_EMBEDDER_AUTOSTART ??= "0";  // would call OpenAI
process.env.ACC2_FATHER_AUTOSTART ??= "0";    // alters substrate cadence
process.env.ACC2_AUTOSCHEDULER ??= "0";       // background dispatch loop
process.env.ACC2_ROLLING_AUTOSTART ??= "0";   // periodic review writes
process.env.ACC2_REHAB_AUTOSTART ??= "0";     // re-runs artifact fixtures
