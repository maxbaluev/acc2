// acc apply tests: prove the owner/auto gates are target/shape based, not
// special-cased by lesson kind.

import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, openDb } from "../substrate/db";
import { lessonImplementationStatus, lessonImplementerQueue } from "../substrate/views";
import { handleCredit, handleEmit, handleGetEvent, handleRead } from "../runtime/mcp_server/substrate_tools";
import { handleRecentEvents } from "../runtime/mcp_server/runtime_tools";
import type { McpContext } from "../runtime/mcp_server/types";

let db: Database;
let dir = "";
let dbPath = "";
let directiveSeq = 0;
let runApply: (argv: string[]) => Promise<number>;

const ctx = (): McpContext => ({ db, invoker: "claude_root" } as McpContext);

const rpc = async (toolName: string, args: Record<string, unknown>) => {
  switch (toolName) {
    case "substrate.emit": return handleEmit(ctx(), args as never);
    case "substrate.read": return handleRead(ctx(), args as never);
    case "substrate.get_event": return handleGetEvent(ctx(), args as never);
    case "substrate.credit": return handleCredit(ctx(), args as never);
    case "runtime.recent_events": return handleRecentEvents(ctx(), args as never);
    default: return { ok: false as const, error: "unknown_test_rpc:" + toolName };
  }
};

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

const eventRow = (eventId: string): Record<string, unknown> => {
  const row = db.query("SELECT * FROM events WHERE id = ?").get(eventId) as Record<string, unknown> | null;
  expect(row).toBeTruthy();
  return row!;
};

const implementationStatus = (eventId: string) => {
  const status = lessonImplementationStatus(db).find((r) => r.source_event_id === eventId);
  expect(status).toBeTruthy();
  return status!;
};

const implementationQueue = (eventId: string) => {
  const queued = lessonImplementerQueue(db).find((r) => r.source_event_id === eventId);
  expect(queued).toBeTruthy();
  return queued!;
};

const gateScoreFor = (eventId: string): Record<string, unknown> => {
  const status = implementationStatus(eventId);
  expect(status.request_event_id).toBeTruthy();
  const requestPayload = rowPayload(eventRow(status.request_event_id!));
  expect(requestPayload.gate_scored_event_id).toBeTruthy();
  return eventRow(requestPayload.gate_scored_event_id as string);
};

const nextScope = () => {
  directiveSeq++;
  return { directiveId: `d_apply_gate_${directiveSeq}`, taskId: `t_apply_gate_${directiveSeq}` };
};

const emitLesson = async (
  proposedAction: Record<string, unknown>,
  scope = nextScope(),
): Promise<string> => {
  const env = await rpc("substrate.emit", {
    kind: "lesson_extracted",
    substrate_origin: "opencode",
    directive_id: scope.directiveId,
    task_id: scope.taskId,
    payload: {
      lesson_kind: "verifier_gap",
      summary: "apply a structured proposed action",
      proposed_action: proposedAction,
    },
  });
  expect(env.ok).toBe(true);
  return (env.result as { id: string }).id;
};

const emittedGateReason = async (eventId: string): Promise<string | undefined> =>
  rowPayload(gateScoreFor(eventId)).reason as string | undefined;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "acc2-apply-"));
  dbPath = join(dir, "apply.db");
  db = openDb(dbPath);
  mock.module("./rpc", () => ({ mcpCall: rpc }));
  ({ runApply } = await import("./apply"));
});

afterAll(() => {
  closeDb(dbPath);
  rmSync(dir, { recursive: true, force: true });
});

describe("runApply gates", () => {
  test("lesson_extracted proposed_action to protected target requires owner consent", async () => {
    const eventId = await emitLesson({ file_path: "CLAUDE.md", anchor: "owner gate", diff: "@@" });
    const cap = captureConsole();
    const code = await runApply([eventId]);
    cap.restore();

    expect(code).toBe(1);
    expect(cap.err.join("\n")).toContain("owner_consent_missing");

    const gateScore = gateScoreFor(eventId);
    expect(Number(gateScore.residual)).toBe(1);
    expect(rowPayload(gateScore).authorization_status).toBe("denied");
  });

  test("prior owner_decision_recorded satisfies protected target gate", async () => {
    const scope = nextScope();
    const eventId = await emitLesson({ file_path: "CLAUDE.md", anchor: "owner gate", diff: "@@" }, scope);
    const decision = await rpc("substrate.emit", {
      kind: "owner_decision_recorded",
      substrate_origin: "owner",
      directive_id: scope.directiveId,
      task_id: scope.taskId,
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

    const gateScore = gateScoreFor(eventId);
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

    const gateScore = gateScoreFor(eventId);
    expect(Number(gateScore.residual)).toBe(0);
    expect(rowPayload(gateScore).authorization_status).toBe("approved");
  });

  test("contract_amendment_proposed prompt renders structured proposed_behavior and explicit gates", async () => {
    const scope = nextScope();
    const env = await rpc("substrate.emit", {
      kind: "contract_amendment_proposed",
      substrate_origin: "opencode",
      directive_id: scope.directiveId,
      task_id: scope.taskId,
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

  // Gate-deletion (owner-approved 2026-05-16): the universal verifier
  // (residual + breakdown) replaces structured_proposed_behavior_required
  // and trajectory_hazard_present. Both refusals fought the verifier
  // instead of trusting it. These tests now assert the inverse — prose
  // proposals and hazardous trajectories proceed; the residual decides
  // whether the apply was correct.

  test("auto-apply target accepts unstructured proposals (universal verifier scores them)", async () => {
    const scope = nextScope();
    const env = await rpc("substrate.emit", {
      kind: "contract_amendment_proposed",
      substrate_origin: "opencode",
      directive_id: scope.directiveId,
      task_id: scope.taskId,
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

    expect(code).toBe(0);
    expect(cap.err.join("\n")).not.toContain("structured_proposed_behavior_required");
  });

  test("auto-apply target proceeds on hazardous trajectories (residual decides, not the hazard count)", async () => {
    const scope = nextScope();
    const eventId = await emitLesson({ file_path: "runtime/verifier.ts", anchor: "gate", diff: "@@" }, scope);
    const hazard = await rpc("substrate.emit", {
      kind: "dispatcher_violation",
      substrate_origin: "substrate",
      directive_id: scope.directiveId,
      task_id: scope.taskId,
      payload: { failure_kind: "cycle_1_only_breach" },
    });
    expect(hazard.ok).toBe(true);

    const cap = captureConsole();
    const code = await runApply([eventId]);
    cap.restore();

    expect(code).toBe(0);
    expect(cap.err.join("\n")).not.toContain("trajectory_hazard_present");
  });

  test("directive-scoped owner_decision_recorded satisfies protected target gate", async () => {
    const scope = nextScope();
    const eventId = await emitLesson({ file_path: "CLAUDE.md", anchor: "owner gate", diff: "@@" }, scope);
    const decision = await rpc("substrate.emit", {
      kind: "owner_decision_recorded",
      substrate_origin: "owner",
      directive_id: scope.directiveId,
      task_id: scope.taskId,
      payload: { outcome: "approved" },
    });
    expect(decision.ok).toBe(true);

    const cap = captureConsole();
    const code = await runApply([eventId]);
    cap.restore();

    expect(code).toBe(0);
    expect(cap.out.join("\n")).toContain("OWNER GATE — APPROVED");
  });

  test("protected structured file_path requires consent even when top-level target is safe", async () => {
    const scope = nextScope();
    const env = await rpc("substrate.emit", {
      kind: "contract_amendment_proposed",
      substrate_origin: "opencode",
      directive_id: scope.directiveId,
      task_id: scope.taskId,
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

  test("owner_decision_recorded mixed protected target does not fall through to auto-apply shape gate", async () => {
    const scope = nextScope();
    const env = await rpc("substrate.emit", {
      kind: "contract_amendment_proposed",
      substrate_origin: "opencode",
      directive_id: scope.directiveId,
      task_id: scope.taskId,
      payload: {
        target: "runtime/prompt_composer.ts",
        anchor: "gate",
        proposed_behavior: { file_path: "CLAUDE.md", anchor: "owner gate", diff: "@@" },
      },
    });
    expect(env.ok).toBe(true);
    const eventId = (env.result as { id: string }).id;

    const decision = await rpc("substrate.emit", {
      kind: "owner_decision_recorded",
      substrate_origin: "owner",
      directive_id: scope.directiveId,
      task_id: scope.taskId,
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
    // Audit #3 collapse (owner-approved 2026-05-16): applied_change_committed
    // now ALWAYS emits; verifier_passed flag distinguishes high-residual cases.
    // Legacy lesson_applied / contract_amendment_applied are deleted.
    expect(cap.out.join("\n")).toContain("applied_change_committed");
    expect(cap.out.join("\n")).toContain("verifier_failed");
    expect(cap.out.join("\n")).not.toContain("lesson_applied");

    const status = implementationStatus(eventId);
    expect(status.scored_event_id).toBeTruthy();
    expect(status.verifier_passed).toBe(false);
    // applied_change_committed now ALWAYS emits, but the terminal CTE in
    // lesson_implementation_status_view still filters status='applied' AND
    // residual<0.3 — high-residual cases set apply_event_id but leave
    // committed_event_id null. flywheel_status falls back to apply_status.
    expect(status.committed_event_id).toBeNull();
    expect(status.flywheel_status).toBe("applied");

    const queued = implementationQueue(eventId);
    expect(queued.apply_event_id).toBeTruthy();
    expect(queued.apply_status).toBe("applied");
  });
});
