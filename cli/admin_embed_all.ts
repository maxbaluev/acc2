// `acc admin embed-all` — synchronous one-shot embedder pass.
//
// Why this surface exists (substrate-liveness invariant): a fresh
// install + `acc init` lays down 10 foundational knowledge events,
// the seed code-artifact registry, and 2 canonical recipes. Until
// the daemon is running, none of those text-bearing events have
// embeddings — so `substrate.search` against the brand-new DB
// returns nothing useful and the brain's first dispatch sees a
// starved RLM surface.
//
// `acc admin embed-all` blocks the operator until every pending
// embeddable event lands in `vec_events`. The init flow can call it
// after seeding to guarantee the substrate is LIVE before the daemon
// ticks; operators can re-run it after `acc admin import` or any
// other bulk-event ingress that bypassed the worker.
//
// Concurrency guard: refuses while the daemon is running. The daemon's
// embedder worker fires every few seconds and would race this caller.
// Failing fast with a clear pointer at `acc daemon stop` is the
// canonical operator-facing message.

import type { Database } from "bun:sqlite";
import { openDb } from "../substrate/db";
import { embedPendingEvents } from "../runtime/embedder";
import { resolveDbPath } from "../runtime/state_paths";
import { readDaemonLock } from "./rpc";

export type EmbedAllEnv = {
  /** Open or reuse a DB handle.  Tests inject an in-memory DB. */
  openSubstrate?: (path?: string) => Database;
  /** Probe the daemon lock — when present we refuse to run. Tests can
   *  stub this to simulate "daemon running". Default reads the canonical
   *  socket file via `readDaemonLock`. */
  daemonRunning?: () => boolean;
  /** Path of the on-disk DB; used when `openSubstrate` falls back to
   *  the default opener. */
  stateDbPath?: string;
  out: (line: string) => void;
  err: (line: string) => void;
};

const defaultStateDbPath = (): string => {
  return resolveDbPath();
};

const defaultEnv = (): EmbedAllEnv => ({
  openSubstrate: (path?: string) => openDb(path ?? defaultStateDbPath()),
  daemonRunning: () => readDaemonLock() !== null,
  stateDbPath: defaultStateDbPath(),
  out: (line) => console.log(line),
  err: (line) => console.error(line),
});

/** Programmatic entry. Returns a UNIX-style exit code (0 = success). */
export const runEmbedAll = async (
  _argv: string[],
  envOverride?: EmbedAllEnv,
): Promise<number> => {
  const env: EmbedAllEnv = { ...defaultEnv(), ...(envOverride ?? {}) };
  if (env.daemonRunning?.() ?? false) {
    env.err(
      "acc admin embed-all: daemon is running — refusing to race the embedder worker.",
    );
    env.err("Stop the daemon first: `acc daemon stop`");
    return 1;
  }
  let db: Database;
  try {
    db = (env.openSubstrate ?? ((path?: string) => openDb(path ?? defaultStateDbPath())))(
      env.stateDbPath,
    );
  } catch (err) {
    env.err(
      `acc admin embed-all: failed to open substrate: ${(err as Error).message}`,
    );
    return 1;
  }
  const result = await embedPendingEvents(db);
  env.out(
    `embedded: ${result.embedded}, skipped: ${result.skipped}, failed: ${result.failed}`,
  );
  return 0;
};

if (import.meta.main) {
  void runEmbedAll(process.argv.slice(2)).then((code) => process.exit(code));
}
