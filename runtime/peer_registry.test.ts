import { afterAll, beforeEach, describe, expect, test } from "bun:test";
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
  afterAll(() => closeDb());
  beforeEach(() => closeDb());

  test("registers substrate-spawnable opencode and externally launched Claude peers", async () => {
    const db = openDb(":memory:");
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
