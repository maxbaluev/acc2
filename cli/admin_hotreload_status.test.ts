// Tests for `acc admin hotreload-status` — reads daemon_hotreload_*
// events from the substrate and renders counts + recent outcomes. The
// CLI works whether the daemon is up or not because it queries the
// ledger directly.

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, openDb } from "../substrate/db";
import { emitEvent } from "../runtime/events";
import { runHotreloadStatus } from "./admin_hotreload_status";

afterAll(() => closeDb());

const stash = { db: "" as string, dir: "" as string };

beforeEach(() => {
  closeDb();
  stash.dir = mkdtempSync(join(tmpdir(), "acc2-hotreload-status-"));
  stash.db = join(stash.dir, "state.db");
  process.env.ACC2_DB_PATH = stash.db;
  // Touch openDb to materialize schema + views.
  const db = openDb(stash.db);
  void db;
});

const cleanupAfter = () => {
  closeDb();
  if (stash.dir) rmSync(stash.dir, { recursive: true, force: true });
  delete process.env.ACC2_DB_PATH;
};

const captureStdout = () => {
  const out: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: unknown) => {
    out.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  }) as typeof process.stdout.write;
  return { out, restore: () => { process.stdout.write = orig; } };
};

describe("acc admin hotreload-status", () => {
  test("empty substrate prints zero counts + (no rows)", async () => {
    const c = captureStdout();
    try {
      const code = await runHotreloadStatus([]);
      expect(code).toBe(0);
      const text = c.out.join("");
      expect(text).toContain("counts:");
      expect(text).toContain("swapped     (✓)  0");
      expect(text).toContain("no_op       (○)  0");
      expect(text).toContain("(no rows)");
    } finally {
      c.restore();
      cleanupAfter();
    }
  });

  test("populated substrate counts each kind and lists recent outcomes", async () => {
    const db = openDb(stash.db);
    emitEvent(db, {
      kind: "daemon_hotreload_swapped",
      substrate_origin: "substrate_auto",
      payload: { module: "prompt_composer", reloadable_slot: "prompt_composer", registry_version: 2 },
    });
    emitEvent(db, {
      kind: "daemon_hotreload_no_op",
      substrate_origin: "substrate_auto",
      payload: { module: "runtime_extractors", reason: "no_reloadable_slot" },
    });
    emitEvent(db, {
      kind: "daemon_hotreload_rejected",
      substrate_origin: "substrate_auto",
      payload: { module: "runtime_prompt_composer", reason: "missing export: composePrompt" },
    });
    emitEvent(db, {
      kind: "daemon_hotreload_unmapped",
      substrate_origin: "substrate_auto",
      payload: { file_path: "runtime/some_new_file.ts" },
    });
    emitEvent(db, {
      kind: "daemon_hotreload_rate_limited",
      substrate_origin: "substrate_auto",
      payload: { module: "runtime_extractors", rate_limit: { count: 5, window_ms: 30000 } },
    });
    const c = captureStdout();
    try {
      const code = await runHotreloadStatus([]);
      expect(code).toBe(0);
      const text = c.out.join("");
      expect(text).toContain("swapped     (✓)  1");
      expect(text).toContain("no_op       (○)  1");
      expect(text).toContain("rejected    (⊘)  1");
      expect(text).toContain("unmapped    (?)  1");
      expect(text).toContain("rate_limited     1");
      expect(text).toContain("prompt_composer");
      expect(text).toContain("v=2");
      expect(text).toContain("runtime/some_new_file.ts");
    } finally {
      c.restore();
      cleanupAfter();
    }
  });

  test("--json emits machine-readable counts + recent_outcomes + coverage_hint", async () => {
    const db = openDb(stash.db);
    // More no_ops than swaps → coverage_hint should fire.
    emitEvent(db, { kind: "daemon_hotreload_no_op", substrate_origin: "substrate_auto", payload: { module: "a" } });
    emitEvent(db, { kind: "daemon_hotreload_no_op", substrate_origin: "substrate_auto", payload: { module: "b" } });
    emitEvent(db, { kind: "daemon_hotreload_swapped", substrate_origin: "substrate_auto", payload: { module: "c", registry_version: 1 } });
    const c = captureStdout();
    try {
      const code = await runHotreloadStatus(["--json"]);
      expect(code).toBe(0);
      const parsed = JSON.parse(c.out.join("")) as {
        counts: Record<string, number>;
        recent_outcomes: Array<{ kind: string; module: string | null }>;
        coverage_hint: string | null;
      };
      expect(parsed.counts.daemon_hotreload_no_op).toBe(2);
      expect(parsed.counts.daemon_hotreload_swapped).toBe(1);
      expect(parsed.recent_outcomes.length).toBe(3);
      expect(parsed.coverage_hint).not.toBeNull();
      expect(parsed.coverage_hint).toContain("no_op > swapped");
    } finally {
      c.restore();
      cleanupAfter();
    }
  });

  test("--since filters out earlier events", async () => {
    const db = openDb(stash.db);
    // Emit one event with an old timestamp by patching the ts column directly.
    const old = emitEvent(db, { kind: "daemon_hotreload_no_op", substrate_origin: "substrate_auto", payload: {} });
    db.run("UPDATE events SET ts = '2020-01-01T00:00:00.000Z' WHERE id = ?", [old.id]);
    emitEvent(db, { kind: "daemon_hotreload_swapped", substrate_origin: "substrate_auto", payload: { registry_version: 1 } });
    const c = captureStdout();
    try {
      const code = await runHotreloadStatus(["--since", "2025-01-01T00:00:00Z", "--json"]);
      expect(code).toBe(0);
      const parsed = JSON.parse(c.out.join("")) as { counts: Record<string, number> };
      expect(parsed.counts.daemon_hotreload_no_op).toBe(0);
      expect(parsed.counts.daemon_hotreload_swapped).toBe(1);
    } finally {
      c.restore();
      cleanupAfter();
    }
  });

  test("--help prints usage and exits 0", async () => {
    const c = captureStdout();
    try {
      const code = await runHotreloadStatus(["--help"]);
      expect(code).toBe(0);
      expect(c.out.join("")).toContain("acc admin hotreload-status");
    } finally {
      c.restore();
      cleanupAfter();
    }
  });
});
