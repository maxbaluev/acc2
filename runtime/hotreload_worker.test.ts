import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { matchHotReloadEntry } from "./hotreload_manifest";
import {
  __resetHotreloadStateForTests,
  __testApplyChange,
  collectHotreloadWatchDirs,
  getHotreloadState,
  isNoiseFile,
  toProjectRelative,
  validateExpectedExports,
} from "./hotreload_worker";
import { __resetReloadableRegistryForTests, registerReloadable } from "./reloadable";
import { closeDb, openDb } from "../substrate/db";

beforeEach(() => {
  __resetHotreloadStateForTests();
  __resetReloadableRegistryForTests();
  closeDb();
});

describe("hotreload manifest", () => {
  test("runtime_bridge edits require full restart", () => {
    const entry = matchHotReloadEntry("runtime/bridge/opencode.ts");
    expect(entry?.name).toBe("runtime_bridge");
    expect(entry?.strategy).toBe("full_restart");
  });

  test("runtime_prompt_composer declares expected_exports + reloadable_slot", () => {
    const entry = matchHotReloadEntry("runtime/prompt_composer.ts");
    expect(entry?.name).toBe("runtime_prompt_composer");
    expect(entry?.expected_exports).toContain("composePrompt");
    expect(entry?.expected_exports).toContain("estimateTokens");
    expect(entry?.reloadable_slot).toBe("prompt_composer");
    expect(entry?.rate_limit).toBeDefined();
  });
});

describe("hotreload watcher coverage", () => {
  test("collects nested directories for Linux-safe fs.watch", () => {
    const root = mkdtempSync(join(tmpdir(), "acc2-hotreload-watch-"));
    try {
      mkdirSync(join(root, "runtime/bridge"), { recursive: true });
      mkdirSync(join(root, "runtime/mcp_server/nested"), { recursive: true });
      mkdirSync(join(root, "substrate"), { recursive: true });
      mkdirSync(join(root, "cli"), { recursive: true });
      const rel = collectHotreloadWatchDirs(root).map((p) => toProjectRelative(p, root));
      expect(rel).toContain("runtime");
      expect(rel).toContain("runtime/bridge");
      expect(rel).toContain("runtime/mcp_server/nested");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("isNoiseFile (editor / build / OS noise filter)", () => {
  test("filters Bun.write atomic-rename backups", () => {
    expect(isNoiseFile("cli/tui/App.test.tsx.tmp.474444.1779020078043")).toBe(true);
    expect(isNoiseFile("runtime/foo.ts.tmp.123")).toBe(true);
    // Regression: Bun's atomic-rename suffix grew a HEX hash segment
    // (.tmp.PID.hexhash). The old digits-only regex missed it, so every edit
    // to a watched source file leaked a daemon_hotreload_unmapped noise event.
    expect(isNoiseFile("runtime/directive_closure.ts.tmp.3101307.09195e33ea65")).toBe(true);
    expect(isNoiseFile("runtime/events.ts.tmp.3101307.d21a98a7fe59")).toBe(true);
  });
  test("filters editor swap and backup files", () => {
    expect(isNoiseFile("runtime/foo.ts.swp")).toBe(true);
    expect(isNoiseFile("runtime/foo.ts~")).toBe(true);
    expect(isNoiseFile(".#bar.ts")).toBe(true);
    expect(isNoiseFile("#bar.ts#")).toBe(true);
    expect(isNoiseFile("runtime/foo.bak")).toBe(true);
  });
  test("filters .test.tsx / .spec.ts files (never reloadable)", () => {
    expect(isNoiseFile("cli/tui/App.test.tsx")).toBe(true);
    expect(isNoiseFile("runtime/foo.spec.ts")).toBe(true);
  });
  test("does NOT filter normal source files", () => {
    expect(isNoiseFile("runtime/prompt_composer.ts")).toBe(false);
    expect(isNoiseFile("substrate/extractors.ts")).toBe(false);
    expect(isNoiseFile("cli/observe.ts")).toBe(false);
  });
});

describe("validateExpectedExports", () => {
  test("returns null when every expected export is present", () => {
    const mod = { a: () => 1, b: "string", c: 7 };
    expect(validateExpectedExports(mod, ["a", "b", "c"])).toBeNull();
  });

  test("flags the first missing export", () => {
    const mod = { a: () => 1 };
    expect(validateExpectedExports(mod, ["a", "missing"])).toBe("missing export: missing");
  });

  test("no-op when no expected_exports declared", () => {
    expect(validateExpectedExports({}, undefined)).toBeNull();
    expect(validateExpectedExports({}, [])).toBeNull();
  });

  test("flags non-object module", () => {
    expect(validateExpectedExports(null, ["a"])).toBe("module is not an object");
    expect(validateExpectedExports(undefined, ["a"])).toBe("module is not an object");
  });
});

describe("truth-in-audit: hot reload emits the right event for each outcome", () => {
  // Each test below drives __testApplyChange to exercise the worker's
  // validation / swap / no-op / rejected / unmapped / rate-limited paths
  // without spinning up the fs.watch loop. We then introspect the
  // substrate events table to assert which kind landed.

  test("coverage-derivation fallback: a previously-unmapped runtime module degrades to a clear restart-required signal (NOT silent unmapped)", async () => {
    // GOAL-1 graceful degradation (2026-05-23): pre-fix, a runtime module
    // with no specific manifest entry emitted daemon_hotreload_unmapped — a
    // silent no-op that forced the operator to notice and extend the
    // manifest before a slow full restart would load the change. The
    // runtime_substrate_fallback catch-all now claims any unmapped
    // runtime/substrate .ts file with strategy=full_restart, so the operator
    // gets an honest daemon_hotreload_restart_pending hint instead.
    const db = openDb(":memory:");
    const root = mkdtempSync(join(tmpdir(), "acc2-hotreload-test-"));
    try {
      const entry = matchHotReloadEntry("runtime/random_unmapped_file.ts");
      expect(entry?.name).toBe("runtime_substrate_fallback");
      expect(entry?.strategy).toBe("full_restart");

      __testApplyChange(db, root, "runtime/random_unmapped_file.ts");
      await Bun.sleep(20);

      const unmapped = db
        .query("SELECT COUNT(*) AS c FROM events WHERE kind = 'daemon_hotreload_unmapped'")
        .get() as { c: number };
      expect(unmapped.c).toBe(0); // no silent unmapped — fallback claimed it

      const pending = db
        .query("SELECT payload FROM events WHERE kind = 'daemon_hotreload_restart_pending' ORDER BY ts DESC LIMIT 1")
        .all() as Array<{ payload: string }>;
      expect(pending.length).toBe(1);
      const payload = JSON.parse(pending[0]!.payload) as { file_path: string; module: string };
      expect(payload.file_path).toBe("runtime/random_unmapped_file.ts");
      expect(payload.module).toBe("runtime_substrate_fallback");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("coverage-gap fix: previously-unmapped high-churn modules (task_route, dispatch_decider, workers) are now mapped", () => {
    // GOAL-1 (2026-05-23): runtime/task_route.ts emitted daemon_hotreload_unmapped
    // live, forcing slow full restarts. These high-churn developer surfaces
    // are now explicitly mapped to an appropriate reload strategy.
    const route = matchHotReloadEntry("runtime/task_route.ts");
    expect(route?.name).toBe("runtime_routing");
    expect(route?.strategy).toBe("quiescent_only");

    const decider = matchHotReloadEntry("runtime/dispatch_decider.ts");
    expect(decider?.name).toBe("runtime_routing");

    const worker = matchHotReloadEntry("runtime/counterfactual_credit_worker.ts");
    expect(worker?.name).toBe("runtime_workers");
    expect(worker?.strategy).toBe("full_restart");

    // The fallback never shadows a specific entry (first-match wins).
    expect(matchHotReloadEntry("runtime/credit.ts")?.name).toBe("runtime_elegance_primitives");
    expect(matchHotReloadEntry("runtime/prompt_composer.ts")?.name).toBe("runtime_prompt_composer");
  });

  test("no_op: in_process import with no reloadable_slot emits daemon_hotreload_no_op (not completed)", async () => {
    // We exercise the runtime_extractors entry (in_process, no slot)
    // by pointing __testApplyChange at a tempdir containing a stub
    // matching the manifest glob. The stub exports extractKnowledgePromotions
    // so validation passes.
    const db = openDb(":memory:");
    const root = mkdtempSync(join(tmpdir(), "acc2-hotreload-test-"));
    try {
      mkdirSync(join(root, "substrate"), { recursive: true });
      const stub = `export const extractKnowledgePromotions = () => ({ promoted_event_ids: [], demoted_event_ids: [], contradicted_event_ids: [] });`;
      await Bun.write(join(root, "substrate/extractors.ts"), stub);
      __testApplyChange(db, root, "substrate/extractors.ts");
      await Bun.sleep(50);
      const noOp = db
        .query("SELECT COUNT(*) AS c FROM events WHERE kind = 'daemon_hotreload_no_op'")
        .get() as { c: number };
      expect(noOp.c).toBe(1);
      const swapped = db
        .query("SELECT COUNT(*) AS c FROM events WHERE kind = 'daemon_hotreload_swapped'")
        .get() as { c: number };
      expect(swapped.c).toBe(0);
      const state = getHotreloadState();
      expect(state.no_op_total).toBe(1);
      expect(state.swapped_total).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("swapped: in_process import with a registered reloadable slot emits daemon_hotreload_swapped + bumps registry version", async () => {
    const db = openDb(":memory:");
    const root = mkdtempSync(join(tmpdir(), "acc2-hotreload-test-"));
    try {
      // Pre-register the prompt_composer slot. Loader returns the stub.
      registerReloadable<{ composePrompt: () => unknown; estimateTokens: () => number }>({
        name: "prompt_composer",
        load: async (url) => {
          if (url) return (await import(url)) as { composePrompt: () => unknown; estimateTokens: () => number };
          return { composePrompt: () => ({}), estimateTokens: () => 1 };
        },
        validate: (mod) =>
          typeof mod.composePrompt === "function" && typeof mod.estimateTokens === "function"
            ? true
            : "missing exports",
      });
      mkdirSync(join(root, "runtime"), { recursive: true });
      const stub = `export const composePrompt = () => ({ text: 'stub', sections: [], truncated: [] });\nexport const estimateTokens = (s) => s.length;`;
      await Bun.write(join(root, "runtime/prompt_composer.ts"), stub);
      __testApplyChange(db, root, "runtime/prompt_composer.ts");
      await Bun.sleep(50);
      const swapped = db
        .query("SELECT payload FROM events WHERE kind = 'daemon_hotreload_swapped' ORDER BY ts DESC LIMIT 1")
        .all() as Array<{ payload: string }>;
      expect(swapped.length).toBe(1);
      const payload = JSON.parse(swapped[0]!.payload) as { reloadable_slot: string; registry_version: number };
      expect(payload.reloadable_slot).toBe("prompt_composer");
      expect(payload.registry_version).toBeGreaterThan(0);
      const noOp = db
        .query("SELECT COUNT(*) AS c FROM events WHERE kind = 'daemon_hotreload_no_op'")
        .get() as { c: number };
      expect(noOp.c).toBe(0);
      const state = getHotreloadState();
      expect(state.swapped_total).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("noise files (App.test.tsx, *.tmp.NNN, *.swp) skip processChange entirely (no unmapped emission)", async () => {
    const db = openDb(":memory:");
    const root = mkdtempSync(join(tmpdir(), "acc2-hotreload-test-"));
    try {
      __testApplyChange(db, root, "cli/tui/App.test.tsx");
      __testApplyChange(db, root, "runtime/prompt_composer.ts.tmp.474444.1779020078043");
      __testApplyChange(db, root, "runtime/foo.ts.swp");
      await Bun.sleep(20);
      const rows = db
        .query("SELECT COUNT(*) AS c FROM events WHERE kind = 'daemon_hotreload_unmapped'")
        .get() as { c: number };
      expect(rows.c).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("restart_pending: full_restart-classed edit emits daemon_hotreload_restart_pending (NOT daemon_hotreload_failed)", async () => {
    // Truth-in-audit follow-up 2026-05-17: full_restart strategy is a
    // NORMAL state, not a fault. Pre-fix every edit to runtime/bridge,
    // runtime/mcp_server, substrate/db etc emitted daemon_hotreload_failed
    // with reason=full_restart_required, polluting the health_metric
    // failure budget (126/146 = 86% of "failures" in a 24h window were
    // benign). Use the dedicated kind.
    const db = openDb(":memory:");
    const root = mkdtempSync(join(tmpdir(), "acc2-hotreload-test-"));
    try {
      // runtime/bridge/opencode.ts matches the runtime_bridge manifest
      // entry, which has strategy=full_restart.
      __testApplyChange(db, root, "runtime/bridge/opencode.ts");
      await Bun.sleep(20);
      const pending = db
        .query("SELECT COUNT(*) AS c FROM events WHERE kind = 'daemon_hotreload_restart_pending'")
        .get() as { c: number };
      expect(pending.c).toBe(1);
      const failed = db
        .query("SELECT COUNT(*) AS c FROM events WHERE kind = 'daemon_hotreload_failed'")
        .get() as { c: number };
      expect(failed.c).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejected: in_process import missing an expected export emits daemon_hotreload_rejected (NOT completed/swapped)", async () => {
    const db = openDb(":memory:");
    const root = mkdtempSync(join(tmpdir(), "acc2-hotreload-test-"));
    try {
      mkdirSync(join(root, "runtime"), { recursive: true });
      // Stub missing composePrompt — the manifest declares it required.
      const stub = `export const estimateTokens = (s) => s.length;`;
      await Bun.write(join(root, "runtime/prompt_composer.ts"), stub);
      __testApplyChange(db, root, "runtime/prompt_composer.ts");
      await Bun.sleep(50);
      const rejected = db
        .query("SELECT payload FROM events WHERE kind = 'daemon_hotreload_rejected' ORDER BY ts DESC LIMIT 1")
        .all() as Array<{ payload: string }>;
      expect(rejected.length).toBe(1);
      const payload = JSON.parse(rejected[0]!.payload) as { reason: string };
      expect(payload.reason).toContain("composePrompt");
      const swapped = db
        .query("SELECT COUNT(*) AS c FROM events WHERE kind = 'daemon_hotreload_swapped'")
        .get() as { c: number };
      expect(swapped.c).toBe(0);
      const state = getHotreloadState();
      expect(state.rejected_total).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
