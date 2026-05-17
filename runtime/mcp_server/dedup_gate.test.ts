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

describe("handleEmit — knowledge_candidate emit-time dedup gate (δ-mem follow-up)", () => {
  // The dedup gate is bypassed in test mode (NODE_ENV=test ||
  // ACC2_BRIDGE_MODE=mock) so existing fixtures emitting similar
  // candidates remain green. To exercise the PRODUCTION refusal shape
  // we temporarily clear both markers, mirroring the pattern in
  // runtime/events.test.ts terminal-conflict tests.
  const withProductionMode = (fn: () => void): void => {
    const prevBridge = process.env.ACC2_BRIDGE_MODE;
    const prevNode = process.env.NODE_ENV;
    delete process.env.ACC2_BRIDGE_MODE;
    delete process.env.NODE_ENV;
    try { fn(); } finally {
      if (prevBridge !== undefined) process.env.ACC2_BRIDGE_MODE = prevBridge;
      if (prevNode !== undefined) process.env.NODE_ENV = prevNode;
    }
  };

  test("test-mode bypass: duplicate claims pass through as two distinct events", () => {
    const db = openDb(":memory:");
    const dir = "dir_dedup_testmode_bypass";
    const claim = "Brain self-audit shows promotion_rate near zero over 24 hours";
    const a = handleEmit(ctx(db), {
      kind: "knowledge_candidate",
      directive_id: dir,
      task_id: "t1",
      substrate_origin: "opencode",
      payload: { claim },
    } as never);
    const b = handleEmit(ctx(db), {
      kind: "knowledge_candidate",
      directive_id: dir,
      task_id: "t1",
      substrate_origin: "opencode",
      payload: { claim },
    } as never);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    const idA = (a.result as Record<string, unknown>).id;
    const idB = (b.result as Record<string, unknown>).id;
    expect(idA).not.toBe(idB);
  });

  test("production mode: duplicate knowledge_candidate refused — returns existing event_id and emits knowledge_candidate_redundant", () => {
    const db = openDb(":memory:");
    const dir = "dir_dedup_production_refused";
    const claim = "Brain self-audit shows promotion_rate near zero over 24 hours";
    // First emit goes through in test mode (no prior to match against).
    const first = handleEmit(ctx(db), {
      kind: "knowledge_candidate",
      directive_id: dir,
      task_id: "t1",
      substrate_origin: "opencode",
      payload: { claim },
    } as never);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const firstId = (first.result as Record<string, unknown>).id as string;
    // Second emit under production mode: gate fires, returns first's id.
    withProductionMode(() => {
      const second = handleEmit(ctx(db), {
        kind: "knowledge_candidate",
        directive_id: dir,
        task_id: "t1",
        substrate_origin: "opencode",
        payload: { claim },
      } as never);
      expect(second.ok).toBe(true);
      if (!second.ok) return;
      const r = second.result as Record<string, unknown>;
      expect(r.id).toBe(firstId);
      expect(r.redundant).toBe(true);
      expect(typeof r.similarity).toBe("number");
      expect(r.similarity as number).toBeGreaterThanOrEqual(0.85);
      // Audit row landed.
      const audit = db
        .query("SELECT COUNT(*) AS c FROM events WHERE kind = 'knowledge_candidate_redundant' AND directive_id = ?")
        .get(dir) as { c: number };
      expect(audit.c).toBe(1);
    });
  });

  test("production mode: DISTINCT claim under same directive passes through unaffected", () => {
    const db = openDb(":memory:");
    const dir = "dir_dedup_distinct_pass";
    const first = handleEmit(ctx(db), {
      kind: "knowledge_candidate",
      directive_id: dir,
      task_id: "t1",
      substrate_origin: "opencode",
      payload: { claim: "Bridge handshake watchdog timeout is too short for cold starts" },
    } as never);
    expect(first.ok).toBe(true);
    withProductionMode(() => {
      const second = handleEmit(ctx(db), {
        kind: "knowledge_candidate",
        directive_id: dir,
        task_id: "t1",
        substrate_origin: "opencode",
        payload: { claim: "Owner profile autonomy floor defaults to 0.4 in fresh substrates" },
      } as never);
      expect(second.ok).toBe(true);
      if (!second.ok) return;
      const r = second.result as Record<string, unknown>;
      expect(r.redundant).toBeUndefined();
      const audit = db
        .query("SELECT COUNT(*) AS c FROM events WHERE kind = 'knowledge_candidate_redundant'")
        .get() as { c: number };
      expect(audit.c).toBe(0);
    });
  });

  test("production mode: cross-author candidates with same claim BOTH stand (substrate_origin scope)", () => {
    const db = openDb(":memory:");
    const dir = "dir_dedup_cross_author";
    const claim = "Brain self-audit shows promotion_rate near zero over 24 hours";
    const brain = handleEmit(ctx(db), {
      kind: "knowledge_candidate",
      directive_id: dir,
      task_id: "t1",
      substrate_origin: "opencode",
      payload: { claim },
    } as never);
    expect(brain.ok).toBe(true);
    withProductionMode(() => {
      const claude = handleEmit(ctx(db), {
        kind: "knowledge_candidate",
        directive_id: dir,
        task_id: "t1",
        substrate_origin: "claude",
        payload: { claim },
      } as never);
      expect(claude.ok).toBe(true);
      if (!claude.ok) return;
      const r = claude.result as Record<string, unknown>;
      expect(r.redundant).toBeUndefined();
      const idB = r.id;
      if (!brain.ok) return;
      const idA = (brain.result as Record<string, unknown>).id;
      expect(idA).not.toBe(idB);
    });
  });
});
