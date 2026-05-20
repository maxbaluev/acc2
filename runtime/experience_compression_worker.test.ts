import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { closeDb, openDb } from "../substrate/db";
import { runViews } from "../substrate/views";
import { EVENT_KINDS } from "../substrate/event_kinds";
import { newId } from "./ids";
import { experienceCompressionWorkerTick } from "./experience_compression_worker";

const base = Date.parse("2026-05-16T00:00:00.000Z");
const ts = (minutes: number): string => new Date(base + minutes * 60_000).toISOString();

afterAll(() => closeDb());
beforeEach(() => closeDb());

const insertEvent = (
  db: ReturnType<typeof openDb>,
  opts: {
    id?: string;
    ts: string;
    directive_id: string;
    task_id: string;
    parent_task_id?: string | null;
    kind: string;
    payload?: Record<string, unknown>;
    substrate_origin?: string;
    residual?: number | null;
    action_artifact_id?: string | null;
    verifier_artifact_id?: string | null;
    predicted_residual?: number | null;
    context_refs?: string[];
  },
): string => {
  const id = opts.id ?? newId();
  db.run(
    `INSERT INTO events (
       id, ts, directive_id, task_id, parent_task_id, loop_id,
       substrate_origin, kind, payload, context_refs,
       residual, action_artifact_id, verifier_artifact_id, predicted_residual
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      opts.ts,
      opts.directive_id,
      opts.task_id,
      opts.parent_task_id ?? null,
      "loop_root",
      opts.substrate_origin ?? "opencode",
      opts.kind,
      JSON.stringify(opts.payload ?? {}),
      JSON.stringify(opts.context_refs ?? []),
      opts.residual ?? null,
      opts.action_artifact_id ?? null,
      opts.verifier_artifact_id ?? null,
      opts.predicted_residual ?? null,
    ],
  );
  return id;
};

const insertSuccessfulTrajectory = (
  db: ReturnType<typeof openDb>,
  index: number,
  opts?: { goal?: string; residual?: number; closureResidual?: number; omitLesson?: boolean },
): { directiveId: string; taskId: string; scoredId: string } => {
  const directiveId = `d_${index}`;
  const taskId = `t_${index}`;
  const goal = opts?.goal ?? "compress repeated todo-count trajectories";
  insertEvent(db, { ts: ts(index * 10), directive_id: directiveId, task_id: taskId, kind: "task_node_opened", payload: { goal } });
  insertEvent(db, {
    ts: ts(index * 10 + 1),
    directive_id: directiveId,
    task_id: taskId,
    kind: "action_predicted",
    payload: { intent: "count todos" },
    action_artifact_id: "artifact_action",
    verifier_artifact_id: "artifact_verifier",
    predicted_residual: 0.1,
  });
  const scoredId = insertEvent(db, {
    ts: ts(index * 10 + 2),
    directive_id: directiveId,
    task_id: taskId,
    kind: "action_scored",
    payload: { residual: opts?.residual ?? 0.08 },
    residual: opts?.residual ?? 0.08,
  });
  insertEvent(db, {
    ts: ts(index * 10 + 3),
    directive_id: directiveId,
    task_id: taskId,
    kind: "task_closure_audited",
    payload: { closure_residual: opts?.closureResidual ?? 0.12 },
  });
  if (!opts?.omitLesson) {
    insertEvent(db, {
      ts: ts(index * 10 + 4),
      directive_id: directiveId,
      task_id: taskId,
      kind: "lesson_extracted",
      payload: { lesson_kind: "recipe_candidate", summary: "same trajectory worked again" },
    });
  }
  return { directiveId, taskId, scoredId };
};

describe("experienceCompressionWorkerTick", () => {
  test("compresses repeated successful trajectories into recipe-shape knowledge plus knowledge_candidate", async () => {
    const db = openDb(":memory:");
    runViews(db);
    const first = insertSuccessfulTrajectory(db, 1);
    const second = insertSuccessfulTrajectory(db, 2);

    const outcome = await experienceCompressionWorkerTick(db);
    expect(outcome.scanned_scored).toBe(2);
    expect(outcome.eligible_trajectories).toBe(2);
    expect(outcome.recipes_extracted).toBe(1);
    expect(outcome.knowledge_candidates).toBe(1);

    const recipe = db
      .query("SELECT id, payload, context_refs FROM events WHERE kind = 'knowledge_candidate' AND COALESCE(json_extract(payload, '$.recipe_shape.enabled'), 0) IN (1, 'true') LIMIT 1")
      .get() as { id: string; payload: string; context_refs: string } | null;
    expect(recipe).not.toBeNull();
    const payload = JSON.parse(recipe!.payload) as Record<string, unknown>;
    expect(payload.extraction_kind).toBe("experience_compression_loop_v1");
    expect(payload.held_out_task_ids).toEqual([second.taskId]);
    expect(payload.source_action_scored_ids).toEqual([first.scoredId, second.scoredId]);
    expect(Array.isArray(payload.trajectory)).toBe(true);

    // After recipe-family absorption, the worker emits ONE recipe-shape row
    // (the trajectory cache) AND ONE plain knowledge_candidate row (the claim
    // pair). Both are knowledge_candidate; recipe_shape.enabled distinguishes
    // the cache row.
    const knowledgeCount = (db
      .query("SELECT COUNT(*) AS c FROM events WHERE kind = 'knowledge_candidate'")
      .get() as { c: number }).c;
    expect(knowledgeCount).toBe(2);
    const recipeShapeCount = (db
      .query("SELECT COUNT(*) AS c FROM events WHERE kind = 'knowledge_candidate' AND COALESCE(json_extract(payload, '$.recipe_shape.enabled'), 0) IN (1, 'true')")
      .get() as { c: number }).c;
    expect(recipeShapeCount).toBe(1);

    const emittedKinds = (db
      .query(
        `SELECT DISTINCT kind FROM events
         WHERE substrate_origin = 'substrate_auto'
         ORDER BY kind ASC`,
      )
      .all() as Array<{ kind: string }>).map((row) => row.kind);
    expect(emittedKinds).toEqual(["knowledge_candidate"]);
    for (const kind of emittedKinds) expect(kind in EVENT_KINDS).toBe(true);
  });

  test("is idempotent when the current cluster is already covered", async () => {
    const db = openDb(":memory:");
    runViews(db);
    insertSuccessfulTrajectory(db, 1);
    insertSuccessfulTrajectory(db, 2);

    expect((await experienceCompressionWorkerTick(db)).recipes_extracted).toBe(1);
    const second = await experienceCompressionWorkerTick(db);
    expect(second.recipes_extracted).toBe(0);
    expect(second.skipped_existing_compression).toBe(1);

    const recipeCount = (db
      .query("SELECT COUNT(*) AS c FROM events WHERE kind = 'knowledge_candidate' AND COALESCE(json_extract(payload, '$.recipe_shape.enabled'), 0) IN (1, 'true')")
      .get() as { c: number }).c;
    expect(recipeCount).toBe(1);
  });

  test("requires low action residual, low closure residual, and a lesson", async () => {
    const db = openDb(":memory:");
    runViews(db);
    insertSuccessfulTrajectory(db, 1, { residual: 0.4 });
    insertSuccessfulTrajectory(db, 2, { closureResidual: 0.4 });
    insertSuccessfulTrajectory(db, 3, { omitLesson: true });

    const outcome = await experienceCompressionWorkerTick(db);
    expect(outcome.eligible_trajectories).toBe(0);
    expect(outcome.recipes_extracted).toBe(0);
  });

  test("does not compress without a complete repeated eligible cluster", async () => {
    const db = openDb(":memory:");
    runViews(db);

    insertSuccessfulTrajectory(db, 1);
    insertSuccessfulTrajectory(db, 2);

    db.run("DELETE FROM events WHERE kind = 'action_predicted' AND task_id = ?", ["t_1"]);
    db.run("DELETE FROM events WHERE kind = 'task_closure_audited' AND task_id = ?", ["t_2"]);
    insertSuccessfulTrajectory(db, 3, { goal: "unique one-off trajectory" });

    const outcome = await experienceCompressionWorkerTick(db);
    expect(outcome.scanned_scored).toBe(3);
    expect(outcome.eligible_trajectories).toBe(1);
    expect(outcome.clusters_found).toBe(0);
    expect(outcome.recipes_extracted).toBe(0);
    expect(outcome.knowledge_candidates).toBe(0);

    const emitted = db
      .query(
        `SELECT COUNT(*) AS c FROM events
         WHERE substrate_origin = 'substrate_auto'
           AND kind = 'knowledge_candidate' AND COALESCE(json_extract(payload, '$.recipe_shape.enabled'), 0) IN (1, 'true')`,
      )
      .get() as { c: number };
    expect(emitted.c).toBe(0);
  });

  test("emits refused applied_change_committed when a larger compression supersedes an older one", async () => {
    const db = openDb(":memory:");
    runViews(db);
    insertSuccessfulTrajectory(db, 1);
    insertSuccessfulTrajectory(db, 2);
    const first = await experienceCompressionWorkerTick(db);
    expect(first.recipes_extracted).toBe(1);

    insertSuccessfulTrajectory(db, 3);
    const second = await experienceCompressionWorkerTick(db);
    expect(second.recipes_extracted).toBe(1);
    expect(second.superseded_refusals).toBe(1);

    const refused = db
      .query(
        `SELECT payload FROM events
         WHERE kind = 'applied_change_committed'
           AND json_extract(payload, '$.status') = 'refused'
           AND json_extract(payload, '$.reason') = 'compression_supersede'
         LIMIT 1`,
      )
      .get() as { payload: string } | null;
    expect(refused).not.toBeNull();
    const payload = JSON.parse(refused!.payload) as Record<string, unknown>;
    expect(typeof payload.source_event_id).toBe("string");
    expect(typeof payload.superseded_by_recipe_id).toBe("string");
  });

  test("retires stale lessons through applied_change_committed compression_supersede events", async () => {
    const db = openDb(":memory:");
    runViews(db);
    const oldLessonId = insertEvent(db, {
      id: "old_lesson",
      ts: ts(-30 * 24 * 60),
      directive_id: "old_directive",
      task_id: "old_task",
      kind: "lesson_extracted",
      payload: { lesson_kind: "verifier_gap", summary: "stale lesson with no apply history" },
    });
    insertEvent(db, {
      id: "recent_lesson",
      ts: ts(-60),
      directive_id: "recent_directive",
      task_id: "recent_task",
      kind: "lesson_extracted",
      payload: { lesson_kind: "verifier_gap", summary: "recent lesson stays active" },
    });

    const first = await experienceCompressionWorkerTick(db, new Date(base));
    expect(first.lessons_retired).toBe(1);
    const second = await experienceCompressionWorkerTick(db, new Date(base));
    expect(second.lessons_retired).toBe(0);

    const retired = db
      .query(
        `SELECT kind, payload, context_refs FROM events
         WHERE kind = 'applied_change_committed'
           AND json_extract(payload, '$.reason') = 'compression_supersede'
         LIMIT 1`,
      )
      .get() as { kind: string; payload: string; context_refs: string } | null;
    expect(retired).not.toBeNull();
    expect(retired!.kind in EVENT_KINDS).toBe(true);
    const payload = JSON.parse(retired!.payload) as Record<string, unknown>;
    expect(payload).toMatchObject({
      source_event_id: oldLessonId,
      source_kind: "lesson_extracted",
      status: "refused",
      reason: "compression_supersede",
    });
    expect(JSON.parse(retired!.context_refs)).toEqual([oldLessonId]);
  });
});
