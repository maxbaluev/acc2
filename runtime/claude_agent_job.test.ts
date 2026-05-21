import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { closeDb, openDb } from "../substrate/db";
import { runViews } from "../substrate/views";
import { decideDispatch } from "./dispatch_decider";
import { emitEvent } from "./events";
import { registerPeer } from "./peer_registry";
import type { TaskNode } from "./task_topology";
import { claimJob, completeJob, readPendingJobs, requestJob } from "./claude_agent_job";

const task = (overrides: Partial<TaskNode> = {}): TaskNode => ({
  id: "task-claude-agent",
  directive_id: "directive-claude-agent",
  parent_id: null,
  goal: "Implement parallel queue-backed agent work across runtime and substrate surfaces",
  status: "pending",
  target_resources: ["repo:runtime/dispatch_decider.ts", "repo:substrate/views.ts"],
  ...overrides,
} as TaskNode);

describe("claude agent job lane", () => {
  afterAll(() => closeDb());
  beforeEach(() => closeDb());

  test("dispatch routes to claude_agent only with a live Claude peer", () => {
    const db = openDb(":memory:");
    runViews(db);
    emitEvent(db, {
      kind: "directive_opened",
      substrate_origin: "owner",
      directive_id: "directive-claude-agent",
      payload: { directive_text: "Implement parallel queue-backed agent work", lifecycle: "finite" },
    });

    expect(decideDispatch(db, task()).route).not.toBe("claude_agent");

    registerPeer(db, {
      peer_id: "claude-peer-1",
      kind: "claude_agent",
      spawnability: "externally_launched",
      directive_id: "directive-claude-agent",
      scope: { lane: "claude_agent" },
    });

    const decision = decideDispatch(db, task());
    expect(decision.route).toBe("claude_agent");
    if (decision.route === "claude_agent") {
      expect(decision.job_intent).toContain("parallel queue-backed");
      expect(decision.acceptance_predicate).toMatchObject({ closure_requires_act_tuple_recorded: true });
    }
  });

  test("requested jobs queue, claim liveness requeues stale claims, and completion projects symmetric act credit", () => {
    const db = openDb(":memory:");
    runViews(db);
    registerPeer(db, {
      peer_id: "claude-peer-queue",
      kind: "claude_agent",
      spawnability: "externally_launched",
      directive_id: "directive-queue",
      task_id: "task-queue",
    });

    const requested = requestJob(db, {
      directive_id: "directive-queue",
      task_id: "task-queue",
      intent: "patch queue lane",
      target_files: ["runtime/claude_agent_job.ts"],
      acceptance_predicate: { residual_below: 0.3 },
    });
    expect(readPendingJobs(db).map((job) => job.job_id)).toContain(requested.job_id);

    claimJob(db, { job_id: requested.job_id, claimant_peer_id: "claude-peer-queue" });
    expect(readPendingJobs(db).map((job) => job.job_id)).not.toContain(requested.job_id);

    db.query(`UPDATE events SET ts = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-10 minutes') WHERE kind IN ('peer_registered', 'peer_liveness')`).run();
    const requeued = readPendingJobs(db).find((job) => job.job_id === requested.job_id);
    expect(requeued?.queue_status).toBe("stale_claim_requeued");

    const completed = completeJob(db, {
      job_id: requested.job_id,
      directive_id: "directive-queue",
      task_id: "task-queue",
      claimant_peer_id: "claude-peer-queue",
      act: {
        intent: "complete queue lane patch",
        reasoning_summary: "Claude agent work completed via the shared act tuple envelope",
        effect_summary: "queue lane patch verified",
        verifier_kind: "deterministic_code",
        action_artifact_id: "claude_agent_patch_action",
        verifier_artifact_id: "claude_agent_patch_verifier",
        predicted_residual: 0.2,
        observed_residual: 0.1,
        affected_resources: ["repo:runtime/claude_agent_job.ts"],
        cited_artifact_ids: ["claude_agent_patch_action"],
      },
    });
    expect(readPendingJobs(db).map((job) => job.job_id)).not.toContain(requested.job_id);

    const projected = db.query(`SELECT kind, payload FROM events WHERE task_id = ? ORDER BY ts ASC`).all("task-queue") as Array<{ kind: string; payload: string }>;
    expect(projected.map((row) => row.kind)).toContain("act_tuple_recorded");
    expect(projected.map((row) => row.kind)).toContain("action_scored");
    expect(projected.map((row) => row.kind)).toContain("candidate_confirmed");
    expect(projected.map((row) => row.kind)).toContain("claude_agent_job_completed");
    expect(JSON.parse(projected.find((row) => row.kind === "claude_agent_job_completed")!.payload).act_id).toBe(completed.act.id);
  });
});
