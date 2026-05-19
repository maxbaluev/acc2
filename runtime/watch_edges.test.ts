import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { closeDb, openDb } from "../substrate/db";
import { emitEvent } from "./events";
import { newId } from "./ids";
import { snapshotWatchedOutputs, detectRevocationViolations } from "./watch_edges";

afterAll(() => closeDb());
beforeEach(() => closeDb());

const seedDirective = (db: ReturnType<typeof openDb>) => {
  const directiveId = newId();
  const upstream = newId();
  const downstream = newId();
  emitEvent(db, {
    kind: "task_node_opened",
    directive_id: directiveId,
    task_id: upstream,
    payload: { goal: "upstream" },
  });
  emitEvent(db, {
    kind: "task_node_opened",
    directive_id: directiveId,
    task_id: downstream,
    payload: { goal: "downstream" },
  });
  return { directiveId, upstream, downstream };
};

describe("watch_edges", () => {
  test("monotonic mode surfaces all upstream events in ts-order", () => {
    const db = openDb(":memory:");
    const { directiveId, upstream, downstream } = seedDirective(db);
    emitEvent(db, {
      kind: "task_edge_recorded",
      directive_id: directiveId,
      task_id: downstream,
      payload: { from_task: upstream, to_task: downstream, kind: "watches", consistency_mode: "monotonic" },
    });
    // Emit two action_scored events on the upstream.
    emitEvent(db, {
      kind: "action_scored",
      directive_id: directiveId,
      task_id: upstream,
      action_artifact_id: "test_action_handle",
      verifier_artifact_id: "test_verifier_handle",
      residual: 0.5,
      payload: { iter: 1, verifier_kind: "deterministic_code" },
    });
    emitEvent(db, {
      kind: "action_scored",
      directive_id: directiveId,
      task_id: upstream,
      action_artifact_id: "test_action_handle",
      verifier_artifact_id: "test_verifier_handle",
      residual: 0.2,
      payload: { iter: 2, verifier_kind: "deterministic_code" },
    });

    const observations = snapshotWatchedOutputs(db, downstream);
    const scored = observations.filter((o) => o.event_kind === "action_scored");
    expect(scored.length).toBe(2);
    expect(scored[0]!.consistency_mode).toBe("monotonic");
    // ts-asc ordering
    expect(scored[0]!.observed_at <= scored[1]!.observed_at).toBe(true);
  });

  test("snapshot_now returns only the latest event per kind", () => {
    const db = openDb(":memory:");
    const { directiveId, upstream, downstream } = seedDirective(db);
    emitEvent(db, {
      kind: "task_edge_recorded",
      directive_id: directiveId,
      task_id: downstream,
      payload: { from_task: upstream, to_task: downstream, kind: "watches", consistency_mode: "snapshot_now" },
    });
    emitEvent(db, {
      kind: "action_scored",
      directive_id: directiveId,
      task_id: upstream,
      action_artifact_id: "test_action_handle",
      verifier_artifact_id: "test_verifier_handle",
      payload: { iter: 1, verifier_kind: "deterministic_code" },
    });
    emitEvent(db, {
      kind: "action_scored",
      directive_id: directiveId,
      task_id: upstream,
      action_artifact_id: "test_action_handle",
      verifier_artifact_id: "test_verifier_handle",
      payload: { iter: 2, verifier_kind: "deterministic_code" },
    });
    emitEvent(db, {
      kind: "action_scored",
      directive_id: directiveId,
      task_id: upstream,
      action_artifact_id: "test_action_handle",
      verifier_artifact_id: "test_verifier_handle",
      payload: { iter: 3, verifier_kind: "deterministic_code" },
    });

    const observations = snapshotWatchedOutputs(db, downstream);
    const scored = observations.filter((o) => o.event_kind === "action_scored");
    expect(scored.length).toBe(1);
    const payload = scored[0]!.payload as Record<string, unknown>;
    expect(payload.iter).toBe(3);
    expect(scored[0]!.consistency_mode).toBe("snapshot_now");
  });

  test("read_your_writes still surfaces upstream events under that mode marker", () => {
    const db = openDb(":memory:");
    const { directiveId, upstream, downstream } = seedDirective(db);
    emitEvent(db, {
      kind: "task_edge_recorded",
      directive_id: directiveId,
      task_id: downstream,
      payload: { from_task: upstream, to_task: downstream, kind: "watches", consistency_mode: "read_your_writes" },
    });
    emitEvent(db, {
      kind: "task_committed",
      directive_id: directiveId,
      task_id: upstream,
      outcome: "succeeded",
      payload: { final: true },
    });

    const observations = snapshotWatchedOutputs(db, downstream);
    expect(observations.length).toBeGreaterThan(0);
    expect(observations.every((o) => o.consistency_mode === "read_your_writes")).toBe(true);
  });

  test("detectRevocationViolations flags revocation under monotonic edges", () => {
    const db = openDb(":memory:");
    const { directiveId, upstream, downstream } = seedDirective(db);
    emitEvent(db, {
      kind: "task_edge_recorded",
      directive_id: directiveId,
      task_id: downstream,
      payload: { from_task: upstream, to_task: downstream, kind: "watches", consistency_mode: "monotonic" },
    });
    // Upstream legit observation
    emitEvent(db, {
      kind: "action_scored",
      directive_id: directiveId,
      task_id: upstream,
      action_artifact_id: "test_action_handle",
      verifier_artifact_id: "test_verifier_handle",
      payload: { count: 5, verifier_kind: "deterministic_code" },
    });
    // Upstream revokes — synthetic kind via payload.revocation=true
    emitEvent(db, {
      kind: "action_scored",
      directive_id: directiveId,
      task_id: upstream,
      action_artifact_id: "test_action_handle",
      verifier_artifact_id: "test_verifier_handle",
      payload: { count: 3, revocation: true, verifier_kind: "deterministic_code" },
    });

    const violations = detectRevocationViolations(db, directiveId);
    expect(violations.length).toBeGreaterThanOrEqual(1);
  });

  test("detectRevocationViolations returns empty when no watch edges exist", () => {
    const db = openDb(":memory:");
    const { directiveId, upstream } = seedDirective(db);
    emitEvent(db, {
      kind: "action_scored",
      directive_id: directiveId,
      task_id: upstream,
      action_artifact_id: "test_action_handle",
      verifier_artifact_id: "test_verifier_handle",
      payload: { count: 5, revocation: true, verifier_kind: "deterministic_code" },
    });
    const violations = detectRevocationViolations(db, directiveId);
    expect(violations.length).toBe(0);
  });

  test("snapshotWatchedOutputs returns empty array when task has no incoming watches", () => {
    const db = openDb(":memory:");
    const { downstream } = seedDirective(db);
    const observations = snapshotWatchedOutputs(db, downstream);
    expect(observations.length).toBe(0);
  });

  test("monotonic mode picks up task_committed events as visible observations", () => {
    const db = openDb(":memory:");
    const { directiveId, upstream, downstream } = seedDirective(db);
    emitEvent(db, {
      kind: "task_edge_recorded",
      directive_id: directiveId,
      task_id: downstream,
      payload: { from_task: upstream, to_task: downstream, kind: "watches", consistency_mode: "monotonic" },
    });
    emitEvent(db, {
      kind: "task_committed",
      directive_id: directiveId,
      task_id: upstream,
      outcome: "succeeded",
      payload: { final: "done" },
    });
    const observations = snapshotWatchedOutputs(db, downstream);
    expect(observations.some((o) => o.event_kind === "task_committed")).toBe(true);
  });

  test("multiple watch edges combine in the result ordered by upstream_task_id", () => {
    const db = openDb(":memory:");
    const directiveId = newId();
    const upstream1 = newId();
    const upstream2 = newId();
    const downstream = newId();
    for (const t of [upstream1, upstream2, downstream]) {
      emitEvent(db, {
        kind: "task_node_opened",
        directive_id: directiveId,
        task_id: t,
        payload: { goal: t },
      });
    }
    emitEvent(db, {
      kind: "task_edge_recorded",
      directive_id: directiveId,
      task_id: downstream,
      payload: { from_task: upstream1, to_task: downstream, kind: "watches", consistency_mode: "monotonic" },
    });
    emitEvent(db, {
      kind: "task_edge_recorded",
      directive_id: directiveId,
      task_id: downstream,
      payload: { from_task: upstream2, to_task: downstream, kind: "watches", consistency_mode: "monotonic" },
    });
    emitEvent(db, {
      kind: "action_scored",
      directive_id: directiveId,
      task_id: upstream1,
      action_artifact_id: "test_action_handle",
      verifier_artifact_id: "test_verifier_handle",
      payload: { src: "u1", verifier_kind: "deterministic_code" },
    });
    emitEvent(db, {
      kind: "action_scored",
      directive_id: directiveId,
      task_id: upstream2,
      action_artifact_id: "test_action_handle",
      verifier_artifact_id: "test_verifier_handle",
      payload: { src: "u2", verifier_kind: "deterministic_code" },
    });
    const observations = snapshotWatchedOutputs(db, downstream);
    const upstreamIds = observations.map((o) => o.upstream_task_id);
    expect(upstreamIds).toContain(upstream1);
    expect(upstreamIds).toContain(upstream2);
  });
});
