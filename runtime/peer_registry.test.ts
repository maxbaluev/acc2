import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, openDb } from "../substrate/db";
import { runViews } from "../substrate/views";
import { registerPeer, peerActivity } from "./peer_registry";
import { handleRead } from "./mcp_server/substrate_tools";
import type { McpContext } from "./mcp_server/types";

const ctx = (db: ReturnType<typeof openDb>): McpContext =>
  ({ db, invoker: "claude_root" } as McpContext);

type ViewResult = { rows: Array<Record<string, unknown>>; view_name: string; args: unknown; generated_at: string };

const unwrap = async (result: ReturnType<typeof handleRead>): Promise<ViewResult> => {
  const resolved = await result;
  expect(resolved.ok).toBe(true);
  if (!resolved.ok) throw new Error("handleRead failed");
  return resolved.result as unknown as ViewResult;
};

describe("peer registry", () => {
  // Use a UNIQUE on-disk db path per test rather than the shared `:memory:`
  // cache slot. Under `bun test --parallel` the db-cache singleton keys
  // `openDb(":memory:")` by the literal string, so two parallel files share
  // ONE in-memory Database — and no-arg `closeDb()` nukes EVERY cached
  // connection, including a sibling's live handle. A unique path + scoped
  // `closeDb(path)` isolates this test completely (the observed 1/N parallel
  // flake on this test).
  let tmpDir = "";
  let dbPath = "";

  // Busy-wait until the wall clock advances strictly past `afterMs`. emitEvent
  // stamps `ts` at millisecond resolution (nowIso) and newId() is RANDOM (not
  // time-sortable — see runtime/ids.ts). peer_registry_view's activity CTE
  // picks the latest heartbeat by `ORDER BY ts DESC, id DESC`; when the
  // registration and the later peerActivity land in the SAME millisecond, the
  // tiebreak resolves on random id ordering and ~1-in-4 the registration row
  // (directive-a) beats the activity row (directive-b). Forcing the activity
  // emit into a strictly-later millisecond makes `ts DESC` decisive so the
  // id-tiebreak never bites — deterministic, no production change. The flake
  // only surfaced in the full serial suite because earlier tests warm the JIT
  // and tighten the two emits into one millisecond.
  const waitForNextMillisecond = (afterMs: number): void => {
    while (Date.now() <= afterMs) { /* spin until clock advances */ }
  };

  afterEach(() => {
    if (dbPath) closeDb(dbPath);
    if (tmpDir) { try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ok */ } }
    tmpDir = "";
    dbPath = "";
  });

  test("registers substrate-spawnable opencode and externally launched Claude peers", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "acc2-peer-registry-"));
    dbPath = join(tmpDir, "peer.db");
    const db = openDb(dbPath);
    runViews(db);

    registerPeer(db, {
      peer_id: "peer-opencode-1",
      kind: "opencode",
      spawnability: "substrate_spawnable",
      directive_id: "directive-a",
      task_id: "task-a",
      scope: { lane: "brain", workspace: "isolated" },
      git_head: "abc123",
    });
    registerPeer(db, {
      peer_id: "peer-claude-terminal-1",
      kind: "claude_terminal",
      spawnability: "externally_launched",
      scope: { lane: "orchestrator" },
      git_head: "abc123",
    });
    // Guarantee the heartbeat below lands in a strictly-later millisecond than
    // the registration above so peer_registry_view's `ORDER BY ts DESC` picks
    // it deterministically (defeats the random-id tiebreak — see comment on
    // waitForNextMillisecond).
    waitForNextMillisecond(Date.now());
    peerActivity(db, {
      peer_id: "peer-opencode-1",
      directive_id: "directive-b",
      task_id: "task-b",
      current_act_id: "act-b",
      scope: { lane: "brain", workspace: "isolated" },
      git_head: "def456",
    });

    const result = await unwrap(handleRead(ctx(db), { view_name: "peer_registry_view", args: {} }));
    expect(result.view_name).toBe("peer_registry_view");

    const byPeer = new Map(result.rows.map((row) => [row.peer_id as string, row]));
    const opencode = byPeer.get("peer-opencode-1");
    const claude = byPeer.get("peer-claude-terminal-1");

    expect(opencode).toBeDefined();
    expect(opencode!.kind).toBe("opencode");
    expect(opencode!.spawnability).toBe("substrate_spawnable");
    expect(opencode!.directive_id).toBe("directive-b");
    expect(opencode!.task_id).toBe("task-b");
    expect(opencode!.current_act_id).toBe("act-b");
    expect(opencode!.git_head).toBe("def456");
    expect(opencode!.liveness_verdict).toBe("live");

    expect(claude).toBeDefined();
    expect(claude!.kind).toBe("claude_terminal");
    expect(claude!.spawnability).toBe("externally_launched");
    expect(claude!.liveness_verdict).toBe("live");
  });
});
