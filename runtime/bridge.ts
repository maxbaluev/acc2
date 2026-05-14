// acc2 brain bridge — backward-compatible re-export shim.
//
// The implementation was split into a `runtime/bridge/` directory:
//   - bridge/index.ts     — mode-aware `opencodeQuery` entrypoint
//   - bridge/types.ts     — BridgeRequest / BridgeResult / SpawnOpts
//   - bridge/mock.ts      — opencodeQueryMock + every BATCH5_FIXTURES marker
//                           + adversarial / high-residual variants
//   - bridge/opencode.ts  — spawnRealOpencode (subprocess wrangling + framing)
//   - bridge/config.ts    — materializeOpencodeMcpConfig + V2_* constants
//
// This shim keeps `from "./bridge"` / `from "../runtime/bridge"` imports
// resolving identically so every existing consumer (task_dispatcher.ts,
// task_dispatcher.test.ts, bridge.test.ts, alignment/cycle_one.test.ts,
// tests/integration/scenarios.ts, runtime/fixtures/*.ts) continues to
// work without changes.

export * from "./bridge/index";
