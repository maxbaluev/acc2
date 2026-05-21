import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { closeDb, openDb } from "../substrate/db";
import { runViews } from "../substrate/views";
import { emitEvent } from "./events";
import { handleRead } from "./mcp_server/substrate_tools";
import type { McpContext } from "./mcp_server/types";
import { isLivePeerActingOnTarget, peerActivity, readPeerActivity, registerPeer } from "./peer_registry";

const ctx = (db: ReturnType<typeof openDb>): McpContext =>
  ({ db, invoker: "claude_root" } as McpContext);

type ViewResult = { rows: Array<Record<string, unknown>>; view_name: string; args: unknown; generated_at: string };

const unwrap = async (result: ReturnType<typeof handleRead>): Promise<ViewResult> => {
  const resolved = await result;
  expect(resolved.ok).toBe(true);
  if (!resolved.ok) throw new Error("handleRead failed");
  return resolved.result as unknown as ViewResult;
};

describe("peer activity awareness", () => {
  afterAll(() => closeDb());
  beforeEach(() => closeDb());

  test("peer B sees peer A in flight on the same target", async () => {
    const db = openDb(":memory:");
    runViews(db);

    registerPeer(db, {
      peer_id: "peer-a",
      kind: "opencode",
      spawnability: "substrate_spawnable",
      directive_id: "directive-a",
      task_id: "task-a",
      scope: { lane: "brain" },
    });
    registerPeer(db, {
      peer_id: "peer-b",
      kind: "claude_terminal",
      spawnability: "externally_launched",
      directive_id: "directive-b",
      task_id: "task-b",
      scope: { lane: "orchestrator" },
    });

    const predicted = emitEvent(db, {
      kind: "action_predicted",
      substrate_origin: "opencode",
      directive_id: "directive-a",
      task_id: "task-a",
      action_artifact_id: "artifact-a",
      verifier_artifact_id: "verifier-a",
      predicted_residual: 0.2,
      payload: {
        source_act_id: "source-act-a",
        target_resources: ["repo:runtime/target.ts"],
        summary: "peer A is editing target.ts",
      },
      invoker: "opencode",
    });

    peerActivity(db, {
      peer_id: "peer-a",
      kind: "opencode",
      directive_id: "directive-a",
      task_id: "task-a",
      current_act_id: predicted.id,
      scope: { lane: "brain" },
    });

    const rows = readPeerActivity(db, { current_peer_id: "peer-b" });
    const peerA = rows.find((row) => row.peer_id === "peer-a");

    expect(peerA).toBeDefined();
    expect(peerA!.in_flight_acts).toHaveLength(1);
    expect(peerA!.target_resources).toContain("repo:runtime/target.ts");
    expect(isLivePeerActingOnTarget(db, "repo:runtime/target.ts", { current_peer_id: "peer-b" })).toBe(true);
    expect(isLivePeerActingOnTarget(db, "repo:runtime/target.ts", { current_peer_id: "peer-a" })).toBe(false);

    const result = await unwrap(handleRead(ctx(db), {
      view_name: "peer_activity_view",
      args: { current_peer_id: "peer-b", target_resource: "repo:runtime/target.ts" },
    }));

    expect(result.view_name).toBe("peer_activity_view");
    expect(result.rows.map((row) => row.peer_id)).toContain("peer-a");
  });
});
