#!/usr/bin/env bun
// `acc watch` — substrate-content-first realtime TUI.
//
// Rewrite (2026-05-17) per brain design D9TBCHADS97DHAMNBC686HE3P0
// residual=0.16. The owner critiqued the previous six-panel/seven-
// question shell as IDs-heavy and complexity-heavy (owner_input_received
// XR3REA7Q7X197AASRH3QXNFF84). The replacement is ONE screen with the
// substrate's narrative event stream as the dominant pane, an active-
// dispatches list, a decisions strip, and an Enter-key drilldown for
// the full payload. Every row shows CONTENT (claim, summary, intent,
// reason) projected by substrate_narrative_recent_view; IDs are
// drilldown-only metadata.

import React from "react";
import { render } from "ink";
import { mcpCall } from "./rpc";
import { App } from "./tui/App";
import { realSubstrateClient } from "./tui/transport/substrate-client";

const HELP = `acc watch — substrate-content-first realtime TUI

usage: acc watch [--help]

  ONE screen: narrative event stream (left), active dispatches (right),
  decisions strip (bottom), small daemon-health footer. Each event row
  is the substrate's human_summary projection — not a hex id.

  Keyboard:
    j / ↓        next row
    k / ↑        previous row
    PgDn / PgUp  page
    Enter        drilldown: full payload + cited refs
    Esc / q      close drilldown / quit
    d            toggle critical+high importance filter
    r            force refresh
`;

export const runWatch = async (argv: string[]): Promise<number> => {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(HELP);
    return 0;
  }

  // Ink puts stdin into raw mode for keystroke routing; on a non-TTY stdin
  // (piped invocation, certain wrappers, `timeout … bun … watch`, CI) the
  // raw-mode toggle throws inside a passive effect and the whole render
  // tree crashes. Fail loud and early with a clean operator message so the
  // bug isn't a stack trace from deep inside react-reconciler.
  if (!process.stdin.isTTY) {
    process.stderr.write(
      "acc watch: stdin is not a TTY. The Ink TUI needs an interactive terminal — " +
      "run it directly (not piped, redirected, or under `timeout`/CI). " +
      "For headless inspection use `acc state me --json` or `acc admin substrate-status`.\n",
    );
    return 1;
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
