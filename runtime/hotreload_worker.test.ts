import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { matchHotReloadEntry } from "./hotreload_manifest";
import { collectHotreloadWatchDirs, toProjectRelative } from "./hotreload_worker";

describe("hotreload manifest", () => {
  test("runtime_bridge edits require full restart", () => {
    const entry = matchHotReloadEntry("runtime/bridge/opencode.ts");
    expect(entry?.name).toBe("runtime_bridge");
    expect(entry?.strategy).toBe("full_restart");
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
