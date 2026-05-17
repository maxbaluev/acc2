// acc2 daemon hot-reload manifest (brain audit bqlr29psq, 2026-05-15).
//
// Single source of truth for which source modules can be hot-reloaded
// and under which strategy. The fs-watcher worker (runtime/hotreload_worker.ts)
// reads this manifest, matches changed files against the entries, and
// applies the declared strategy. Daemon `/health` reports the entries'
// names so operators can see what's actually watched.
//
//   in_process      — re-import the module with a cache-busting query
//                     string and atomically swap the validated exports.
//                     Safe for pure worker modules + extractors + views
//                     whose state lives entirely in the substrate.
//   quiescent_only  — wait until no brain dispatch is in-flight, then
//                     re-import. Used for modules whose process-local
//                     state would fork on naive re-import (e.g.
//                     runtime/task_scheduler.ts holds IN_FLIGHT maps).
//   full_restart    — emit daemon_hotreload_failed with a hint to
//                     `acc daemon restart`. Used for surfaces that
//                     require a fresh MCP server / DB connection
//                     (e.g. runtime/mcp_server/*, substrate/db.ts,
//                     substrate/schema.sql). The watcher does NOT
//                     auto-restart the daemon — operators decide when.

export type ReloadStrategy = "in_process" | "quiescent_only" | "full_restart";

export type HotReloadEntry = {
  name: string;
  globs: string[];
  excludes?: string[];
  strategy: ReloadStrategy;
  reason: string;
  /** Brain convergence axis E (2026-05-15): process-local caches the
   *  worker must invalidate after a successful in-process reload.
   *  Without this list, a hot-reloaded prompt_composer or extractor
   *  would still hand stale memoised values to subsequent dispatches.
   *  Keys are well-known cache names; the worker maps them to
   *  invalidate-callbacks at reload time. */
  invalidates?: ReadonlyArray<"prompt_cache" | "activation_bus_listeners">;
  /** Hot-reload deep-improvement (2026-05-17): identifiers the reloaded
   *  module MUST export for the worker to accept the swap. If any is
   *  missing or not a function/object, the worker emits
   *  daemon_hotreload_rejected and the previous reference stays active.
   *  Pre-fix the worker accepted anything that imported without
   *  throwing — even a file with a removed export silently broke
   *  callers. */
  expected_exports?: ReadonlyArray<string>;
  /** Hot-reload deep-improvement (2026-05-17): rate-limit reloads of the
   *  same file. When `count` reloads land within `window_ms`, the
   *  worker drops further reloads and emits daemon_hotreload_rate_limited
   *  until the window slides. Protects against save-loop storms (CI
   *  watcher rewriting after every save). */
  rate_limit?: { count: number; window_ms: number };
  /** Hot-reload deep-improvement (2026-05-17): name of the registered
   *  reloadable in runtime/reloadable.ts. When set, the worker calls
   *  `getReloadable(reloadable_slot)?.refresh(cache_bust_url)` to swap
   *  the cached module reference, and emits daemon_hotreload_swapped.
   *  When unset (legacy modules not yet wired through the registry),
   *  the worker emits daemon_hotreload_no_op — the import succeeded
   *  but no consumer is reading through an indirection, so the live
   *  daemon's behavior did not change. */
  reloadable_slot?: string;
};

/** Globs are minimatch-style: `**` matches any path segment. Excludes
 *  win over globs. CLI files are listed even though `acc <cmd>` runs as
 *  fresh subprocesses (no in-process reload needed) — the manifest
 *  surfaces them so the operator UX can show watched_module_count
 *  accurately. */
export const HOTRELOAD_MANIFEST: readonly HotReloadEntry[] = [
  {
    name: "runtime_extractors",
    globs: ["substrate/extractors.ts"],
    strategy: "in_process",
    reason: "Pure functions; daemon re-imports for the next tick.",
    expected_exports: ["extractKnowledgePromotions"],
    rate_limit: { count: 5, window_ms: 30_000 },
  },
  {
    name: "substrate_views",
    globs: ["substrate/views.ts"],
    strategy: "in_process",
    reason: "View SQL is read at substrate.read time; re-import refreshes the accessor closure.",
    expected_exports: ["runViews", "VIEW_NAMES"],
    rate_limit: { count: 5, window_ms: 30_000 },
  },
  {
    name: "substrate_event_kinds",
    globs: ["substrate/event_kinds.ts"],
    strategy: "in_process",
    reason: "Registry is consulted at emit time; re-import picks up new kinds without restart.",
    expected_exports: ["EVENT_KINDS", "EMBEDDABLE_KINDS", "HEALTH_METRIC_KINDS"],
    rate_limit: { count: 5, window_ms: 30_000 },
  },
  {
    name: "runtime_supervisor",
    globs: ["runtime/supervisor.ts", "runtime/bridge_health.ts"],
    strategy: "in_process",
    reason: "supervisedTick body is reloaded into the next tick without losing the in-memory readiness map.",
  },
  {
    name: "runtime_directive_closure",
    globs: ["runtime/directive_closure.ts"],
    strategy: "in_process",
    reason: "Cascade helpers are pure; re-import is safe.",
  },
  {
    name: "runtime_compaction",
    globs: ["runtime/compaction.ts"],
    strategy: "in_process",
    reason: "Bounded SQL workload; re-import safe.",
  },
  {
    name: "runtime_elegance_primitives",
    globs: [
      "runtime/pathology_budget.ts",
      "runtime/activation_bus.ts",
      "runtime/brain_effectiveness.ts",
      "runtime/credit.ts",
    ],
    strategy: "in_process",
    reason: "Pure helpers (budget aggregation, pub/sub, classifier, Shapley credit). Re-import refreshes the math without daemon restart.",
  },
  {
    name: "runtime_prompt_cache",
    globs: ["runtime/prompt_cache.ts"],
    strategy: "in_process",
    reason: "Cache lookup module; re-import recomputes lookup logic. Invalidate the cache itself so stale entries don't leak into the new code path.",
    invalidates: ["prompt_cache"],
  },
  {
    name: "runtime_prompt_composer",
    globs: ["runtime/prompt_composer.ts"],
    strategy: "in_process",
    reason: "Pure prompt composition; re-import refreshes the section selection logic. Wired through the reloadable registry — every dispatcher call goes via getReloadable('prompt_composer').current() so the swap reaches live brain dispatches without restart.",
    // Reloading the composer may change the output for identical inputs.
    // Drop the prompt_cache so the next dispatch composes fresh.
    invalidates: ["prompt_cache"],
    expected_exports: ["composePrompt", "estimateTokens"],
    rate_limit: { count: 5, window_ms: 30_000 },
    reloadable_slot: "prompt_composer",
  },
  {
    name: "runtime_scheduler",
    globs: ["runtime/task_scheduler.ts", "runtime/task_dispatcher.ts"],
    strategy: "quiescent_only",
    reason: "Module-local IN_FLIGHT maps would fork on naive re-import. Wait until no brain_dispatched is outstanding.",
  },
  {
    name: "runtime_bridge",
    globs: ["runtime/bridge.ts", "runtime/bridge/**/*.ts"],
    excludes: ["runtime/bridge/**/*.test.ts"],
    strategy: "full_restart",
    reason: "Bridge modules are eagerly imported by live dispatches and own subprocess cleanup state; edits require a fresh daemon after boot orphan recovery can re-pick interrupted tasks.",
  },
  {
    name: "runtime_mcp_server",
    globs: ["runtime/mcp_server.ts", "runtime/mcp_server/**/*.ts"],
    excludes: ["runtime/mcp_server/**/*.test.ts"],
    strategy: "full_restart",
    reason: "FastMCP tool list is bound at server construction; in-flight clients hold the old surface.",
  },
  {
    name: "substrate_db",
    globs: ["substrate/db.ts"],
    strategy: "full_restart",
    reason: "Connection + migration boundary; fresh connection required for safety.",
  },
  {
    name: "runtime_daemon_entry",
    globs: ["runtime/daemon.ts"],
    strategy: "full_restart",
    reason: "Top-level daemon entrypoint; binds MCP/aux ports + worker lifecycle.",
  },
  {
    name: "cli_surfaces",
    globs: ["cli/**/*.ts"],
    excludes: ["cli/**/*.test.ts"],
    strategy: "in_process",
    reason: "CLI invocations run as fresh subprocesses; manifest entry is for `acc daemon status` watched_module_count reporting only.",
  },
];

/** Match a file path against the manifest. Returns the FIRST matching
 *  entry whose globs include the path and whose excludes do not.
 *  Returns null when the file is not reload-eligible. */
export const matchHotReloadEntry = (filePath: string): HotReloadEntry | null => {
  for (const entry of HOTRELOAD_MANIFEST) {
    if (entry.excludes && entry.excludes.some((g) => globMatches(g, filePath))) continue;
    if (entry.globs.some((g) => globMatches(g, filePath))) return entry;
  }
  return null;
};

/** Minimal glob matcher: `**` matches zero or more path segments, `*`
 *  matches anything except '/'. Sufficient for the manifest patterns.
 *  Avoids pulling in minimatch as a runtime dep. */
export const globMatches = (pattern: string, candidate: string): boolean => {
  const escape = (s: string): string => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  let regex = "";
  let i = 0;
  while (i < pattern.length) {
    if (pattern.slice(i, i + 3) === "**/") {
      regex += "(?:.+/)?";
      i += 3;
    } else if (pattern.slice(i, i + 2) === "**") {
      regex += ".*";
      i += 2;
    } else if (pattern[i] === "*") {
      regex += "[^/]*";
      i += 1;
    } else if (pattern[i] === "?") {
      regex += "[^/]";
      i += 1;
    } else {
      regex += escape(pattern[i]!);
      i += 1;
    }
  }
  return new RegExp(`^${regex}$`).test(candidate);
};

/** Watched directories that the fs.watch worker scans for changes. The
 *  manifest globs are relative to the project root; this list is the
 *  smallest enclosing parent of every watched glob so the worker
 *  doesn't need to wire one watcher per file. */
export const WATCHED_DIRECTORIES = ["runtime", "substrate", "cli"] as const;
