#!/usr/bin/env bun
// `acc watch` — skeleton placeholder.
//
// The legacy six-pane TUI (1054 lines, 19 panes worth of bespoke rendering
// against direct SQLite + SSE) was removed 2026-05-16 per owner directive.
// The substrate has converged enough since that the next observation surface
// belongs upstream: hooks into Claude Code's background-task panel, an
// embedded MCP-driven panel, or a structured per-turn dispatch-status table
// rendered by the orchestrator from `substrate.read("dispatch_resolved_view")`.
//
// This skeleton exists so:
//   1. `acc watch` remains a registered command — `cli/dispatch.ts` still
//      routes to `runWatch`, the ask router still scores "watch" intent,
//      and the docs that mention `acc watch` still resolve to something.
//   2. The next implementation has a clear seam to fill: replace `runWatch`
//      with the new observation loop.
//
// Implementation guidance for whoever picks this up:
//   - Read the most recent `acc task` audit on observation surface design.
//   - Prefer pushing state TO the operator (hook / SSE injection) over
//     pulling state INTO a long-running TUI process.
//   - If a TUI is still wanted, it should subscribe to the canonical event
//     bus via `sseConnect()` from `./rpc` — never open SQLite directly.

import { mcpCall } from "./rpc";

export const runWatch = async (_argv: string[]): Promise<number> => {
  console.error("acc watch: legacy TUI removed; skeleton placeholder pending replacement.");
  console.error("");
  console.error("Until the new observation surface lands, use:");
  console.error("  acc tail                 # narrative event stream (one event per line)");
  console.error("  acc events --kind ...    # filtered event projection");
  console.error("  acc daemon status        # daemon + worker health");
  console.error("  acc admin substrate-status   # one-screen substrate liveness");
  console.error("");

  // Confirm daemon reachability so the skeleton at least proves the MCP
  // surface is alive. If this call fails the operator gets the same
  // fetch_failed error every other CLI command shows — single failure mode.
  try {
    const r = await mcpCall("runtime.recent_events", { since: Date.now() - 60_000, limit: 1 });
    const ok = r?.result !== undefined;
    console.error(ok ? "daemon: reachable" : "daemon: unreachable");
    return ok ? 0 : 1;
  } catch (err) {
    console.error(`daemon: unreachable (${String(err)})`);
    return 1;
  }
};

// Re-exported empty stubs so any stale import path remains a compile-time
// resolution rather than a runtime crash. The pending-decisions stub
// (readPendingDecisions = (): never[] => []) was deleted because it
// caused the orchestrator to silently miss 89 owner-gated proposals
// over 33 hours. The canonical surface for pending decisions is now
// `acc admin pending-decisions` (cli/admin_pending_decisions.ts) which
// reads pending_owner_decision_queue_view directly. If a future TUI
// wants the same data, call that view via substrate.read — do NOT
// reintroduce a local stub that returns [].
export const renderFrame = (): string => "";
export const renderPanelLines = (): string[] => [];
export const readDriftSummaries = (): never[] => [];
