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
// Wired by bunfig.toml: `preload = ["./tests/preload.ts"]`.

if (process.env.ACC2_BRIDGE_MODE !== "mock") {
  process.env.ACC2_BRIDGE_MODE = "mock";
}
