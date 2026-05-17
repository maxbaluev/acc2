import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { closeDb, openDb } from "../substrate/db";
import { emitActTupleDirect, emitActTupleViaMcp, buildActTuplePayload, type ActTupleInput } from "./act_tuple";
import { newId } from "./ids";

afterAll(() => closeDb());
beforeEach(() => closeDb());

const validAct = (): ActTupleInput => ({
  directiveId: newId(),
  taskId: newId(),
  substrateOrigin: "claude_root",
  intent: "record a coherent act boundary",
  reasoningSummary: "the helper is the shared Claude/opencode act ingress",
  actionSummary: "emit act_tuple_recorded once",
  effectSummary: "one source envelope is ready for projection",
  verifierKind: "deterministic_code",
  predictedResidual: 0.2,
  residual: 0,
  outcome: "succeeded",
  actionArtifactId: "act_helper_action",
  verifierArtifactId: "act_helper_verifier",
  citedKnowledgeIds: ["k_555"],
  citedArtifactIds: ["artifact_1"],
});

describe("runtime/act_tuple helper", () => {
  test("builds a complete canonical envelope payload", () => {
    const payload = buildActTuplePayload(validAct());
    expect(payload.verifier_kind).toBe("deterministic_code");
    expect(payload.action_artifact_id).toBe("act_helper_action");
    expect(payload.verifier_artifact_id).toBe("act_helper_verifier");
    expect(payload.cited_knowledge_ids).toEqual(["k_555"]);
    expect(payload.cited_artifact_ids).toEqual(["artifact_1"]);
  });

  test("validates required verifier and citation fields before transport", async () => {
    expect(() => buildActTuplePayload({ ...validAct(), verifierKind: "" })).toThrow("act_tuple_missing_verifier_kind");
    expect(() => buildActTuplePayload({ ...validAct(), citedKnowledgeIds: undefined as unknown as string[] })).toThrow("act_tuple_missing_cited_knowledge_ids");
    expect(() => buildActTuplePayload({ ...validAct(), citedArtifactIds: [""] })).toThrow("act_tuple_invalid_cited_artifact_ids");
    expect(() => buildActTuplePayload({ ...validAct(), residual: 2 })).toThrow("act_tuple_invalid_residual");

    let called = false;
    await expect(emitActTupleViaMcp(async () => {
      called = true;
      return { ok: true, result: { id: "unreachable" } };
    }, { ...validAct(), citedKnowledgeIds: undefined as unknown as string[] })).rejects.toThrow("act_tuple_missing_cited_knowledge_ids");
    expect(called).toBe(false);
  });

  test("supports DB emitEvent and MCP substrate.emit transports", async () => {
    const db = openDb(":memory:");
    const direct = emitActTupleDirect(db, validAct());
    expect(direct.id).toBeTruthy();
    const projected = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM events WHERE kind = 'action_predicted'").get()!.n;
    expect(projected).toBe(1);

    let capturedTool = "";
    let capturedArgs: Record<string, unknown> = {};
    const viaMcp = await emitActTupleViaMcp(async (tool, args) => {
      capturedTool = tool;
      capturedArgs = args;
      return { ok: true, result: { id: "mcp_evt", ts: "2026-05-17T00:00:00.000Z" } };
    }, validAct());
    expect(viaMcp.id).toBe("mcp_evt");
    expect(capturedTool).toBe("substrate.emit");
    expect(capturedArgs.kind).toBe("act_tuple_recorded");
    expect((capturedArgs.payload as Record<string, unknown>).verifier_kind).toBe("deterministic_code");
  });
});
