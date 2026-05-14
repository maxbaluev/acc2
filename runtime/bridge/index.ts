// acc2 brain-bridge — mode-aware entrypoint plus the public surface
// re-exported from the focused module split:
//   - ./types.ts     — BridgeRequest, BridgeFailureReason, BridgeResult, SpawnOpts
//   - ./mock.ts      — opencodeQueryMock, FIXTURE_* markers, adversarial /
//                      high-residual variants
//   - ./opencode.ts  — spawnRealOpencode (subprocess wrangling + frame parsing)
//   - ./config.ts    — materializeOpencodeMcpConfig, V2_OPENCODE_MCP_SERVER_NAME,
//                      V2_MCP_TOOL_SURFACE
//
// `runtime/bridge.ts` re-exports this index for backward compatibility so
// every existing `from "./bridge"` / `from "../runtime/bridge"` import
// resolves identically (v2-design.md §12).
//
// Decision flow: `opencodeQuery` reads `ACC2_BRIDGE_MODE`. **Default is
// `real`** (production dispatch via the real `opencode run` subprocess).
// Tests opt into `mock` explicitly by setting `ACC2_BRIDGE_MODE=mock` —
// the `bun test` runner does so via the `bunfig.toml` preload
// (`tests/preload.ts`) so unit tests stay hermetic by default. The
// integration harness's 9 plumbing scenarios also pin mock explicitly;
// the 10th scenario (`real_brain_end_to_end`) and
// `tests/integration/real_brain_smoke.ts` exercise the real path.

import type { Database } from "bun:sqlite";
import type { BridgeRequest, BridgeResult } from "./types";
import { opencodeQueryMock } from "./mock";
import { spawnRealOpencode } from "./opencode";

export const opencodeQuery = async (
  req: BridgeRequest,
  db: Database,
): Promise<BridgeResult> => {
  const mode = process.env.ACC2_BRIDGE_MODE ?? "real";
  if (mode === "mock") {
    return opencodeQueryMock(req, db);
  }
  return spawnRealOpencode(req, db);
};

// ── Public surface (backward-compatible re-exports) ───────────────

export type {
  BridgeRequest,
  BridgeFailureReason,
  BridgeResult,
  SpawnOpts,
} from "./types";

export {
  FIXTURE_BUSINESS_OUTREACH_MARKER,
  FIXTURE_RESEARCH_SUMMARY_MARKER,
  FIXTURE_CREATIVE_CONSTRAINT_MARKER,
  FIXTURE_MULTI_STAKEHOLDER_MARKER,
  FIXTURE_HEALTH_DECISION_MARKER,
  FIXTURE_EMBODIED_RECIPE_MARKER,
  FIXTURE_LONG_HORIZON_SAVINGS_MARKER,
  FIXTURE_CRISIS_RESPONSE_MARKER,
  opencodeQueryMock,
  opencodeQueryHighResidual,
  opencodeQueryAdversarialCycle2,
} from "./mock";

export { spawnRealOpencode } from "./opencode";

export {
  V2_OPENCODE_MCP_SERVER_NAME,
  V2_MCP_TOOL_SURFACE,
  materializeOpencodeMcpConfig,
} from "./config";
