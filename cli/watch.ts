#!/usr/bin/env bun
// `acc watch` — Ink-based TUI shell over the seven-question framework.
//
// The TUI is intentionally substrate-bound: every panel renders from one
// canonical view via MCP `substrate.read` (no direct SQLite access). The
// data sources are stable; this file is the render-and-input layer only.
//
// Seven-question wiring (one canonical view per panel):
//   1. WHAT IS IT DOING RIGHT NOW?    dispatch_resolved_view + ready_tasks_view
//   2. WHAT DOES IT WANT FROM ME?     pending_owner_decision_queue_view
//   3. IS IT HEALTHY?                 daemon health + bridge_failed/completed events
//   4. WHAT IS IT LEARNING?           promoted_knowledge_view + contradictory_candidates_view
//   5. WHAT DID IT CHANGE FOR ME?     applied_change_committed + irreversible_effects_view
//   6. HOW WELL DOES IT KNOW ME?      owner_profile_view (rendered via owner_profile_renderer)
//   7. WHAT HAPPENS NEXT IF I IDLE?   ready_tasks_view + active_objectives_view +
//                                     directive_conflicts_view + rolling_review_due_view
//
// SSE events that match MIRROR_INLINE_EVENT_TYPES (from substrate/event_kinds.ts)
// surface as toast banners; everything else is silently absorbed.
//
// The command palette (bottom bar) is the CLI: typed commands resolve to
// `bun run acc <argv>` invocations spawned as Bash subprocesses.

import React from "react";
import { render } from "ink";
import { mcpCall } from "./rpc";
import { App } from "./tui/App";
import { realSubstrateClient } from "./tui/transport/substrate-client";

const HELP = `acc watch — Ink-based live observation TUI

usage: acc watch [--help]

  Six-panel dashboard over the seven canonical substrate views.
  Press ':' to enter the command palette; 'q' to quit; arrows to move
  focus; i=inbox, p=profile, e=events, h=health, l=lineage.
`;

export const runWatch = async (argv: string[]): Promise<number> => {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(HELP);
    return 0;
  }

  // Confirm the daemon is reachable before tearing down the operator's
  // terminal into raw mode. Failure prints the same shape every other
  // CLI surface uses so the operator sees a single error mode.
  try {
    const probe = await mcpCall("runtime.recent_events", { since: Date.now() - 60_000, limit: 1 });
    if (probe.ok === false) {
      process.stderr.write(`acc watch: daemon unreachable (${probe.error}). run \`acc daemon start\`.\n`);
      return 1;
    }
  } catch (err) {
    process.stderr.write(`acc watch: daemon unreachable (${String(err)}). run \`acc daemon start\`.\n`);
    return 1;
  }

  const client = realSubstrateClient();
  const instance = render(React.createElement(App, { client }));
  await instance.waitUntilExit();
  return 0;
};

// Compile-time bridges for any stale import paths (none currently — kept
// as inert stubs so a future caller fails fast at the import site instead
// of getting a runtime undefined).
export const renderFrame = (): string => "";
export const renderPanelLines = (): string[] => [];
export const readDriftSummaries = (): never[] => [];
