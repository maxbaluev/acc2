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

  test("unmapped: file under a watched directory but not in manifest emits daemon_hotreload_unmapped", async () => {
    const db = openDb(":memory:");
    const root = mkdtempSync(join(tmpdir(), "acc2-hotreload-test-"));
    try {
      __testApplyChange(db, root, "runtime/random_unmapped_file.ts");
      // Wait for the async import path inside __testApplyChange to run.
      await Bun.sleep(20);
      const rows = db
        .query("SELECT kind, payload FROM events WHERE kind = 'daemon_hotreload_unmapped' ORDER BY ts DESC LIMIT 1")
        .all() as Array<{ kind: string; payload: string }>;
      expect(rows.length).toBe(1);
      const payload = JSON.parse(rows[0]!.payload) as { file_path: string };
      expect(payload.file_path).toBe("runtime/random_unmapped_file.ts");
      const state = getHotreloadState();
      expect(state.unmapped_total).toBe(1);
      expect(state.recent_outcomes[state.recent_outcomes.length - 1]?.outcome).toBe("unmapped");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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
