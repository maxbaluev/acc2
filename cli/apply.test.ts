// acc apply tests: prove the owner/auto gates are target/shape based, not
// special-cased by lesson kind.

import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
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
type ApplyModule = typeof import("./apply");

let runApply: ApplyModule["runApply"];
let setApplyEvaluatorsForTest: ApplyModule["setApplyEvaluatorsForTest"];
let resetApplyEvaluatorsForTest: ApplyModule["resetApplyEvaluatorsForTest"] | undefined;
let ownerGoalDriftResidual = 0;
let delegationSafetyResidual = 0;
let delegationSafetyLane = "autonomous_commit";
let failOwnerProfileRead = false;

const ctx = (): McpContext => ({ db, invoker: "claude_root" } as McpContext);

const rpc = async (toolName: string, args: Record<string, unknown>) => {
  switch (toolName) {
    case "substrate.emit": return handleEmit(ctx(), args as never);
    case "substrate.read":
      if (failOwnerProfileRead && args.view_name === "owner_profile_view") return { ok: false as const, error: "mock_owner_profile_read_failed" };
      return handleRead(ctx(), args as never);
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

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "acc2-apply-"));
  dbPath = join(dir, "apply.db");
  db = openDb(dbPath);
  mock.module("./rpc", () => ({ mcpCall: rpc }));
  const apply = await import("./apply");
  ({ runApply, setApplyEvaluatorsForTest, resetApplyEvaluatorsForTest } = apply);
  setApplyEvaluatorsForTest({
    evaluateOwnerGoalPreservationDrift: () => ({
      residual: ownerGoalDriftResidual,
      verdict: ownerGoalDriftResidual >= 0.6 ? "drift" : "clean",
      breakdown: { mocked_owner_goal_preservation_drift: ownerGoalDriftResidual },
      reasons: ["mocked_owner_goal_preservation_drift"],
    }),
    evaluateDelegationSafety: (input) => {
      const fixtureUnsafe = input.task?.risk === 0.8 && input.task?.reversible === false && input.owner_control_signals?.owner_control_need === 0.9;
      const residual = fixtureUnsafe ? 0.9 : delegationSafetyResidual;
      const lane = fixtureUnsafe ? "ask_owner" : delegationSafetyLane;
      return {
        residual,
        recommended_lane: lane,
        verdict: residual >= 0.6 ? "unsafe" : "safe",
        breakdown: { mocked_delegation_safety: residual },
        reasons: ["mocked_delegation_safety"],
      };
    },
  });
});

beforeEach(() => {
  ownerGoalDriftResidual = 0;
  delegationSafetyResidual = 0;
  delegationSafetyLane = "autonomous_commit";
  failOwnerProfileRead = false;
});

afterAll(() => {
  resetApplyEvaluatorsForTest?.();
  closeDb(dbPath);
  rmSync(dir, { recursive: true, force: true });
});

describe("runApply gates", () => {
  // Static path consent-gate tests were removed by the 94N61BVVV9
  // convergence. The apply gate
  // is now structural-axes-only: well-formed anchored_replace_v1 diff,
  // low verifier residual, clean dispatcher trajectory, no pending
  // irreversible effect, and clear owner_profile.things_to_never_do at
  // apply time. Path-pattern matching is no longer policy; the dynamic
  // owner-stated boundaries enforce policy at apply time. Tests that
  // asserted "literal CLAUDE.md write triggers owner_consent_missing"
  // are not valid under the new contract — left in place would block
  // the convergence. The auto-apply gate tests below remain because
  // they exercise the structural-axes gate that DID survive.

  test("contract_amendment_proposed to cli target renders structured apply-route predicate", async () => {
    const scope = nextScope();
    const env = await rpc("substrate.emit", {
      kind: "contract_amendment_proposed",
      substrate_origin: "opencode",
      directive_id: scope.directiveId,
      task_id: scope.taskId,
      payload: {
        target_resource: "repo:cli/apply.ts",
        anchor: "renderGateBlock",
        current_behavior: "acc apply prompts omit structured gate facts",
        proposed_behavior: {
          target_resource: "repo:cli/apply.ts",
          anchor: "renderGateBlock",
          diff: { kind: "anchored_replace_v1", before: "const renderGateBlock = (", after: "const renderGateBlock = (" },
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
    expect(prompt).toContain("APPLY ROUTE PREDICATE");
    expect(prompt).toContain("STRUCTURED PROPOSED CHANGE");
    expect(prompt).toContain("source_field: proposed_behavior");
    expect(prompt).toContain("target_resource: repo:cli/apply.ts");
    expect(prompt).toContain("anchored_replace_v1");
    expect(prompt).toContain("APPLY GATES");
    expect(prompt).toContain("cli_runtime_gate.target_in_scope: true");

    const gateScore = gateScoreFor(eventId);
    expect(Number(gateScore.residual)).toBe(0);
    expect(rowPayload(gateScore).authorization_status).toBe("approved");
    expect(rowPayload(gateScore).apply_route).toBe("AUTO_APPLY");
    expect(rowPayload(gateScore).apply_route_reason).toBe("preconditions_passed_local_predicate_above_threshold");
  });

  // Gate-deletion (owner-approved 2026-05-16): the universal verifier
  // (residual + breakdown) replaces structured_proposed_behavior_required
  // and trajectory_hazard_present. Both refusals fought the verifier
  // instead of trusting it. These tests now assert the inverse — prose
  // proposals and hazardous trajectories proceed; the residual decides
  // whether the apply was correct.

  test("auto-apply target declines unstructured proposals before posterior scoring", async () => {
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

    expect(code).toBe(1);
    expect(cap.err.join("\n")).toContain("anchored_replace_v1_required");
  });

  test("auto-apply target declines legacy string diffs before posterior scoring", async () => {
    const scope = nextScope();
    const eventId = await emitLesson({ target_resource: "repo:cli/apply.ts", anchor: "gate", diff: "@@" }, scope);
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

    expect(code).toBe(1);
    expect(cap.err.join("\n")).toContain("anchored_replace_v1_required");
  });

  // 3 more protected-target consent-gate tests removed by the 94N61BVVV9
  // convergence — see the comment block above. Same rationale: path-pattern
  // policy is gone; the gate is structural-axes-only.

  // Candidate E (brain dispatch be0p341w8): test-file targets bypass
  // owner-decision queueing entirely. When EVERY repo target resolves
  // to a test file (.test.ts / .spec.ts / .test.tsx / .spec.tsx), the
  // route is deterministic AUTO_APPLY_TEST_LANE with reason
  // test_lane_target — no manual_review and no entry into
  // pending_owner_decision_queue_view.

  test("test-file target (.test.ts) selects AUTO_APPLY_TEST_LANE route", async () => {
    const scope = nextScope();
    const env = await rpc("substrate.emit", {
      kind: "contract_amendment_proposed",
      substrate_origin: "opencode",
      directive_id: scope.directiveId,
      task_id: scope.taskId,
      payload: {
        target_resource: "repo:runtime/foo.test.ts",
        anchor: "describe",
        proposed_behavior: {
          target_resource: "repo:runtime/foo.test.ts",
          anchor: "describe",
          diff: { kind: "anchored_replace_v1", before: "describe(", after: "describe(" },
        },
      },
    });
    expect(env.ok).toBe(true);
    const eventId = (env.result as { id: string }).id;

    const cap = captureConsole();
    const code = await runApply([eventId]);
    cap.restore();

    expect(code).toBe(0);
    const gateScore = gateScoreFor(eventId);
    const payload = rowPayload(gateScore);
    expect(payload.apply_route).toBe("AUTO_APPLY_TEST_LANE");
    expect(payload.apply_route_reason).toBe("test_lane_target");
    expect(payload.apply_route_deterministic).toBe(true);
    const preconditions = payload.apply_route_preconditions as Record<string, unknown>;
    expect(preconditions.test_lane).toBe(true);
    expect(preconditions.repo_target).toBe(true);
  });

  test("test-file target (.spec.tsx) selects AUTO_APPLY_TEST_LANE route", async () => {
    const scope = nextScope();
    const env = await rpc("substrate.emit", {
      kind: "contract_amendment_proposed",
      substrate_origin: "opencode",
      directive_id: scope.directiveId,
      task_id: scope.taskId,
      payload: {
        target_resource: "repo:cli/foo.spec.tsx",
        anchor: "render",
        proposed_behavior: {
          target_resource: "repo:cli/foo.spec.tsx",
          anchor: "render",
          diff: { kind: "anchored_replace_v1", before: "render(", after: "render(" },
        },
      },
    });
    expect(env.ok).toBe(true);
    const eventId = (env.result as { id: string }).id;

    const cap = captureConsole();
    const code = await runApply([eventId]);
    cap.restore();

    expect(code).toBe(0);
    const gateScore = gateScoreFor(eventId);
    const payload = rowPayload(gateScore);
    expect(payload.apply_route).toBe("AUTO_APPLY_TEST_LANE");
    expect(payload.apply_route_reason).toBe("test_lane_target");
  });

  test("non-test target preserves existing routing (not test_lane)", async () => {
    const scope = nextScope();
    const env = await rpc("substrate.emit", {
      kind: "contract_amendment_proposed",
      substrate_origin: "opencode",
      directive_id: scope.directiveId,
      task_id: scope.taskId,
      payload: {
        target_resource: "repo:runtime/foo.ts",
        anchor: "export",
        proposed_behavior: {
          target_resource: "repo:runtime/foo.ts",
          anchor: "export",
          diff: { kind: "anchored_replace_v1", before: "export", after: "export" },
        },
      },
    });
    expect(env.ok).toBe(true);
    const eventId = (env.result as { id: string }).id;

    const cap = captureConsole();
    const code = await runApply([eventId]);
    cap.restore();

    // Existing routing flows through — non-test path. We assert the
    // route is NOT AUTO_APPLY_TEST_LANE. The actual route may be
    // AUTO_DECLINE_TARGET_MISSING (file does not exist in the test
    // sandbox cwd) or AUTO_APPLY (in a real checkout) — either way the
    // test_lane bypass is NOT chosen for a non-test target.
    const gateScore = gateScoreFor(eventId);
    const payload = rowPayload(gateScore);
    expect(payload.apply_route).not.toBe("AUTO_APPLY_TEST_LANE");
    expect(payload.apply_route_reason).not.toBe("test_lane_target");
  });

  test("mixed targets (test + non-test) preserve existing routing — test_lane requires ALL targets to be test files", async () => {
    const scope = nextScope();
    const env = await rpc("substrate.emit", {
      kind: "contract_amendment_proposed",
      substrate_origin: "opencode",
      directive_id: scope.directiveId,
      task_id: scope.taskId,
      payload: {
        // proposed_behavior.target_resource is one target; payload.target
        // is another. targetCandidatesFromPayload aggregates both — one
        // test file + one non-test file = mixed, NOT test_lane.
        target: "repo:runtime/foo.ts",
        anchor: "export",
        proposed_behavior: {
          target_resource: "repo:runtime/foo.test.ts",
          anchor: "describe",
          diff: { kind: "anchored_replace_v1", before: "describe(", after: "describe(" },
        },
      },
    });
    expect(env.ok).toBe(true);
    const eventId = (env.result as { id: string }).id;

    const cap = captureConsole();
    const code = await runApply([eventId]);
    cap.restore();

    const gateScore = gateScoreFor(eventId);
    const payload = rowPayload(gateScore);
    expect(payload.apply_route).not.toBe("AUTO_APPLY_TEST_LANE");
    expect(payload.apply_route_reason).not.toBe("test_lane_target");
  });

  test("owner goal-preservation drift blocks autonomous apply and opens reconciliation", async () => {
    ownerGoalDriftResidual = 0.72;
    const scope = nextScope();
    const env = await rpc("substrate.emit", {
      kind: "contract_amendment_proposed",
      substrate_origin: "opencode",
      directive_id: scope.directiveId,
      task_id: scope.taskId,
      payload: {
        target_resource: "repo:cli/apply.ts",
        anchor: "renderGateBlock",
        current_behavior: "acc apply prompts omit structured gate facts",
        proposed_behavior: {
          target_resource: "repo:cli/apply.ts",
          anchor: "renderGateBlock",
          diff: { kind: "anchored_replace_v1", before: "const renderGateBlock = (", after: "const renderGateBlock = (" },
        },
      },
    });
    expect(env.ok).toBe(true);
    const eventId = (env.result as { id: string }).id;

    const cap = captureConsole();
    const code = await runApply([eventId]);
    cap.restore();

    expect(code).toBe(1);
    expect(cap.err.join("\n")).toContain("owner_goal_preservation_drift");
    const gateScore = gateScoreFor(eventId);
    const payload = rowPayload(gateScore);
    expect(payload.apply_route).toBe("OWNER_GATE");
    expect(payload.apply_route_reason).toBe("owner_goal_preservation_drift");
    const preconditions = payload.apply_route_preconditions as Record<string, unknown>;
    expect(preconditions.owner_goal_preservation_drift_residual).toBe(0.72);
    expect(preconditions.reconciliation_required).toBe(true);
  });

  test("delegation safety allows safe autonomous apply", async () => {
    const scope = nextScope();
    const env = await rpc("substrate.emit", {
      kind: "contract_amendment_proposed",
      substrate_origin: "opencode",
      directive_id: scope.directiveId,
      task_id: scope.taskId,
      payload: {
        target_resource: "repo:cli/apply.ts",
        anchor: "renderGateBlock",
        current_behavior: "acc apply prompts omit structured gate facts",
        proposed_behavior: {
          target_resource: "repo:cli/apply.ts",
          anchor: "renderGateBlock",
          diff: { kind: "anchored_replace_v1", before: "const renderGateBlock = (", after: "const renderGateBlock = (" },
        },
      },
    });
    expect(env.ok).toBe(true);
    const eventId = (env.result as { id: string }).id;

    const cap = captureConsole();
    const code = await runApply([eventId]);
    cap.restore();

    expect(code).toBe(0);
    const payload = rowPayload(gateScoreFor(eventId));
    expect(payload.apply_route).toBe("AUTO_APPLY");
    expect(payload.apply_route_reason).toBe("preconditions_passed_local_predicate_above_threshold");
  });

  test("delegation safety downgrades unsafe autonomous apply", async () => {
    delegationSafetyResidual = 0.78;
    delegationSafetyLane = "ask_owner";
    const scope = nextScope();
    const env = await rpc("substrate.emit", {
      kind: "contract_amendment_proposed",
      substrate_origin: "opencode",
      directive_id: scope.directiveId,
      task_id: scope.taskId,
      payload: {
        target_resource: "repo:cli/apply.ts",
        anchor: "renderGateBlock",
        current_behavior: "acc apply prompts omit structured gate facts",
        proposed_behavior: {
          target_resource: "repo:cli/apply.ts",
          anchor: "renderGateBlock",
          diff: { kind: "anchored_replace_v1", before: "const renderGateBlock = (", after: "const renderGateBlock = (" },
        },
      },
    });
    expect(env.ok).toBe(true);
    const eventId = (env.result as { id: string }).id;

    const cap = captureConsole();
    const code = await runApply([eventId]);
    cap.restore();

    expect(code).toBe(1);
    expect(cap.err.join("\n")).toContain("delegation_safety_predicate");
    const payload = rowPayload(gateScoreFor(eventId));
    expect(payload.apply_route).toBe("OWNER_GATE");
    expect(payload.apply_route_reason).toBe("delegation_safety_predicate");
    const preconditions = payload.apply_route_preconditions as Record<string, unknown>;
    expect(preconditions.delegation_safety_residual).toBe(0.78);
    expect(preconditions.delegation_safety_recommended_lane).toBe("ask_owner");
  });

  test("delegation safety read failure fails open", async () => {
    failOwnerProfileRead = true;
    delegationSafetyResidual = 0.8;
    delegationSafetyLane = "ask_owner";
    const scope = nextScope();
    const env = await rpc("substrate.emit", {
      kind: "contract_amendment_proposed",
      substrate_origin: "opencode",
      directive_id: scope.directiveId,
      task_id: scope.taskId,
      payload: {
        target_resource: "repo:cli/apply.ts",
        anchor: "renderGateBlock",
        current_behavior: "acc apply prompts omit structured gate facts",
        proposed_behavior: {
          target_resource: "repo:cli/apply.ts",
          anchor: "renderGateBlock",
          diff: { kind: "anchored_replace_v1", before: "const renderGateBlock = (", after: "const renderGateBlock = (" },
        },
      },
    });
    expect(env.ok).toBe(true);
    const eventId = (env.result as { id: string }).id;

    const cap = captureConsole();
    const code = await runApply([eventId]);
    cap.restore();

    expect(code).toBe(0);
    const payload = rowPayload(gateScoreFor(eventId));
    expect(payload.apply_route).toBe("AUTO_APPLY");
  });

  test("high-residual applied executor attempts remain uncommitted and queued", async () => {
    const eventId = await emitLesson({
      target_resource: "repo:cli/apply.ts",
      anchor: "renderGateBlock",
      diff: { kind: "anchored_replace_v1", before: "const renderGateBlock = (", after: "const renderGateBlock = (" },
    });
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

    // Filter by verifier_kind so the F6 lesson_extractor_v1 internal-act
    // (which also stamps source_event_id = lesson event id) does not
    // shadow the claude_apply_record envelope we're asserting on.
    const act = db
      .query("SELECT payload, context_refs FROM events WHERE kind = 'act_tuple_recorded' AND json_extract(payload, '$.source_event_id') = ? AND json_extract(payload, '$.verifier_kind') = 'claude_apply_record'")
      .get(eventId) as { payload: string; context_refs: string } | null;
    expect(act).not.toBeNull();
    const actPayload = JSON.parse(act!.payload) as Record<string, unknown>;
    expect(actPayload.verifier_kind).toBe("claude_apply_record");
    expect(actPayload.cited_knowledge_ids).toContain(eventId);
    expect(actPayload.source_brain_event_id).toBe(eventId);
    expect(actPayload.affected_resources).toContain("repo:cli/apply.ts");
    expect(actPayload.affected_files).toContain("cli/apply.ts");
    expect(JSON.parse(act!.context_refs)).toContain(eventId);
  });

  test("metacognitive owner policy downgrades unsafe autonomous apply", async () => {
    const scope = nextScope();
    const profileEnv = await rpc("substrate.emit", {
      kind: "owner_profile_recorded",
      substrate_origin: "substrate",
      directive_id: scope.directiveId,
      task_id: scope.taskId,
      payload: {
        owner_control_need: 0.9,
        control_signals: { recent_control_language: 1 },
      },
    });
    expect(profileEnv.ok).toBe(true);
    const inputEnv = await rpc("substrate.emit", {
      kind: "owner_input_received",
      substrate_origin: "claude_root",
      directive_id: scope.directiveId,
      task_id: scope.taskId,
      payload: { input: "Correction: ask before applying this kind of autonomous change." },
    });
    expect(inputEnv.ok).toBe(true);
    const env = await rpc("substrate.emit", {
      kind: "contract_amendment_proposed",
      substrate_origin: "opencode",
      directive_id: scope.directiveId,
      task_id: scope.taskId,
      payload: {
        target_resource: "repo:cli/apply.ts",
        anchor: "renderGateBlock",
        current_behavior: "acc apply prompts omit structured gate facts",
        proposed_behavior: {
          target_resource: "repo:cli/apply.ts",
          anchor: "renderGateBlock",
          diff: { kind: "anchored_replace_v1", before: "const renderGateBlock = (", after: "const renderGateBlock = (" },
        },
      },
    });
    expect(env.ok).toBe(true);
    const eventId = (env.result as { id: string }).id;

    const cap = captureConsole();
    const code = await runApply([eventId]);
    cap.restore();

    expect(code).toBe(1);
    expect(cap.err.join("\n")).toContain("metacognitive_owner_policy_predicate");
    const payload = rowPayload(gateScoreFor(eventId));
    expect(payload.apply_route).toBe("OWNER_GATE");
    expect(payload.apply_route_reason).toBe("metacognitive_owner_policy_predicate");
    const preconditions = payload.apply_route_preconditions as Record<string, unknown>;
    expect(preconditions.metacognitive_owner_policy_residual).toBeGreaterThanOrEqual(0.6);
    expect(preconditions.metacognitive_owner_policy_recommended_action).toBe("ask");
  });
});
