// acc2 daemon hot-reload worker (brain audit bqlr29psq, 2026-05-15).
//
// Watches every directory under WATCHED_DIRECTORIES via fs.watch. When
// a change lands, the worker:
//   1. Matches the file against the manifest (runtime/hotreload_manifest.ts).
//   2. Debounces bursty file events so a save + format pass don't double-trigger.
//   3. Emits daemon_hotreload_triggered with the matched entry name + strategy.
//   4. Applies the strategy:
//        in_process     — dynamic import with `?hotreload=<ts>` cache-bust;
//                         emits daemon_hotreload_completed on success.
//        quiescent_only — defers the reload until quiescenceCheck() returns
//                         true (no open brain dispatch). The deferred queue
//                         retries on every subsequent reload tick.
//        full_restart   — emits daemon_hotreload_failed with reason
//                         "full_restart_required" so the operator sees a
//                         clear hint to run `acc daemon restart`.
//   5. On any thrown error (syntax error in the new file, missing expected
//      export, etc.) emits daemon_hotreload_failed; the daemon stays alive
//      because the original module reference is never overwritten.
//
// The watcher is observational-only by design: it does NOT mutate
// already-imported references in the rest of the daemon. Reloadable
// modules are accessed by their importers via a get-on-each-call indirection
// (e.g. the extractors worker imports extractKnowledgePromotions at tick
// time, not at boot). The hot-reload event tells the rest of the daemon
// "next call will see new code"; the cache-bust forces the dynamic import.

import { existsSync, readdirSync, statSync, watch as fsWatch } from "node:fs";
import { join, relative, sep } from "node:path";
import type { Database } from "bun:sqlite";
import { emitEvent } from "./events";
import { logger } from "./logger";
import {
  HOTRELOAD_MANIFEST,
  WATCHED_DIRECTORIES,
  matchHotReloadEntry,
  type HotReloadEntry,
} from "./hotreload_manifest";

const DEBOUNCE_MS = 250;
const QUIESCENT_RETRY_MS = 30_000;

export type HotReloadState = {
  last_reload_ts: string | null;
  last_reload_module: string | null;
  last_reload_strategy: HotReloadEntry["strategy"] | null;
  last_failure: { ts: string; module: string; reason: string } | null;
  watched_module_count: number;
  pending_quiescent_count: number;
  reload_total: number;
  failure_total: number;
};

const state: HotReloadState = {
  last_reload_ts: null,
  last_reload_module: null,
  last_reload_strategy: null,
  last_failure: null,
  watched_module_count: HOTRELOAD_MANIFEST.length,
  pending_quiescent_count: 0,
  reload_total: 0,
  failure_total: 0,
};

export const getHotreloadState = (): HotReloadState => ({ ...state });

/** Linux does not support fs.watch({ recursive:true }). Watch every existing
 *  directory under the manifest roots so nested files such as
 *  runtime/bridge/opencode.ts generate events on all supported platforms. */
export const collectHotreloadWatchDirs = (projectRoot: string): string[] => {
  const out: string[] = [];
  const visit = (abs: string): void => {
    if (!existsSync(abs)) return;
    let st;
    try { st = statSync(abs); } catch { return; }
    if (!st.isDirectory()) return;
    out.push(abs);
    let entries;
    try { entries = readdirSync(abs, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      visit(join(abs, entry.name));
    }
  };
  for (const dir of WATCHED_DIRECTORIES) visit(join(projectRoot, dir));
  return out;
};

export type StartHotreloadOpts = {
  projectRoot: string;
  /** Returns true when no brain dispatch is in-flight; the quiescent_only
   *  strategy waits for this to flip before re-importing. */
  isQuiescent: () => boolean;
};

export const startHotreloadWorker = (
  db: Database,
  opts: StartHotreloadOpts,
): (() => void) => {
  const { projectRoot, isQuiescent } = opts;
  const watchers: Array<{ close: () => void }> = [];
  const debounceTimers = new Map<string, NodeJS.Timeout>();
  const pendingQuiescent = new Map<string, HotReloadEntry>(); // file_path → entry
  let disposed = false;

  const processChange = (relPath: string): void => {
    const entry = matchHotReloadEntry(relPath);
    if (!entry) return;
    try {
      emitEvent(db, {
        kind: "daemon_hotreload_triggered",
        substrate_origin: "substrate_auto",
        payload: {
          module: entry.name,
          file_path: relPath,
          strategy: entry.strategy,
          reason: entry.reason,
        },
      });
    } catch (err) {
      logger.debug({ where: "hotreload.emit_triggered", err: String(err) }, "could not emit daemon_hotreload_triggered");
    }

    if (entry.strategy === "full_restart") {
      try {
        emitEvent(db, {
          kind: "daemon_hotreload_failed",
          substrate_origin: "substrate_auto",
          payload: {
            module: entry.name,
            file_path: relPath,
            strategy: entry.strategy,
            reason: "full_restart_required",
            hint: "module requires fresh process (MCP server / DB / daemon entrypoint); run `acc daemon restart` when convenient",
          },
        });
        state.last_failure = { ts: new Date().toISOString(), module: entry.name, reason: "full_restart_required" };
        state.failure_total++;
      } catch (err) {
        logger.debug({ where: "hotreload.emit_full_restart", err: String(err) }, "could not emit daemon_hotreload_failed");
      }
      return;
    }

    if (entry.strategy === "quiescent_only" && !isQuiescent()) {
      pendingQuiescent.set(relPath, entry);
      state.pending_quiescent_count = pendingQuiescent.size;
      return;
    }

    applyReload(relPath, entry);
  };

  const applyReload = (relPath: string, entry: HotReloadEntry): void => {
    // Cache-bust the dynamic import so node resolves the on-disk text.
    const absPath = join(projectRoot, relPath);
    const url = `file://${absPath}?hotreload=${Date.now()}`;
    void (async () => {
      try {
        // The actual semantic swap happens at the importer's next call —
        // any module that imports the reloaded file with a dynamic
        // `import(url)` will see the new code. Eager-imported modules
        // would need a get-on-each-call indirection to pick up the
        // change, which is a follow-on patch beyond this worker.
        await import(url);
        state.last_reload_ts = new Date().toISOString();
        state.last_reload_module = entry.name;
        state.last_reload_strategy = entry.strategy;
        state.reload_total++;
        pendingQuiescent.delete(relPath);
        state.pending_quiescent_count = pendingQuiescent.size;
        // Brain convergence axis E (2026-05-15): invalidate any
        // process-local caches the manifest declares the reloaded
        // module owns. Without this, hot-reloading prompt_composer
        // would re-import the new code but downstream dispatches
        // would still serve cached prompts built by the old code.
        const invalidatedCaches: string[] = [];
        if (entry.invalidates && entry.invalidates.length > 0) {
          for (const cacheName of entry.invalidates) {
            try {
              if (cacheName === "prompt_cache") {
                const { invalidatePromptCache } = await import("./prompt_cache");
                invalidatePromptCache();
                invalidatedCaches.push(cacheName);
              } else if (cacheName === "activation_bus_listeners") {
                // Reserved — listener cleanup would break in-flight
                // worker subscriptions. Implementing this needs a
                // worker-reregister hook, deferred.
              }
            } catch (err) {
              logger.warn(
                { where: "hotreload.invalidate_cache", cache: cacheName, err: (err as Error).message },
                "cache invalidation failed",
              );
            }
          }
        }
        try {
          emitEvent(db, {
            kind: "daemon_hotreload_completed",
            substrate_origin: "substrate_auto",
            payload: {
              module: entry.name,
              file_path: relPath,
              strategy: entry.strategy,
              cache_bust_url: url,
              invalidated_caches: invalidatedCaches,
            },
          });
        } catch (err) {
          logger.debug({ where: "hotreload.emit_completed", err: String(err) }, "could not emit daemon_hotreload_completed");
        }
      } catch (err) {
        const reason = (err as Error).message ?? String(err);
        state.last_failure = { ts: new Date().toISOString(), module: entry.name, reason };
        state.failure_total++;
        try {
          emitEvent(db, {
            kind: "daemon_hotreload_failed",
            substrate_origin: "substrate_auto",
            payload: {
              module: entry.name,
              file_path: relPath,
              strategy: entry.strategy,
              reason,
              cache_bust_url: url,
            },
          });
        } catch (emitErr) {
          logger.debug({ where: "hotreload.emit_failed", err: String(emitErr) }, "could not emit daemon_hotreload_failed");
        }
        logger.warn(
          { where: "hotreload.apply", module: entry.name, file_path: relPath, err: reason },
          "hot-reload failed — previous module reference retained, daemon stays alive",
        );
      }
    })();
  };

  // Drain the pending-quiescent queue every QUIESCENT_RETRY_MS so deferred
  // reloads land as soon as the bridge goes idle.
  const quiescentDrain = setInterval(() => {
    if (disposed) return;
    if (pendingQuiescent.size === 0) return;
    if (!isQuiescent()) return;
    for (const [relPath, entry] of pendingQuiescent) {
      applyReload(relPath, entry);
    }
    pendingQuiescent.clear();
    state.pending_quiescent_count = 0;
  }, QUIESCENT_RETRY_MS);

  // Linux does not support recursive fs.watch. Watch every existing
  // directory under the manifest roots and convert each event back to the
  // project-relative path expected by matchHotReloadEntry.
  for (const abs of collectHotreloadWatchDirs(projectRoot)) {
    try {
      const w = fsWatch(abs, (eventType, filename) => {
        void eventType;
        if (!filename) return;
        const projectRelative = toProjectRelative(join(abs, filename.toString()), projectRoot);
        // Debounce per file_path to absorb burst events from editor saves.
        const existing = debounceTimers.get(projectRelative);
        if (existing) clearTimeout(existing);
        debounceTimers.set(
          projectRelative,
          setTimeout(() => {
            debounceTimers.delete(projectRelative);
            if (disposed) return;
            processChange(projectRelative);
          }, DEBOUNCE_MS),
        );
      });
      watchers.push(w);
    } catch (err) {
      logger.warn({ where: "hotreload.fs_watch", dir: toProjectRelative(abs, projectRoot), err: (err as Error).message }, "fs.watch failed for directory");
    }
  }

  logger.info(
    { where: "hotreload.start", watched_dirs: WATCHED_DIRECTORIES, manifest_entries: HOTRELOAD_MANIFEST.length },
    "hot-reload worker active",
  );

  return () => {
    disposed = true;
    clearInterval(quiescentDrain);
    for (const w of watchers) {
      try { w.close(); } catch { /* swallow */ }
    }
    for (const t of debounceTimers.values()) {
      try { clearTimeout(t); } catch { /* swallow */ }
    }
    debounceTimers.clear();
  };
};

/** Helper for tests: render the manifest into the shape /health exposes. */
export const renderHotreloadHealth = (s: HotReloadState = state): HotReloadState => ({ ...s });

/** Convenience for the importers — relative path utility kept here so
 *  tests that simulate the watcher don't need their own path helpers. */
export const toProjectRelative = (absPath: string, projectRoot: string): string => {
  const rel = relative(projectRoot, absPath);
  return rel.split(sep).join("/");
};
