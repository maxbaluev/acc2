// acc2 daemon hot-reload worker (brain audit bqlr29psq, 2026-05-15;
// deep improvement 2026-05-17).
//
// Watches every directory under WATCHED_DIRECTORIES via fs.watch. When
// a change lands, the worker:
//   1. Matches the file against the manifest (runtime/hotreload_manifest.ts).
//      A miss inside a watched dir emits daemon_hotreload_unmapped so the
//      operator sees the gap.
//   2. Debounces bursty file events so a save + format pass don't double-trigger.
//   3. Rate-limits per file — too many reloads in a sliding window emit
//      daemon_hotreload_rate_limited and DROP the reload. Save-loop
//      protection (CI watchers, formatters rewriting after every save).
//   4. Emits daemon_hotreload_triggered with the matched entry name +
//      strategy + reloadable_slot.
//   5. Applies the strategy:
//        in_process     — dynamic import with `?hotreload=<ts>` cache-bust;
//                         VALIDATES expected_exports; runs smoke_probe (if
//                         declared); refuses the swap on either failure
//                         (emits daemon_hotreload_rejected); otherwise
//                         either swaps into the reloadable registry slot
//                         (daemon_hotreload_swapped) or, when no slot is
//                         declared, emits daemon_hotreload_no_op — the
//                         import succeeded but no consumer reads through
//                         the indirection, so live behavior did NOT
//                         change. Truth-in-audit.
//        quiescent_only — defers the reload until quiescenceCheck() returns
//                         true (no open brain dispatch). The deferred queue
//                         retries on every subsequent reload tick.
//        full_restart   — emits daemon_hotreload_restart_pending with reason
//                         "full_restart_required" so the operator sees a
//                         clear hint to run `acc daemon restart`.
//   6. On any thrown error (syntax error in the new file, missing expected
//      export, smoke probe failure) emits daemon_hotreload_failed; the
//      daemon stays alive because the reloadable registry keeps the
//      previous reference.

import { existsSync, readdirSync, readFileSync, statSync, unlinkSync, watch as fsWatch, writeFileSync } from "node:fs";
import { dirname, basename, join, relative, sep } from "node:path";
import { randomBytes } from "node:crypto";
import type { Database } from "bun:sqlite";
import { emitEvent } from "./events";
import { logger } from "./logger";
import {
  HOTRELOAD_MANIFEST,
  WATCHED_DIRECTORIES,
  matchHotReloadEntry,
  type HotReloadEntry,
} from "./hotreload_manifest";
import { getReloadable } from "./reloadable";

const DEBOUNCE_MS = 250;
const QUIESCENT_RETRY_MS = 30_000;

export type HotReloadOutcome = {
  ts: string;
  module: string;
  file_path: string;
  outcome: "swapped" | "no_op" | "rejected" | "rate_limited" | "failed" | "unmapped" | "deferred_quiescent" | "full_restart_required";
  reason?: string;
};

export type HotReloadState = {
  last_reload_ts: string | null;
  last_reload_module: string | null;
  last_reload_strategy: HotReloadEntry["strategy"] | null;
  last_failure: { ts: string; module: string; reason: string } | null;
  last_rejected: { ts: string; module: string; reason: string } | null;
  last_unmapped: { ts: string; file_path: string } | null;
  watched_module_count: number;
  pending_quiescent_count: number;
  reload_total: number;
  swapped_total: number;
  no_op_total: number;
  rejected_total: number;
  rate_limited_total: number;
  unmapped_total: number;
  failure_total: number;
  /** Bounded ring of recent reload outcomes, ts-ascending. Operators
   *  read via /health → `acc daemon status` and the new admin surface. */
  recent_outcomes: HotReloadOutcome[];
};

const RECENT_OUTCOMES_CAP = 20;

const state: HotReloadState = {
  last_reload_ts: null,
  last_reload_module: null,
  last_reload_strategy: null,
  last_failure: null,
  last_rejected: null,
  last_unmapped: null,
  watched_module_count: HOTRELOAD_MANIFEST.length,
  pending_quiescent_count: 0,
  reload_total: 0,
  swapped_total: 0,
  no_op_total: 0,
  rejected_total: 0,
  rate_limited_total: 0,
  unmapped_total: 0,
  failure_total: 0,
  recent_outcomes: [],
};

const recordOutcome = (outcome: HotReloadOutcome): void => {
  state.recent_outcomes.push(outcome);
  if (state.recent_outcomes.length > RECENT_OUTCOMES_CAP) {
    state.recent_outcomes.shift();
  }
};

export const getHotreloadState = (): HotReloadState => ({
  ...state,
  recent_outcomes: [...state.recent_outcomes],
});

/** Test-only — reset the worker's process-local state between cases. */
export const __resetHotreloadStateForTests = (): void => {
  state.last_reload_ts = null;
  state.last_reload_module = null;
  state.last_reload_strategy = null;
  state.last_failure = null;
  state.last_rejected = null;
  state.last_unmapped = null;
  state.pending_quiescent_count = 0;
  state.reload_total = 0;
  state.swapped_total = 0;
  state.no_op_total = 0;
  state.rejected_total = 0;
  state.rate_limited_total = 0;
  state.unmapped_total = 0;
  state.failure_total = 0;
  state.recent_outcomes = [];
};

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

/** Editor-noise patterns we always skip BEFORE manifest matching.
 *  Bun.write + atomic-rename, editor swap files, OS metadata, and
 *  test files (which never need reload) flood `daemon_hotreload_unmapped`
 *  otherwise. Live evidence 2026-05-17: 17 unmapped events in one hour
 *  were all `App.test.tsx.tmp.NNN.NNN` editor backups, swamping the
 *  signal-bearing unmapped surface. Match by filename suffix and the
 *  `*.tmp.*` infix produced by Bun.write's atomic-rename path. */
const NOISE_FILE_PATTERNS: RegExp[] = [
  /\.tmp\.\d+(\.\d+)?$/,        // Bun.write atomic-rename: foo.ts.tmp.PID.MS
  /\.swp$|\.swx$|\.swo$/,        // vim swap
  /~$/,                           // emacs backup
  /^\.#|^#.*#$/,                  // emacs lockfile / autosave
  /\.bak$/,                       // generic backup
  /\.DS_Store$/,                  // macOS metadata
  /\.test\.tsx?$/,                // test files (never need reload)
  /\.spec\.tsx?$/,                // spec files (test alias)
  // Hot-reload sibling-temp-copy files written by prepareHotReloadCacheBust.
  // The watcher MUST ignore these or every reload triggers another reload —
  // an infinite loop. Pattern matches `.<basename>.hotreload-temp.<hex>.ts`.
  /\.hotreload-temp\.[0-9a-f]+\.tsx?$/,
];

export const isNoiseFile = (relPath: string): boolean => {
  for (const re of NOISE_FILE_PATTERNS) if (re.test(relPath)) return true;
  return false;
};

/** Prepare a fresh-cache import URL for a source module.
 *
 *  Bun's ESM resolver strips query strings — `await import("file://path?hotreload=N")`
 *  returns the EXACT same module instance as the boot-time
 *  `import "./path"`. Probe evidence 2026-05-17: `same module ns? true`,
 *  `same EVENT_KINDS obj? true`. The previous query-bust scheme was a
 *  structural no-op; the slot.refresh load() ran and did
 *  `cachedKinds = mod.EVENT_KINDS` against the SAME reference — every
 *  hot-reload reported `swapped/version=N` but the live consumer saw
 *  zero behavioral change. Only a full daemon restart picked up new
 *  kinds.
 *
 *  Working fix: write the source as a SIBLING TEMP FILE with a unique
 *  hex suffix. Bun resolves it as a fresh module (unique path = unique
 *  cache key). Sibling placement preserves relative-import resolution
 *  (e.g. `import "../runtime/reloadable"` from
 *  `substrate/.event_kinds.hotreload-temp.<hex>.ts` resolves the same
 *  as from the original). The noise filter excludes
 *  `*.hotreload-temp.<hex>.ts` so the watcher does NOT recurse.
 *
 *  Returns the file:// URL of the temp copy + a cleanup callback the
 *  worker invokes after slot.refresh resolves (success or failure). */
export const prepareHotReloadCacheBust = (
  absPath: string,
): { url: string; tempPath: string; cleanup: () => void } => {
  const dir = dirname(absPath);
  const base = basename(absPath);
  const stem = base.replace(/\.(tsx?|jsx?|mjs|cjs)$/, "");
  const ext = base.match(/\.(tsx?|jsx?|mjs|cjs)$/)?.[0] ?? ".ts";
  const tempPath = join(dir, `.${stem}.hotreload-temp.${randomBytes(4).toString("hex")}${ext}`);
  const text = readFileSync(absPath, "utf8");
  writeFileSync(tempPath, text);
  return {
    url: `file://${tempPath}`,
    tempPath,
    cleanup: () => {
      try {
        unlinkSync(tempPath);
      } catch (err) {
        logger.debug(
          { where: "hotreload.cleanup_temp", tempPath, err: String(err) },
          "could not unlink hot-reload temp file (already gone?)",
        );
      }
    },
  };
};

/** Validate that the freshly-imported module has every export named in
 *  the manifest's `expected_exports`. Returns null on success, or an
 *  error string describing the first missing/wrong export. Pure check. */
export const validateExpectedExports = (
  mod: unknown,
  expected: ReadonlyArray<string> | undefined,
): string | null => {
  if (!expected || expected.length === 0) return null;
  if (!mod || typeof mod !== "object") return "module is not an object";
  const record = mod as Record<string, unknown>;
  for (const exportName of expected) {
    const val = record[exportName];
    if (val === undefined) return `missing export: ${exportName}`;
    const t = typeof val;
    if (t !== "function" && t !== "object" && t !== "string" && t !== "number" && t !== "boolean") {
      return `export ${exportName} has unsupported type: ${t}`;
    }
  }
  return null;
};

export const startHotreloadWorker = (
  db: Database,
  opts: StartHotreloadOpts,
): (() => void) => {
  const { projectRoot, isQuiescent } = opts;
  const watchers: Array<{ close: () => void }> = [];
  const debounceTimers = new Map<string, NodeJS.Timeout>();
  const pendingQuiescent = new Map<string, HotReloadEntry>(); // file_path → entry
  const rateLimitWindows = new Map<string, number[]>(); // file_path → ts[]
  let disposed = false;

  const checkRateLimit = (relPath: string, entry: HotReloadEntry): boolean => {
    const rl = entry.rate_limit;
    if (!rl) return true;
    const now = Date.now();
    const windowStart = now - rl.window_ms;
    const ts = rateLimitWindows.get(relPath) ?? [];
    const fresh = ts.filter((t) => t > windowStart);
    if (fresh.length >= rl.count) {
      rateLimitWindows.set(relPath, fresh);
      return false;
    }
    fresh.push(now);
    rateLimitWindows.set(relPath, fresh);
    return true;
  };

  const processChange = (relPath: string): void => {
    // Filter editor / build / OS noise BEFORE manifest matching so the
    // `unmapped` surface stays signal-bearing. Pre-fix, Bun.write atomic
    // renames (`*.tmp.PID.MS`) and vim swap files flooded the unmapped
    // stream and made it useless for spotting genuine missing-manifest
    // entries. The noise patterns are pure regex — see NOISE_FILE_PATTERNS.
    if (isNoiseFile(relPath)) return;
    const entry = matchHotReloadEntry(relPath);
    if (!entry) {
      // Unmapped file under a watched directory — emit so operator can
      // extend the manifest. Pre-fix these silently dropped.
      try {
        emitEvent(db, {
          kind: "daemon_hotreload_unmapped",
          substrate_origin: "substrate_auto",
          payload: {
            file_path: relPath,
            watched_directories: [...WATCHED_DIRECTORIES],
            hint: "extend HOTRELOAD_MANIFEST in runtime/hotreload_manifest.ts to make this file reloadable",
          },
        });
        state.last_unmapped = { ts: new Date().toISOString(), file_path: relPath };
        state.unmapped_total++;
        recordOutcome({
          ts: state.last_unmapped.ts,
          module: "(unmapped)",
          file_path: relPath,
          outcome: "unmapped",
        });
      } catch (err) {
        logger.debug({ where: "hotreload.emit_unmapped", err: String(err) }, "could not emit daemon_hotreload_unmapped");
      }
      return;
    }

    // Rate-limit check — drops the reload AFTER triggered emission so
    // the operator sees the attempt + the limit hit, not silence.
    if (!checkRateLimit(relPath, entry)) {
      try {
        emitEvent(db, {
          kind: "daemon_hotreload_rate_limited",
          substrate_origin: "substrate_auto",
          payload: {
            module: entry.name,
            file_path: relPath,
            rate_limit: entry.rate_limit,
            hint: "the same file exceeded its rate_limit.count reloads in rate_limit.window_ms; the watcher backed off to protect the daemon from save-loop storms",
          },
        });
        state.rate_limited_total++;
        recordOutcome({
          ts: new Date().toISOString(),
          module: entry.name,
          file_path: relPath,
          outcome: "rate_limited",
        });
      } catch (err) {
        logger.debug({ where: "hotreload.emit_rate_limited", err: String(err) }, "could not emit daemon_hotreload_rate_limited");
      }
      return;
    }

    try {
      emitEvent(db, {
        kind: "daemon_hotreload_triggered",
        substrate_origin: "substrate_auto",
        payload: {
          module: entry.name,
          file_path: relPath,
          strategy: entry.strategy,
          reason: entry.reason,
          reloadable_slot: entry.reloadable_slot ?? null,
        },
      });
    } catch (err) {
      logger.debug({ where: "hotreload.emit_triggered", err: String(err) }, "could not emit daemon_hotreload_triggered");
    }

    if (entry.strategy === "full_restart") {
      // Truth-in-audit (2026-05-17 follow-up): full_restart strategy is
      // a NORMAL state, not a failure. Pre-fix every edit to a
      // full_restart-classed module emitted daemon_hotreload_failed,
      // which counted toward the health_metric failure budget — 86% of
      // "failures" in a 24h window were benign restart-pending signals.
      // Use the dedicated daemon_hotreload_restart_pending kind so the
      // failure counter reflects actual faults.
      try {
        emitEvent(db, {
          kind: "daemon_hotreload_restart_pending",
          substrate_origin: "substrate_auto",
          payload: {
            module: entry.name,
            file_path: relPath,
            strategy: entry.strategy,
            reason: "full_restart_required",
            hint: "module requires fresh process (MCP server / DB / daemon entrypoint); run `acc daemon restart` when convenient",
          },
        });
        recordOutcome({
          ts: new Date().toISOString(),
          module: entry.name,
          file_path: relPath,
          outcome: "full_restart_required",
        });
      } catch (err) {
        logger.debug({ where: "hotreload.emit_restart_pending", err: String(err) }, "could not emit daemon_hotreload_restart_pending");
      }
      return;
    }

    if (entry.strategy === "quiescent_only" && !isQuiescent()) {
      pendingQuiescent.set(relPath, entry);
      state.pending_quiescent_count = pendingQuiescent.size;
      recordOutcome({
        ts: new Date().toISOString(),
        module: entry.name,
        file_path: relPath,
        outcome: "deferred_quiescent",
      });
      return;
    }

    applyReload(relPath, entry);
  };

  const applyReload = (relPath: string, entry: HotReloadEntry): void => {
    const absPath = join(projectRoot, relPath);
    // Bun ESM ignores `?hotreload=N` query strings — prepare a unique
    // sibling temp copy so import returns a fresh module instance. See
    // prepareHotReloadCacheBust for the structural rationale.
    let cacheBust: { url: string; tempPath: string; cleanup: () => void };
    try {
      cacheBust = prepareHotReloadCacheBust(absPath);
    } catch (err) {
      const reason = (err as Error).message ?? String(err);
      state.last_failure = { ts: new Date().toISOString(), module: entry.name, reason: `temp_copy_failed:${reason}` };
      state.failure_total++;
      recordOutcome({
        ts: state.last_failure.ts,
        module: entry.name,
        file_path: relPath,
        outcome: "failed",
        reason: `temp_copy_failed:${reason}`,
      });
      logger.warn(
        { where: "hotreload.apply.temp_copy", module: entry.name, file_path: relPath, err: reason },
        "hot-reload temp copy failed — previous reference retained",
      );
      return;
    }
    const url = cacheBust.url;
    void (async () => {
      try {
      // 1) Import the new module.
      let fresh: unknown;
      try {
        fresh = await import(url);
      } catch (err) {
        const reason = (err as Error).message ?? String(err);
        state.last_failure = { ts: new Date().toISOString(), module: entry.name, reason };
        state.failure_total++;
        recordOutcome({
          ts: state.last_failure.ts,
          module: entry.name,
          file_path: relPath,
          outcome: "failed",
          reason,
        });
        try {
          emitEvent(db, {
            kind: "daemon_hotreload_failed",
            substrate_origin: "substrate_auto",
            payload: { module: entry.name, file_path: relPath, strategy: entry.strategy, reason, cache_bust_url: url },
          });
        } catch (emitErr) {
          logger.debug({ where: "hotreload.emit_failed", err: String(emitErr) }, "could not emit daemon_hotreload_failed");
        }
        logger.warn(
          { where: "hotreload.apply.import", module: entry.name, file_path: relPath, err: reason },
          "hot-reload import failed — previous reference retained",
        );
        return;
      }

      // 2) Validate expected exports.
      const validationError = validateExpectedExports(fresh, entry.expected_exports);
      if (validationError) {
        state.last_rejected = { ts: new Date().toISOString(), module: entry.name, reason: validationError };
        state.rejected_total++;
        recordOutcome({
          ts: state.last_rejected.ts,
          module: entry.name,
          file_path: relPath,
          outcome: "rejected",
          reason: validationError,
        });
        try {
          emitEvent(db, {
            kind: "daemon_hotreload_rejected",
            substrate_origin: "substrate_auto",
            payload: {
              module: entry.name,
              file_path: relPath,
              strategy: entry.strategy,
              reason: validationError,
              expected_exports: entry.expected_exports,
              cache_bust_url: url,
              hint: "the new module imported successfully but is missing one or more declared exports; previous reference stays active",
            },
          });
        } catch (emitErr) {
          logger.debug({ where: "hotreload.emit_rejected", err: String(emitErr) }, "could not emit daemon_hotreload_rejected");
        }
        logger.warn(
          { where: "hotreload.validate", module: entry.name, file_path: relPath, err: validationError },
          "hot-reload validation refused the new module — previous reference retained",
        );
        return;
      }

      // 3) Reloadable registry swap (if entry declares one) — also runs
      //    the slot's smoke probe. Truth-in-audit: no slot → no_op event.
      let swappedVersion: number | null = null;
      let slotError: string | null = null;
      if (entry.reloadable_slot) {
        const slot = getReloadable(entry.reloadable_slot);
        if (!slot) {
          slotError = `reloadable_slot_not_registered:${entry.reloadable_slot}`;
        } else {
          const result = await slot.refresh(url);
          if (result.ok) {
            swappedVersion = result.version;
          } else {
            slotError = `${result.reason}:${result.error}`;
          }
        }
        if (slotError) {
          state.last_rejected = { ts: new Date().toISOString(), module: entry.name, reason: slotError };
          state.rejected_total++;
          recordOutcome({
            ts: state.last_rejected.ts,
            module: entry.name,
            file_path: relPath,
            outcome: "rejected",
            reason: slotError,
          });
          try {
            emitEvent(db, {
              kind: "daemon_hotreload_rejected",
              substrate_origin: "substrate_auto",
              payload: {
                module: entry.name,
                file_path: relPath,
                strategy: entry.strategy,
                reason: slotError,
                reloadable_slot: entry.reloadable_slot,
                cache_bust_url: url,
                hint: "the reloadable registry refused the new module (validation or smoke-probe failed inside the slot)",
              },
            });
          } catch (emitErr) {
            logger.debug({ where: "hotreload.emit_slot_rejected", err: String(emitErr) }, "could not emit daemon_hotreload_rejected (slot)");
          }
          return;
        }
      }

      // 4) Invalidate declared caches. (After swap so the next consumer
      //    miss reads through the freshly-swapped module.)
      const invalidatedCaches: string[] = [];
      if (entry.invalidates && entry.invalidates.length > 0) {
        for (const cacheName of entry.invalidates) {
          try {
            if (cacheName === "prompt_cache") {
              const { invalidatePromptCache } = await import("./prompt_cache");
              invalidatePromptCache();
              invalidatedCaches.push(cacheName);
            } else if (cacheName === "activation_bus_listeners") {
              // Reserved — listener cleanup would break in-flight worker
              // subscriptions. Implementing this needs a worker-reregister
              // hook, deferred.
            }
          } catch (err) {
            logger.warn(
              { where: "hotreload.invalidate_cache", cache: cacheName, err: (err as Error).message },
              "cache invalidation failed",
            );
          }
        }
      }

      // 5) Truth-in-audit emission: swapped (real behavior change) vs
      //    no_op (import succeeded but no consumer reads through a
      //    reloadable slot).
      const ts = new Date().toISOString();
      state.last_reload_ts = ts;
      state.last_reload_module = entry.name;
      state.last_reload_strategy = entry.strategy;
      state.reload_total++;
      pendingQuiescent.delete(relPath);
      state.pending_quiescent_count = pendingQuiescent.size;

      if (entry.reloadable_slot && swappedVersion !== null) {
        state.swapped_total++;
        recordOutcome({
          ts,
          module: entry.name,
          file_path: relPath,
          outcome: "swapped",
          reason: `version=${swappedVersion}`,
        });
        try {
          emitEvent(db, {
            kind: "daemon_hotreload_swapped",
            substrate_origin: "substrate_auto",
            payload: {
              module: entry.name,
              file_path: relPath,
              strategy: entry.strategy,
              cache_bust_url: url,
              reloadable_slot: entry.reloadable_slot,
              registry_version: swappedVersion,
              invalidated_caches: invalidatedCaches,
              expected_exports: entry.expected_exports ?? [],
            },
          });
        } catch (emitErr) {
          logger.debug({ where: "hotreload.emit_swapped", err: String(emitErr) }, "could not emit daemon_hotreload_swapped");
        }
      } else {
        state.no_op_total++;
        recordOutcome({
          ts,
          module: entry.name,
          file_path: relPath,
          outcome: "no_op",
          reason: "no reloadable_slot — import succeeded but no consumer reads through indirection",
        });
        try {
          emitEvent(db, {
            kind: "daemon_hotreload_no_op",
            substrate_origin: "substrate_auto",
            payload: {
              module: entry.name,
              file_path: relPath,
              strategy: entry.strategy,
              cache_bust_url: url,
              invalidated_caches: invalidatedCaches,
              reason: "no_reloadable_slot",
              hint: "import succeeded but live daemon behavior did not change because no consumer reads through getReloadable(...).current(); wire one and add reloadable_slot to the manifest entry",
            },
          });
        } catch (emitErr) {
          logger.debug({ where: "hotreload.emit_no_op", err: String(emitErr) }, "could not emit daemon_hotreload_no_op");
        }
      }

      // 6) Backwards-compatible legacy emission. Pre-improvement
      //    consumers (CLI status renderer, tests) read
      //    daemon_hotreload_completed as the "something happened"
      //    signal. Keep emitting it alongside the truthful events above
      //    so existing surfaces don't go silent during the migration.
      //    The new swapped/no_op pair carries the load-bearing signal;
      //    completed is now decorative.
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
            swapped: entry.reloadable_slot !== undefined && swappedVersion !== null,
          },
        });
      } catch (emitErr) {
        logger.debug({ where: "hotreload.emit_completed", err: String(emitErr) }, "could not emit daemon_hotreload_completed");
      }
      } finally {
        // Always unlink the sibling temp copy, even on early-return paths
        // (validation failure, slot rejection, smoke-probe failure).
        cacheBust.cleanup();
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
    rateLimitWindows.clear();
  };
};

/** Test surface: drive a single change through the worker without the
 *  fs.watch boot. Used by hotreload_worker.test.ts to exercise the
 *  validation / rate-limit / swap / no-op paths deterministically. */
export const __testApplyChange = (
  db: Database,
  projectRoot: string,
  relPath: string,
  isQuiescent: () => boolean = () => true,
): void => {
  if (isNoiseFile(relPath)) return;
  const entry = matchHotReloadEntry(relPath);
  // Mirror the worker's processChange path without the fs-watch setup.
  if (!entry) {
    try {
      emitEvent(db, {
        kind: "daemon_hotreload_unmapped",
        substrate_origin: "substrate_auto",
        payload: { file_path: relPath, watched_directories: [...WATCHED_DIRECTORIES] },
      });
      state.last_unmapped = { ts: new Date().toISOString(), file_path: relPath };
      state.unmapped_total++;
      recordOutcome({
        ts: state.last_unmapped.ts,
        module: "(unmapped)",
        file_path: relPath,
        outcome: "unmapped",
      });
    } catch { /* swallow */ }
    return;
  }
  // Test parity for the full_restart strategy: emit restart_pending (the
  // 2026-05-17 truth-in-audit fix) so tests can assert the kind without
  // booting the fs.watch loop.
  if (entry.strategy === "full_restart") {
    try {
      emitEvent(db, {
        kind: "daemon_hotreload_restart_pending",
        substrate_origin: "substrate_auto",
        payload: {
          module: entry.name,
          file_path: relPath,
          strategy: entry.strategy,
          reason: "full_restart_required",
        },
      });
      recordOutcome({
        ts: new Date().toISOString(),
        module: entry.name,
        file_path: relPath,
        outcome: "full_restart_required",
      });
    } catch { /* swallow */ }
    return;
  }
  // Inline a synchronous-friendly version of applyReload that doesn't
  // require the surrounding closure (test mode). Production callers go
  // through startHotreloadWorker.
  const absPath = join(projectRoot, relPath);
  let cacheBust: { url: string; tempPath: string; cleanup: () => void };
  try {
    cacheBust = prepareHotReloadCacheBust(absPath);
  } catch (err) {
    const reason = `temp_copy_failed:${(err as Error).message ?? String(err)}`;
    state.last_failure = { ts: new Date().toISOString(), module: entry.name, reason };
    state.failure_total++;
    emitEvent(db, {
      kind: "daemon_hotreload_failed",
      substrate_origin: "substrate_auto",
      payload: { module: entry.name, file_path: relPath, strategy: entry.strategy, reason },
    });
    return;
  }
  const url = cacheBust.url;
  void (async () => {
    try {
    let fresh: unknown;
    try {
      fresh = await import(url);
    } catch (err) {
      const reason = (err as Error).message ?? String(err);
      state.last_failure = { ts: new Date().toISOString(), module: entry.name, reason };
      state.failure_total++;
      emitEvent(db, {
        kind: "daemon_hotreload_failed",
        substrate_origin: "substrate_auto",
        payload: { module: entry.name, file_path: relPath, strategy: entry.strategy, reason },
      });
      return;
    }
    const validationError = validateExpectedExports(fresh, entry.expected_exports);
    if (validationError) {
      state.last_rejected = { ts: new Date().toISOString(), module: entry.name, reason: validationError };
      state.rejected_total++;
      emitEvent(db, {
        kind: "daemon_hotreload_rejected",
        substrate_origin: "substrate_auto",
        payload: { module: entry.name, file_path: relPath, reason: validationError },
      });
      return;
    }
    let swappedVersion: number | null = null;
    if (entry.reloadable_slot) {
      const slot = getReloadable(entry.reloadable_slot);
      if (slot) {
        const result = await slot.refresh(url);
        if (result.ok) swappedVersion = result.version;
      }
    }
    state.last_reload_ts = new Date().toISOString();
    state.last_reload_module = entry.name;
    state.last_reload_strategy = entry.strategy;
    state.reload_total++;
    if (entry.reloadable_slot && swappedVersion !== null) {
      state.swapped_total++;
      emitEvent(db, {
        kind: "daemon_hotreload_swapped",
        substrate_origin: "substrate_auto",
        payload: { module: entry.name, file_path: relPath, reloadable_slot: entry.reloadable_slot, registry_version: swappedVersion },
      });
    } else {
      state.no_op_total++;
      emitEvent(db, {
        kind: "daemon_hotreload_no_op",
        substrate_origin: "substrate_auto",
        payload: { module: entry.name, file_path: relPath, reason: "no_reloadable_slot" },
      });
    }
    void isQuiescent; // kept for parity with production startup
    } finally {
      cacheBust.cleanup();
    }
  })();
};

/** Helper for tests: render the manifest into the shape /health exposes. */
export const renderHotreloadHealth = (s: HotReloadState = state): HotReloadState => ({
  ...s,
  recent_outcomes: [...s.recent_outcomes],
});

/** Convenience for the importers — relative path utility kept here so
 *  tests that simulate the watcher don't need their own path helpers. */
export const toProjectRelative = (absPath: string, projectRoot: string): string => {
  const rel = relative(projectRoot, absPath);
  return rel.split(sep).join("/");
};
