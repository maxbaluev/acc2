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

import { auxRecentEvents } from "./rpc";
import { realSubstrateClient } from "./tui/transport/substrate-client";

// NOTE: `react` / `ink` (and its transitive `yoga-layout`) are NOT imported at
// module top-level. yoga-layout is a WASM-backed ESM module with a circular
// init that, under `bun test --parallel`'s concurrent module loading, hits
// "ReferenceError: Cannot access 'Yoga' before initialization" merely on
// IMPORT. cli/watch.test.ts only checks that `runWatch` exists and the legacy
// stubs are gone — it must be able to import this module WITHOUT triggering
// yoga init. The TUI deps are therefore loaded lazily inside runWatch, right
// before render, so they load only when `acc watch` actually renders.

const HELP = `acc watch — authoritative live operator dashboard

usage: acc watch [--help]

  Rich TUI for humans. It is not a second event parser and not a pretty
  acc events. The screen is composed from bounded substrate projections:
  in-flight dispatches, recent terminal outcomes, ready queue, owner/action
  decisions, daemon/worker health, and a compact recent narrative timeline.

  Restart behavior is visible: during daemon loss/reconnect, keep the last
  confirmed snapshot on screen and show RECONNECTING with the last successful
  refresh time. Never imply fresh state while the transport is disconnected.

  Stream boundary:
    watch   rich dashboard + drilldown for humans
    tail    NDJSON line protocol for scripts/background follows
    events  bounded one-shot recent-event query
    notify  preset alias over tail/events for mirror-inline kinds

  Keyboard:
    j / ↓        next row
    k / ↑        previous row
    PgDn / PgUp  page
    Enter        drilldown: full payload + cited refs
    Esc / q      close drilldown / quit
    p            plain-language view
    d            toggle critical+high importance filter
    r            force bounded snapshot refresh
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
    const probe = await auxRecentEvents({ k: 1 });
    if (probe.ok === false) {
      process.stderr.write(`acc watch: daemon unreachable (${probe.error}). run \`acc daemon start\`.\n`);
      return 1;
    }
  } catch (err) {
    process.stderr.write(`acc watch: daemon unreachable (${String(err)}). run \`acc daemon start\`.\n`);
    return 1;
  }

  // Lazy-load the TUI stack (react + ink + yoga-layout + the App tree) only
  // now, at actual render time. Importing them eagerly at module top-level
  // triggers yoga-layout's circular-init race under parallel test module
  // loading; deferring the import keeps `import("./watch")` side-effect-free.
  const [{ default: React }, { render }, { App }] = await Promise.all([
    import("react"),
    import("ink"),
    import("./tui/App"),
  ]);

  const client = realSubstrateClient();
  const instance = render(React.createElement(App, { client }));
  await instance.waitUntilExit();
  return 0;
};
