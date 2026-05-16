import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { closeDb, openDb } from "../../substrate/db";
import { handleOpenDirective, handleEmit } from "./substrate_tools";
import type { McpContext } from "./types";

afterAll(() => closeDb());
beforeEach(() => closeDb());

const ctx = (db: ReturnType<typeof openDb>): McpContext => ({ db, invoker: "claude_root" } as McpContext);

describe("handleOpenDirective — prompt-template-leak gate", () => {
  test("refuses directive_text starting with TASK GOAL:", () => {
    const db = openDb(":memory:");
    const r = handleOpenDirective(ctx(db), { directive_text: "TASK GOAL: Install rolling governance..." } as never);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("prompt_template_leak_refused");
  });

  test("refuses recursive doubled TASK GOAL pattern", () => {
    const db = openDb(":memory:");
    const r = handleOpenDirective(ctx(db), { directive_text: "TASK GOAL: TASK GOAL: blah" } as never);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("recursive_task_goal_doubled");
  });

  test("refuses prompt-composer-marker laden text", () => {
    const db = openDb(":memory:");
    const text = "Do the thing. DIRECTIVE ID: ABC RUNTIMES AVAILABLE: bun/uv/camofox YOUR WORKFLOW: 1.write 2.score";
    const r = handleOpenDirective(ctx(db), { directive_text: text } as never);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("prompt_composer_markers");
  });

  test("accepts genuine owner directive text", () => {
    const db = openDb(":memory:");
    const r = handleOpenDirective(ctx(db), {
      directive_text: "Count files in /tmp containing TODO",
    } as never);
    expect(r.ok).toBe(true);
  });
});

describe("handleOpenDirective — idempotent directive-text dedup", () => {
  test("second open with identical text returns the first directive's id", () => {
    const db = openDb(":memory:");
    const first = handleOpenDirective(ctx(db), { directive_text: "Count TODOs in /tmp" } as never);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const firstId = (first.result as Record<string, unknown>).directive_id as string;

    const second = handleOpenDirective(ctx(db), { directive_text: "Count TODOs in /tmp" } as never);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    const secondResult = second.result as Record<string, unknown>;
    expect(secondResult.directive_id).toBe(firstId);
    expect(secondResult.deduped).toBe(true);
  });

  test("dedup ignores already-closed directives — new open with same text gets a fresh id", () => {
    const db = openDb(":memory:");
    const first = handleOpenDirective(ctx(db), { directive_text: "Closed work" } as never);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const firstId = (first.result as Record<string, unknown>).directive_id as string;

    // Close the directive
    handleEmit(ctx(db), {
      kind: "directive_closed",
      directive_id: firstId,
      payload: { reason: "test_close" },
    } as never);

    const second = handleOpenDirective(ctx(db), { directive_text: "Closed work" } as never);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    const secondId = (second.result as Record<string, unknown>).directive_id as string;
    expect(secondId).not.toBe(firstId);
  });
});

describe("handleEmit — task_node_opened (directive_id, goal) dedup", () => {
  test("second task_node_opened with same (directive_id, goal) returns the first task_id", () => {
    const db = openDb(":memory:");
    // Open a directive to host the task
    const opened = handleOpenDirective(ctx(db), { directive_text: "host directive" } as never);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const directiveId = (opened.result as Record<string, unknown>).directive_id as string;

    const t1 = handleEmit(ctx(db), {
      kind: "task_node_opened",
      directive_id: directiveId,
      task_id: "t_first",
      payload: { goal: "do the thing" },
    } as never);
    expect(t1.ok).toBe(true);

    const t2 = handleEmit(ctx(db), {
      kind: "task_node_opened",
      directive_id: directiveId,
      task_id: "t_second",
      payload: { goal: "do the thing" },
    } as never);
    expect(t2.ok).toBe(true);
    if (!t2.ok) return;
    const r2 = t2.result as Record<string, unknown>;
    expect(r2.id).toBe("t_first");
    expect(r2.deduped).toBe(true);
  });

  test("different goals under the same directive open separate tasks", () => {
    const db = openDb(":memory:");
    const opened = handleOpenDirective(ctx(db), { directive_text: "two-task directive" } as never);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const directiveId = (opened.result as Record<string, unknown>).directive_id as string;

    const t1 = handleEmit(ctx(db), {
      kind: "task_node_opened",
      directive_id: directiveId,
      task_id: "t_alpha",
      payload: { goal: "first goal" },
    } as never);
    const t2 = handleEmit(ctx(db), {
      kind: "task_node_opened",
      directive_id: directiveId,
      task_id: "t_beta",
      payload: { goal: "second goal" },
    } as never);
    expect(t1.ok).toBe(true);
    expect(t2.ok).toBe(true);
    if (!t1.ok || !t2.ok) return;
    const r2 = t2.result as Record<string, unknown>;
    expect(r2.deduped).toBeUndefined();
  });
});

describe("handleEmit — task_edge_recorded structural self-loop refusal", () => {
  test("refuses task_edge_recorded with from_task == to_task", () => {
    const db = openDb(":memory:");
    const opened = handleOpenDirective(ctx(db), { directive_text: "self-loop refusal directive" } as never);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const directiveId = (opened.result as Record<string, unknown>).directive_id as string;

    // Open the node we will try to self-loop on so that the endpoint-existence
    // gate would otherwise pass — we want to prove the self-loop gate fires
    // FIRST (before the from_exists / to_exists lookups).
    const node = handleEmit(ctx(db), {
      kind: "task_node_opened",
      directive_id: directiveId,
      task_id: "t_root",
      payload: { goal: "root goal" },
    } as never);
    expect(node.ok).toBe(true);

    const selfLoop = handleEmit(ctx(db), {
      kind: "task_edge_recorded",
      directive_id: directiveId,
      payload: { from_task: "t_root", to_task: "t_root", kind: "refines" },
    } as never);
    expect(selfLoop.ok).toBe(false);
    if (selfLoop.ok) return;
    expect(selfLoop.error).toBe("task_edge_self_loop:t_root");
  });

  test("refuses self-loop even when endpoints do not yet exist", () => {
    const db = openDb(":memory:");
    const opened = handleOpenDirective(ctx(db), { directive_text: "early self-loop directive" } as never);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const directiveId = (opened.result as Record<string, unknown>).directive_id as string;

    // No matching task_node_opened on file — the self-loop refusal must
    // still fire (it precedes the endpoint-existence gate by design).
    const selfLoop = handleEmit(ctx(db), {
      kind: "task_edge_recorded",
      directive_id: directiveId,
      payload: { from_task: "t_phantom", to_task: "t_phantom", kind: "refines" },
    } as never);
    expect(selfLoop.ok).toBe(false);
    if (selfLoop.ok) return;
    expect(selfLoop.error).toBe("task_edge_self_loop:t_phantom");
  });

  test("accepts task_edge_recorded between two distinct existing endpoints", () => {
    const db = openDb(":memory:");
    const opened = handleOpenDirective(ctx(db), { directive_text: "valid-edge directive" } as never);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const directiveId = (opened.result as Record<string, unknown>).directive_id as string;

    const parent = handleEmit(ctx(db), {
      kind: "task_node_opened",
      directive_id: directiveId,
      task_id: "t_parent",
      payload: { goal: "parent" },
    } as never);
    expect(parent.ok).toBe(true);
    const child = handleEmit(ctx(db), {
      kind: "task_node_opened",
      directive_id: directiveId,
      task_id: "t_child",
      payload: { goal: "child" },
    } as never);
    expect(child.ok).toBe(true);

    const edge = handleEmit(ctx(db), {
      kind: "task_edge_recorded",
      directive_id: directiveId,
      payload: { from_task: "t_parent", to_task: "t_child", kind: "refines" },
    } as never);
    expect(edge.ok).toBe(true);
  });
});
