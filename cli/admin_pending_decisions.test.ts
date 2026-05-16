import { describe, expect, test } from "bun:test";
import { openDb, closeDb } from "../substrate/db";
import { runViews, lessonImplementerQueue, type LessonImplementerQueueRow } from "../substrate/views";
import { runPendingDecisions, selectPendingDecisions } from "./admin_pending_decisions";

const newId = (): string => "I" + Math.random().toString(36).slice(2, 12).toUpperCase().padEnd(11, "X");

const insertAmendment = (
  db: ReturnType<typeof openDb>,
  fields: {
    target: string;
    anchor: string;
    consent_required: boolean;
    auto_apply_eligible?: boolean;
    diff?: { before: string; after: string };
    ts?: string;
  },
): string => {
  const id = newId();
  const payload = {
    target_resource: `repo:${fields.target}`,
    resource_uri: `repo:${fields.target}`,
    anchor: fields.anchor,
    current_behavior: "old",
    proposed_behavior: "new",
    proposed_action: {
      target_resource: `repo:${fields.target}`,
      resource_uri: `repo:${fields.target}`,
      anchor: fields.anchor,
      diff: {
        kind: "anchored_replace_v1",
        before: fields.diff?.before ?? "old text",
        after: fields.diff?.after ?? "new text",
        occurrence: 1,
      },
    },
    owner_consent_required: fields.consent_required,
    auto_apply_eligible: fields.auto_apply_eligible ?? false,
  };
  db.run(
    `INSERT INTO events (id, ts, directive_id, task_id, loop_id, substrate_origin, kind, payload)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, fields.ts ?? new Date().toISOString(), "d_test", "t_test", "loop_t", "claude_root", "contract_amendment_proposed", JSON.stringify(payload)],
  );
  return id;
};

describe("admin_pending_decisions", () => {
  test("selectPendingDecisions keeps owner-gated unapplied rows and drops the rest", () => {
    const rows: LessonImplementerQueueRow[] = [
      { owner_gate_verdict: "owner_consent_required", apply_status: "pending" } as LessonImplementerQueueRow,
      { owner_gate_verdict: "owner_consent_required", apply_status: "applied" } as LessonImplementerQueueRow,
      { owner_gate_verdict: "owner_consent_required", apply_status: "committed" } as LessonImplementerQueueRow,
      { owner_gate_verdict: "owner_consent_not_required", apply_status: "pending" } as LessonImplementerQueueRow,
      { owner_gate_verdict: "owner_consent_approved", apply_status: "pending" } as LessonImplementerQueueRow,
    ];
    expect(selectPendingDecisions(rows)).toHaveLength(1);
    expect(selectPendingDecisions(rows)[0]!.apply_status).toBe("pending");
  });

  test("end-to-end: substrate row surfaces in human + json output", async () => {
    closeDb(":memory:");
    const db = openDb(":memory:");
    runViews(db);
    insertAmendment(db, {
      target: ".claude/rules/orchestrator-runtime.md",
      anchor: "## Owner-Facing Dispatch Truth",
      consent_required: true,
    });
    insertAmendment(db, {
      target: "src/internal_helper.ts",
      anchor: "internal anchor",
      consent_required: false,
    });

    const queue = lessonImplementerQueue(db);
    const pending = selectPendingDecisions(queue);
    expect(pending.length).toBeGreaterThanOrEqual(1);
    const protectedRow = pending.find((r) => r.target?.includes("orchestrator-runtime"));
    expect(protectedRow).toBeDefined();
    expect(protectedRow?.owner_gate_verdict).toBe("owner_consent_required");

    const lines: string[] = [];
    const errs: string[] = [];
    const code = await runPendingDecisions([], {
      out: (s) => lines.push(s),
      err: (s) => errs.push(s),
      openSubstrate: () => db,
    });
    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("orchestrator-runtime.md");
    expect(lines.join("\n")).toContain("Owner-Facing Dispatch Truth");

    const jsonLines: string[] = [];
    const jsonCode = await runPendingDecisions(["--json"], {
      out: (s) => jsonLines.push(s),
      err: (s) => errs.push(s),
      openSubstrate: () => db,
    });
    expect(jsonCode).toBe(0);
    const parsed = JSON.parse(jsonLines.join("\n")) as Array<{ target: string }>;
    expect(parsed.some((r) => r.target?.includes("orchestrator-runtime"))).toBe(true);
  });

  test("prints the 'none' line when substrate has no owner-gated proposals", async () => {
    closeDb(":memory:");
    const db = openDb(":memory:");
    runViews(db);
    const lines: string[] = [];
    const code = await runPendingDecisions([], {
      out: (s) => lines.push(s),
      err: () => {},
      openSubstrate: () => db,
    });
    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("none");
  });
});
