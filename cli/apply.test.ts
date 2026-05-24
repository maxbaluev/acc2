// acc apply tests: prove the owner/auto gates are target/shape based, not
// special-cased by lesson kind.

import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A real commit sha that touches cli/apply.ts in this repo's history.
// classifyApply (cli/verify.ts) refuses status=applied when commit_sha
// neither exists nor touches the proposed target; the high-residual test
// asserts residual handling, NOT commit-missing refusal, so it must use a
// genuine commit instead of a fabricated sha.
const realApplyTsCommit = (): string => {
  const r = spawnSync("git", ["log", "-1", "--format=%h", "--", "cli/apply.ts"], { encoding: "utf8" });
  const sha = String(r.stdout ?? "").trim();
  if (!sha) throw new Error("no commit touching cli/apply.ts found");
  return sha;
};
import { closeDb, openDb } from "../substrate/db";
import { getArtifact, insertArtifact } from "../runtime/artifact_store";
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
// Unified owner-alignment gate override. When set, the injected evaluator
// forces a misaligned verdict at the given residual so the gate tests can
// drive the OWNER_GATE downgrade without standing up the real owner profile.
let ownerAlignmentForceResidual: number | null = null;
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

/** Narrow an MCP result to its success payload (or fail the test). The
 *  `expect` calls don't narrow the discriminated union for TS, so this
 *  guard does the narrowing AND the assertion in one place. */
const okResult = (env: { ok: boolean; result?: unknown; error?: string }): unknown => {
  expect(env.ok).toBe(true);
  if (!env.ok) throw new Error(`expected ok result, got error: ${env.error}`);
  return env.result;
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
  const status = lessonImplementationStatus(db).find((r) => r.source_event_id === eventId);
  if (status?.request_event_id) {
    const requestPayload = rowPayload(eventRow(status.request_event_id));
    expect(requestPayload.gate_scored_event_id).toBeTruthy();
    return eventRow(requestPayload.gate_scored_event_id as string);
  }
  const direct = db
    .query("SELECT * FROM events WHERE kind = 'action_scored' AND json_extract(payload, '$.source_event_id') = ? ORDER BY ts DESC, rowid DESC LIMIT 1")
    .get(eventId) as Record<string, unknown> | null;
  expect(direct).toBeTruthy();
  return direct!;
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
  return (okResult(env) as { id: string }).id;
};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "acc2-apply-"));
  dbPath = join(dir, "apply.db");
  db = openDb(dbPath);
  mock.module("./rpc", () => ({ mcpCall: rpc, auxRead: (viewName: string, args?: Record<string, unknown>) => rpc("substrate.read", { view_name: viewName, args }), auxRecentEvents: (args: Record<string, unknown>) => rpc("runtime.recent_events", args), auxGetEvent: (id: string) => rpc("substrate.get_event", { id }) }));
  const apply = await import("./apply");
  ({ runApply, setApplyEvaluatorsForTest, resetApplyEvaluatorsForTest } = apply);
  setApplyEvaluatorsForTest({
    evaluateOwnerAlignment: (input) => {
      // Default: delegate to the real RLM-first rule (hard-constraint OR
      // residual > threshold). When a test forces a residual, override it so
      // the gate downgrade path is exercised deterministically.
      const residual = ownerAlignmentForceResidual ?? Math.min(1, Math.max(0, Math.max(input.change_residual, input.target_surface_risk)));
      const constraintHit = input.hard_constraint_hit;
      const exceeds = residual > input.autonomy_threshold;
      const misaligned = constraintHit !== null || exceeds;
      const reasons: string[] = [];
      if (constraintHit !== null) reasons.push(`owner_hard_constraint:${constraintHit}`);
      if (exceeds) reasons.push("residual_exceeds_autonomy_threshold");
      if (!misaligned) reasons.push("within_autonomy_envelope");
      return {
        residual,
        verdict: misaligned ? "misaligned" : "aligned",
        hard_constraint_hit: constraintHit,
        breakdown: { mocked_owner_alignment: residual },
        reasons,
      };
    },
  });
});

beforeEach(() => {
  ownerAlignmentForceResidual = null;
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
  // is now semantic-intent-first: legacy before/after is advisory only,
  // low verifier residual and no pending
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
          diff: { kind: "legacy_advisory_context", before: "const renderGateBlock = (", after: "const renderGateBlock = (" },
        },
      },
    });
    expect(env.ok).toBe(true);
    const eventId = (okResult(env) as { id: string }).id;

    const cap = captureConsole();
    const code = await runApply([eventId]);
    cap.restore();

    const prompt = cap.out.join("\n");
    expect(code).toBe(0);
    expect(prompt).toContain("APPLY ROUTE PREDICATE");
    expect(prompt).toContain("PROPOSED CHANGE CONTEXT");
    expect(prompt).toContain("source_field: proposed_behavior");
    expect(prompt).toContain("target_resource: repo:cli/apply.ts");
    expect(prompt).toContain("legacy before/after payloads are advisory context only");
    expect(prompt).toContain("APPLY GATES");
    expect(prompt).toContain("cli_runtime_gate.target_in_scope: true");

    const gateScore = gateScoreFor(eventId);
    const gatePayload = rowPayload(gateScore);
    expect(gateScore.residual).toBeNull();
    expect(gatePayload.residual_withheld).toBe(true);
    expect(gatePayload.residual_provenance).toBe("withheld_until_closure");
    expect(gatePayload.authorization_status).toBe("approved");
    expect(gatePayload.apply_route).toBe("AUTO_APPLY");
    expect(gatePayload.apply_route_reason).toBe("preconditions_passed_local_predicate_above_threshold");
    const requestCount = db
      .query("SELECT COUNT(*) AS n FROM events WHERE kind = 'lesson_apply_requested' AND json_extract(payload, '$.source_event_id') = ?")
      .get(eventId) as { n: number };
    expect(requestCount.n).toBe(0);
    const scoreUpdateCount = db
      .query("SELECT COUNT(*) AS n FROM events WHERE kind = 'act_artifact_score_updated' AND EXISTS (SELECT 1 FROM json_each(context_refs) WHERE value = ?)")
      .get(gateScore.id as string) as { n: number };
    expect(scoreUpdateCount.n).toBe(0);
  });

  // Directive Q4CEDB2S8H5QNE4WHHGZSCC090: the apply-route gate must never
  // fabricate max-success credit at render time. A bare `acc apply <id>`
  // RENDER emits an action_scored with residual_withheld=true; the credit
  // projector (projectActionScoredToCredit) skips withheld rows, so the
  // apply_route artifact's Beta posterior must NOT move on a render. This
  // test seeds the artifact at max-alpha and proves the posterior is byte-
  // for-byte unchanged after a render — closing the residual-fabrication hole.
  test("apply RENDER does not move the apply_route artifact posterior (withheld credit)", async () => {
    // Seed the apply-route action artifact at an extreme posterior so any
    // fabricated residual=0 credit would visibly shift it.
    insertArtifact(db, {
      id: "apply_route_predicate_action",
      runtime: "cli",
      kind: "runtime_action",
      body: "apply-route predicate action (gate)",
      declaredSandbox: null,
      stateRoot: null,
      posteriorAlpha: 9000,
      posteriorBeta: 1,
      score: 0.9999,
      confidence: 0.99,
      recentResidualMean: 0,
      recentKillCount: 0,
      status: "admitted",
      name: "apply_route_predicate_action",
      fixtureInput: null,
      fixtureExpectedResidual: null,
      intent: "apply-route gate action",
      summary: "seed",
      targetFiles: null,
      targetResources: null,
      sourceCandidateId: null,
      ownerGateVerdict: null,
    });
    const before = getArtifact(db, "apply_route_predicate_action")!;

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
          diff: { kind: "legacy_advisory_context", before: "const renderGateBlock = (", after: "const renderGateBlock = (" },
        },
      },
    });
    expect(env.ok).toBe(true);
    const eventId = (okResult(env) as { id: string }).id;

    const cap = captureConsole();
    const code = await runApply([eventId]);
    cap.restore();
    expect(code).toBe(0);

    const after = getArtifact(db, "apply_route_predicate_action")!;
    expect(after.posteriorAlpha).toBe(before.posteriorAlpha);
    expect(after.posteriorBeta).toBe(before.posteriorBeta);
    expect(after.score).toBe(before.score);
    expect(after.confidence).toBe(before.confidence);
  });

  // Gate-deletion (owner-approved 2026-05-16): the universal verifier
  // (residual + breakdown) replaces structured_proposed_behavior_required
  // and trajectory-hazard prechecks. Both refusals fought the verifier
  // instead of trusting it. These tests now assert the inverse — prose
  // proposals and hazardous trajectories proceed; the residual decides
  // whether the apply was correct.

  test("auto-apply target accepts prose proposals through the semantic path", async () => {
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
    const eventId = (okResult(env) as { id: string }).id;

    const cap = captureConsole();
    const code = await runApply([eventId]);
    cap.restore();

    expect(code).toBe(0);
    expect(cap.out.join("\n")).toContain("SEMANTIC APPLY PATH");
  });

  test("auto-apply target treats legacy string diffs as advisory context", async () => {
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

    expect(code).toBe(0);
    expect(cap.out.join("\n")).toContain("SEMANTIC APPLY PATH");
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
          diff: { kind: "legacy_advisory_context", before: "describe(", after: "describe(" },
        },
      },
    });
    expect(env.ok).toBe(true);
    const eventId = (okResult(env) as { id: string }).id;

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
          diff: { kind: "legacy_advisory_context", before: "render(", after: "render(" },
        },
      },
    });
    expect(env.ok).toBe(true);
    const eventId = (okResult(env) as { id: string }).id;

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
          diff: { kind: "legacy_advisory_context", before: "export", after: "export" },
        },
      },
    });
    expect(env.ok).toBe(true);
    const eventId = (okResult(env) as { id: string }).id;

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
          diff: { kind: "legacy_advisory_context", before: "describe(", after: "describe(" },
        },
      },
    });
    expect(env.ok).toBe(true);
    const eventId = (okResult(env) as { id: string }).id;

    const cap = captureConsole();
    const code = await runApply([eventId]);
    cap.restore();

    const gateScore = gateScoreFor(eventId);
    const payload = rowPayload(gateScore);
    expect(payload.apply_route).not.toBe("AUTO_APPLY_TEST_LANE");
    expect(payload.apply_route_reason).not.toBe("test_lane_target");
  });

  test("owner-alignment gate blocks autonomous apply on high residual and opens reconciliation", async () => {
    ownerAlignmentForceResidual = 0.72;
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
          diff: { kind: "legacy_advisory_context", before: "const renderGateBlock = (", after: "const renderGateBlock = (" },
        },
      },
    });
    expect(env.ok).toBe(true);
    const eventId = (okResult(env) as { id: string }).id;

    const cap = captureConsole();
    const code = await runApply([eventId]);
    cap.restore();

    expect(code).toBe(1);
    expect(cap.err.join("\n")).toContain("owner_alignment_predicate");
    const gateScore = gateScoreFor(eventId);
    const payload = rowPayload(gateScore);
    expect(payload.apply_route).toBe("OWNER_GATE");
    expect(payload.apply_route_reason).toBe("owner_alignment_predicate");
    const preconditions = payload.apply_route_preconditions as Record<string, unknown>;
    expect(preconditions.owner_alignment_residual).toBe(0.72);
    expect(preconditions.reconciliation_required).toBe(true);
  });

  test("owner-alignment gate allows safe autonomous apply within the autonomy envelope", async () => {
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
          diff: { kind: "legacy_advisory_context", before: "const renderGateBlock = (", after: "const renderGateBlock = (" },
        },
      },
    });
    expect(env.ok).toBe(true);
    const eventId = (okResult(env) as { id: string }).id;

    const cap = captureConsole();
    const code = await runApply([eventId]);
    cap.restore();

    expect(code).toBe(0);
    const payload = rowPayload(gateScoreFor(eventId));
    expect(payload.apply_route).toBe("AUTO_APPLY");
    expect(payload.apply_route_reason).toBe("preconditions_passed_local_predicate_above_threshold");
  });

  test("owner-alignment gate downgrades autonomous apply when residual exceeds the autonomy threshold", async () => {
    ownerAlignmentForceResidual = 0.78;
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
          diff: { kind: "legacy_advisory_context", before: "const renderGateBlock = (", after: "const renderGateBlock = (" },
        },
      },
    });
    expect(env.ok).toBe(true);
    const eventId = (okResult(env) as { id: string }).id;

    const cap = captureConsole();
    const code = await runApply([eventId]);
    cap.restore();

    expect(code).toBe(1);
    expect(cap.err.join("\n")).toContain("owner_alignment_predicate");
    const payload = rowPayload(gateScoreFor(eventId));
    expect(payload.apply_route).toBe("OWNER_GATE");
    expect(payload.apply_route_reason).toBe("owner_alignment_predicate");
    const preconditions = payload.apply_route_preconditions as Record<string, unknown>;
    expect(preconditions.owner_alignment_residual).toBe(0.78);
    expect(preconditions.owner_alignment_verdict).toBe("misaligned");
  });

  test("owner-alignment read failure fails open (auto-apply preserved)", async () => {
    failOwnerProfileRead = true;
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
          diff: { kind: "legacy_advisory_context", before: "const renderGateBlock = (", after: "const renderGateBlock = (" },
        },
      },
    });
    expect(env.ok).toBe(true);
    const eventId = (okResult(env) as { id: string }).id;

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
      diff: { kind: "legacy_advisory_context", before: "const renderGateBlock = (", after: "const renderGateBlock = (" },
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
      realApplyTsCommit(),
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

  test("lesson_extracted claiming a fabricated commit_sha is refused (no fabricated credit chain)", async () => {
    // The Layer-1 commit-existence prerequisite is kind-agnostic: a
    // lesson_extracted that DECLARES a target and claims status=applied with a
    // commit_sha must prove the commit exists and touches the target, exactly
    // like a contract_amendment_proposed. Otherwise a lesson could fabricate an
    // applied_change_committed credit chain against a commit that never landed.
    const eventId = await emitLesson({
      target_resource: "repo:cli/apply.ts",
      anchor: "renderGateBlock",
      diff: { kind: "legacy_advisory_context", before: "const renderGateBlock = (", after: "const renderGateBlock = (" },
    });
    const cap = captureConsole();
    const code = await runApply([
      "--record",
      eventId,
      "--status",
      "applied",
      "--residual",
      "0",
      "--commit-sha",
      "deadbeef99", // fabricated — not in git history
    ]);
    cap.restore();

    // Refused with the dedicated mismatch exit code; NO applied_change_committed
    // line on stdout (the credit chain is not written).
    expect(code).toBe(3);
    expect(cap.out.join("\n")).not.toContain("applied_change_committed");
    expect(cap.err.join("\n")).toContain("does not exist or does not touch the proposed target");

    // No act_tuple_recorded credit envelope was written for this fabricated apply.
    const act = db
      .query("SELECT id FROM events WHERE kind = 'act_tuple_recorded' AND json_extract(payload, '$.source_event_id') = ? AND json_extract(payload, '$.verifier_kind') = 'claude_apply_record'")
      .get(eventId) as { id: string } | null;
    expect(act).toBeNull();
  });

  test("owner-alignment gate blocks autonomous apply on a things_to_never_do hard-constraint hit", async () => {
    // High-stakes safety: a change touching a surface the owner has named in
    // things_to_never_do must NOT auto-apply, even when the change residual is
    // low. The unified gate matches the hard-constraint string against the
    // target surface and routes to OWNER_GATE.
    const scope = nextScope();
    const profileEnv = await rpc("substrate.emit", {
      kind: "owner_profile_recorded",
      substrate_origin: "substrate",
      directive_id: scope.directiveId,
      task_id: scope.taskId,
      payload: {
        things_to_never_do: ["cli/apply.ts"],
        autonomy_signals: { autonomy_threshold: 0.5 },
      },
    });
    expect(profileEnv.ok).toBe(true);
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
          diff: { kind: "legacy_advisory_context", before: "const renderGateBlock = (", after: "const renderGateBlock = (" },
        },
      },
    });
    expect(env.ok).toBe(true);
    const eventId = (okResult(env) as { id: string }).id;

    const cap = captureConsole();
    const code = await runApply([eventId]);
    cap.restore();

    expect(code).toBe(1);
    // things_to_never_do is enforced at authorizeApply (owner_policy gate)
    // BEFORE the autonomous-commit gate when no owner approval exists, so the
    // hard constraint is honored either way. Assert the apply is refused.
    const payload = rowPayload(gateScoreFor(eventId));
    expect(payload.apply_route).not.toBe("AUTO_APPLY");
    expect(payload.apply_route).not.toBe("AUTO_APPLY_TEST_LANE");
  });
});

