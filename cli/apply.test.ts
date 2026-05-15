// acc apply tests: prove the owner/auto gates are target/shape based, not
// special-cased by lesson kind.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb } from "../substrate/db";
import { startDaemon, stopDaemon, type DaemonHandle } from "../runtime/daemon";
import { mcpCall } from "./rpc";
import { runApply } from "./apply";

const MCP_BASE = 13000;
const AUX_BASE = 18000;
const pickMcp = () => MCP_BASE + Math.floor(Math.random() * 1000);
const pickAux = () => AUX_BASE + Math.floor(Math.random() * 1000);

let handle: DaemonHandle | null = null;
let dir = "";
let prevPort: string | undefined;
let prevAuxPort: string | undefined;

const captureConsole = (): { out: string[]; err: string[]; restore: () => void } => {
  const out: string[] = [];
  const err: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...a: unknown[]) => { out.push(a.map((x) => typeof x === "string" ? x : JSON.stringify(x)).join(" ")); };
  console.error = (...a: unknown[]) => { err.push(a.map((x) => typeof x === "string" ? x : JSON.stringify(x)).join(" ")); };
  return { out, err, restore: () => { console.log = origLog; console.error = origErr; } };
};

const rowPayload = (row: Record<string, unknown>): Record<string, unknown> => {
  if (typeof row.payload === "string") return JSON.parse(row.payload) as Record<string, unknown>;
  return (row.payload ?? {}) as Record<string, unknown>;
};

const emitLesson = async (proposedAction: Record<string, unknown>): Promise<string> => {
  const env = await mcpCall("substrate.emit", {
    kind: "lesson_extracted",
    substrate_origin: "opencode",
    directive_id: "d_apply_gate",
    task_id: "t_apply_gate",
    payload: {
      lesson_kind: "verifier_gap",
      summary: "apply a structured proposed action",
      proposed_action: proposedAction,
    },
  });
  expect(env.ok).toBe(true);
  return (env.result as { id: string }).id;
};

const emittedGateReason = async (eventId: string): Promise<string | undefined> => {
  const statusEnv = await mcpCall("substrate.read", { view_name: "lesson_implementation_status_view" });
  expect(statusEnv.ok).toBe(true);
  const status = (statusEnv.result as Array<Record<string, unknown>>).find((r) => r.source_event_id === eventId)!;
  const requestEnv = await mcpCall("substrate.get_event", { id: status.request_event_id });
  expect(requestEnv.ok).toBe(true);
  const requestPayload = rowPayload(requestEnv.result as Record<string, unknown>);
  const gateEnv = await mcpCall("substrate.get_event", { id: requestPayload.gate_scored_event_id });
  expect(gateEnv.ok).toBe(true);
  return rowPayload(gateEnv.result as Record<string, unknown>).reason as string | undefined;
};

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "acc2-apply-"));
  const port = pickMcp();
  const auxPort = pickAux();
  handle = await startDaemon({
    port,
    auxPort,
    stateDbPath: join(dir, "apply.db"),
    socketFile: join(dir, "v2.sock"),
    tokenFile: join(dir, "v2.sock.token"),
  });
  prevPort = process.env.V2_DAEMON_PORT;
  prevAuxPort = process.env.V2_DAEMON_AUX_PORT;
  process.env.V2_DAEMON_PORT = String(port);
  process.env.V2_DAEMON_AUX_PORT = String(auxPort);
});

afterEach(async () => {
  if (handle) await stopDaemon(handle);
  handle = null;
  closeDb();
  rmSync(dir, { recursive: true, force: true });
  if (prevPort === undefined) delete process.env.V2_DAEMON_PORT;
  else process.env.V2_DAEMON_PORT = prevPort;
  if (prevAuxPort === undefined) delete process.env.V2_DAEMON_AUX_PORT;
  else process.env.V2_DAEMON_AUX_PORT = prevAuxPort;
});

describe("runApply gates", () => {
  test("lesson_extracted proposed_action to protected target requires owner consent", async () => {
    const eventId = await emitLesson({ file_path: "CLAUDE.md", anchor: "owner gate", diff: "@@" });
    const cap = captureConsole();
    const code = await runApply([eventId]);
    cap.restore();

    expect(code).toBe(1);
    expect(cap.err.join("\n")).toContain("owner_consent_missing");

    const statusEnv = await mcpCall("substrate.read", { view_name: "lesson_implementation_status_view" });
    expect(statusEnv.ok).toBe(true);
    const status = (statusEnv.result as Array<Record<string, unknown>>).find((r) => r.source_event_id === eventId)!;
    const requestEnv = await mcpCall("substrate.get_event", { id: status.request_event_id });
    expect(requestEnv.ok).toBe(true);
    const requestPayload = rowPayload(requestEnv.result as Record<string, unknown>);
    const gateEnv = await mcpCall("substrate.get_event", { id: requestPayload.gate_scored_event_id });
    expect(gateEnv.ok).toBe(true);
    const gateScore = gateEnv.result as Record<string, unknown>;
    expect(Number(gateScore.residual)).toBe(1);
    expect(rowPayload(gateScore).authorization_status).toBe("denied");
  });

  test("prior owner_decision_recorded satisfies protected target gate", async () => {
    const eventId = await emitLesson({ file_path: "CLAUDE.md", anchor: "owner gate", diff: "@@" });
    const decision = await mcpCall("substrate.emit", {
      kind: "owner_decision_recorded",
      substrate_origin: "owner",
      directive_id: "d_apply_gate",
      task_id: "t_apply_gate",
      payload: { source_event_id: eventId, decision: "approved" },
      context_refs: [eventId],
    });
    expect(decision.ok).toBe(true);

    const cap = captureConsole();
    const code = await runApply([eventId]);
    cap.restore();

    expect(code).toBe(0);
    expect(cap.out.join("\n")).toContain("OWNER GATE — APPROVED");
    expect(cap.out.join("\n")).not.toContain("OWNER GATE — REFUSE");
  });

  test("lesson_extracted proposed_action to runtime target uses auto-apply gate", async () => {
    const eventId = await emitLesson({ file_path: "runtime/verifier.ts", anchor: "gate", diff: "@@" });
    const cap = captureConsole();
    const code = await runApply([eventId]);
    cap.restore();

    expect(code).toBe(0);
    expect(cap.out.join("\n")).toContain("AUTO-APPLY GATE");
    expect(cap.out.join("\n")).toContain("proposed_action");

    const statusEnv = await mcpCall("substrate.read", { view_name: "lesson_implementation_status_view" });
    expect(statusEnv.ok).toBe(true);
    const status = (statusEnv.result as Array<Record<string, unknown>>).find((r) => r.source_event_id === eventId)!;
    const requestEnv = await mcpCall("substrate.get_event", { id: status.request_event_id });
    expect(requestEnv.ok).toBe(true);
    const requestPayload = rowPayload(requestEnv.result as Record<string, unknown>);
    const gateEnv = await mcpCall("substrate.get_event", { id: requestPayload.gate_scored_event_id });
    expect(gateEnv.ok).toBe(true);
    const gateScore = gateEnv.result as Record<string, unknown>;
    expect(Number(gateScore.residual)).toBe(0);
    expect(rowPayload(gateScore).authorization_status).toBe("approved");
  });

  test("lesson_extracted proposed_action to repo target_resource accepts object-form anchored_replace_v1", async () => {
    const eventId = await emitLesson({
      target_resource: "repo:runtime/verifier.ts",
      anchor: "gate",
      diff: { kind: "anchored_replace_v1", before: "OLD", after: "NEW" },
    });
    const cap = captureConsole();
    const code = await runApply([eventId]);
    cap.restore();

    const prompt = cap.out.join("\n");
    expect(code).toBe(0);
    expect(prompt).toContain("AUTO-APPLY GATE");
    expect(prompt).toContain("target_resource: repo:runtime/verifier.ts");
    expect(prompt).toContain("anchored_replace_v1");
  });

  test("lesson_extracted proposed_action to cli target uses auto-apply gate", async () => {
    const eventId = await emitLesson({ file_path: "cli/apply.ts", anchor: "gate", diff: "@@" });
    const cap = captureConsole();
    const code = await runApply([eventId]);
    cap.restore();

    expect(code).toBe(0);
    expect(cap.out.join("\n")).toContain("AUTO-APPLY GATE");
    expect(cap.out.join("\n")).toContain("cli/apply.ts");

    const statusEnv = await mcpCall("substrate.read", { view_name: "lesson_implementation_status_view" });
    expect(statusEnv.ok).toBe(true);
    const status = (statusEnv.result as Array<Record<string, unknown>>).find((r) => r.source_event_id === eventId)!;
    const requestEnv = await mcpCall("substrate.get_event", { id: status.request_event_id });
    expect(requestEnv.ok).toBe(true);
    const requestPayload = rowPayload(requestEnv.result as Record<string, unknown>);
    const gateEnv = await mcpCall("substrate.get_event", { id: requestPayload.gate_scored_event_id });
    expect(gateEnv.ok).toBe(true);
    const gateScore = gateEnv.result as Record<string, unknown>;
    expect(Number(gateScore.residual)).toBe(0);
    expect(rowPayload(gateScore).authorization_status).toBe("approved");
  });

  test("contract_amendment_proposed prompt renders structured proposed_behavior and explicit gates", async () => {
    const env = await mcpCall("substrate.emit", {
      kind: "contract_amendment_proposed",
      substrate_origin: "opencode",
      directive_id: "d_apply_gate",
      task_id: "t_apply_gate",
      payload: {
        target: "runtime/prompt_composer.ts",
        anchor: "WORKFLOW_TEXT",
        current_behavior: "acc apply prompts omit structured gate facts",
        proposed_behavior: {
          file_path: "runtime/prompt_composer.ts",
          anchor: "WORKFLOW_TEXT",
          diff: "@@\n+render structured gates",
        },
      },
    });
    expect(env.ok).toBe(true);
    const eventId = (env.result as { id: string }).id;

    const cap = captureConsole();
    const code = await runApply([eventId]);
    cap.restore();

    const prompt = cap.out.join("\n");
    expect(code).toBe(0);
    expect(prompt).toContain("STRUCTURED PROPOSED CHANGE");
    expect(prompt).toContain("source_field: proposed_behavior");
    expect(prompt).toContain("target_resource: repo:runtime/prompt_composer.ts");
    expect(prompt).toContain("anchor:          WORKFLOW_TEXT");
    expect(prompt).toContain("```diff");
    expect(prompt).toContain("APPLY GATES");
    expect(prompt).toContain("owner_gate.required: false");
    expect(prompt).toContain("cli_runtime_gate.target_in_scope: true");
    expect(prompt).toContain("cli_runtime_gate.structured_change: true");
    expect(prompt).toContain("cli_runtime_gate.trajectory_hazard_count: 0");
  });

  test("auto-apply target blocks unstructured proposals", async () => {
    const env = await mcpCall("substrate.emit", {
      kind: "contract_amendment_proposed",
      substrate_origin: "opencode",
      directive_id: "d_apply_gate",
      task_id: "t_apply_gate",
      payload: {
        target: "runtime/prompt_composer.ts",
        anchor: "gate",
        proposed_behavior: "tighten the gate prose",
      },
    });
    expect(env.ok).toBe(true);
    const eventId = (env.result as { id: string }).id;

    const cap = captureConsole();
    const code = await runApply([eventId]);
    cap.restore();

    expect(code).toBe(1);
    expect(cap.err.join("\n")).toContain("structured_proposed_behavior_required");
    expect(await emittedGateReason(eventId)).toBe("structured_proposed_behavior_required");
  });

  test("auto-apply target blocks hazardous trajectories", async () => {
    const eventId = await emitLesson({ file_path: "runtime/verifier.ts", anchor: "gate", diff: "@@" });
    const hazard = await mcpCall("substrate.emit", {
      kind: "dispatcher_violation",
      substrate_origin: "substrate",
      directive_id: "d_apply_gate",
      task_id: "t_apply_gate",
      payload: { failure_kind: "cycle_1_only_breach" },
    });
    expect(hazard.ok).toBe(true);

    const cap = captureConsole();
    const code = await runApply([eventId]);
    cap.restore();

    expect(code).toBe(1);
    expect(cap.err.join("\n")).toContain("trajectory_hazard_present");
    expect(await emittedGateReason(eventId)).toBe("trajectory_hazard_present");
  });

  test("protected structured file_path requires consent even when top-level target is safe", async () => {
    const env = await mcpCall("substrate.emit", {
      kind: "contract_amendment_proposed",
      substrate_origin: "opencode",
      directive_id: "d_apply_gate",
      task_id: "t_apply_gate",
      payload: {
        target: "runtime/prompt_composer.ts",
        anchor: "gate",
        proposed_behavior: { file_path: "CLAUDE.md", anchor: "owner gate", diff: "@@" },
      },
    });
    expect(env.ok).toBe(true);
    const eventId = (env.result as { id: string }).id;

    const cap = captureConsole();
    const code = await runApply([eventId]);
    cap.restore();

    expect(code).toBe(1);
    expect(cap.err.join("\n")).toContain("owner_consent_missing");
  });

  test("owner-approved mixed protected target does not fall through to auto-apply shape gate", async () => {
    const env = await mcpCall("substrate.emit", {
      kind: "contract_amendment_proposed",
      substrate_origin: "opencode",
      directive_id: "d_apply_gate",
      task_id: "t_apply_gate",
      payload: {
        target: "runtime/prompt_composer.ts",
        anchor: "gate",
        proposed_behavior: { file_path: "CLAUDE.md", anchor: "owner gate", diff: "@@" },
      },
    });
    expect(env.ok).toBe(true);
    const eventId = (env.result as { id: string }).id;

    const decision = await mcpCall("substrate.emit", {
      kind: "owner_decision_recorded",
      substrate_origin: "owner",
      directive_id: "d_apply_gate",
      task_id: "t_apply_gate",
      payload: { source_event_id: eventId, decision: "approved" },
      context_refs: [eventId],
    });
    expect(decision.ok).toBe(true);

    const cap = captureConsole();
    const code = await runApply([eventId]);
    cap.restore();

    expect(code).toBe(0);
    expect(cap.out.join("\n")).toContain("OWNER GATE — APPROVED");
    expect(cap.out.join("\n")).not.toContain("AUTO-APPLY GATE");
  });

  test("high-residual applied executor attempts remain uncommitted and queued", async () => {
    const eventId = await emitLesson({ file_path: "runtime/verifier.ts", anchor: "gate", diff: "@@" });
    const cap = captureConsole();
    const code = await runApply([
      "--record",
      eventId,
      "--status",
      "applied",
      "--residual",
      "0.7",
      "--commit-sha",
      "abcdef1234",
    ]);
    cap.restore();

    expect(code).toBe(1);
    expect(cap.out.join("\n")).toContain("applied_change_committed skipped residual=0.7 status=applied");
    expect(cap.out.join("\n")).toContain("lesson_applied");

    const statusEnv = await mcpCall("substrate.read", { view_name: "lesson_implementation_status_view" });
    expect(statusEnv.ok).toBe(true);
    const status = (statusEnv.result as Array<Record<string, unknown>>).find((r) => r.source_event_id === eventId)!;
    expect(status.scored_event_id).toBeTruthy();
    expect(status.verifier_passed).toBe(false);
    expect(status.committed_event_id).toBeNull();
    expect(status.flywheel_status).toBe("applied");

    const queueEnv = await mcpCall("substrate.read", { view_name: "lesson_implementer_queue_view" });
    expect(queueEnv.ok).toBe(true);
    const queued = (queueEnv.result as Array<Record<string, unknown>>).find((r) => r.source_event_id === eventId)!;
    expect(queued.apply_event_id).toBeTruthy();
    expect(queued.apply_status).toBe("applied");
  });
});
