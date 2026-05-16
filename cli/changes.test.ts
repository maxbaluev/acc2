import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, openDb } from "../substrate/db";
import { buildChangesFeed, renderChangesFeed, runChanges } from "./changes";

let seq = 0;
const ts = (minutesAgo: number): string => new Date(Date.UTC(2026, 4, 16, 12, 0 - minutesAgo, seq++)).toISOString();

const captureStdout = (): { out: string[]; restore: () => void } => {
  const out: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    out.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stdout.write;
  return { out, restore: () => { process.stdout.write = orig; } };
};

const insertEvent = (db: Database, fields: {
  id: string;
  kind: string;
  ts: string;
  directive_id?: string;
  task_id?: string;
  payload?: Record<string, unknown>;
  context_refs?: string[];
  residual?: number | null;
}): void => {
  db.run(
    `INSERT INTO events (id, ts, directive_id, task_id, loop_id, substrate_origin, kind, payload, context_refs, residual)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      fields.id,
      fields.ts,
      fields.directive_id ?? "d_changes",
      fields.task_id ?? "t_changes",
      "loop_changes",
      "test",
      fields.kind,
      JSON.stringify(fields.payload ?? {}),
      JSON.stringify(fields.context_refs ?? []),
      fields.residual ?? null,
    ],
  );
};

describe("acc changes", () => {
  test("builds a chronological actual-change feed with directive/task context", () => {
    const db = openDb(":memory:");
    insertEvent(db, { id: "d_open", kind: "directive_opened", ts: ts(55), payload: { directive_text: "ship observability surfaces" } });
    insertEvent(db, { id: "t_open", kind: "task_node_opened", ts: ts(54), payload: { goal: "implement acc changes" } });
    insertEvent(db, { id: "proposal_1", kind: "contract_amendment_proposed", ts: ts(50), payload: { target_resource: "repo:cli/changes.ts" } });
    insertEvent(db, { id: "proposal_2", kind: "lesson_extracted", ts: ts(49), payload: { target_resource: "repo:cli/context.ts" } });
    insertEvent(db, { id: "old_apply", kind: "applied_change_committed", ts: new Date(Date.UTC(2026, 4, 9)).toISOString(), payload: { status: "applied" } });
    insertEvent(db, {
      id: "effect_1",
      kind: "irreversible_effect_recorded",
      ts: ts(40),
      payload: { description: "sent external webhook" },
    });
    insertEvent(db, {
      id: "apply_1",
      kind: "applied_change_committed",
      ts: ts(30),
      payload: { source_event_id: "proposal_1", status: "applied", target: "repo:cli/changes.ts", commit_sha: "abcdef123456", residual: 0.1, summary: "added changes feed" },
      context_refs: ["proposal_1"],
      residual: 0.1,
    });
    insertEvent(db, {
      id: "apply_context_ref",
      kind: "applied_change_committed",
      ts: ts(25),
      payload: { status: "applied", summary: "context-ref-only source" },
      context_refs: ["proposal_2"],
    });
    insertEvent(db, {
      id: "closure_1",
      kind: "task_closure_audited",
      ts: ts(20),
      payload: { closure_residual: 0.12, summary: "covered CLI and JSON output" },
      residual: 0.12,
    });
    insertEvent(db, {
      id: "directive_closed_1",
      kind: "directive_closed",
      ts: ts(10),
      payload: { reason: "all_tasks_terminal" },
    });

    const feed = buildChangesFeed(db, { window: "24h", now: new Date(Date.UTC(2026, 4, 16, 12, 0, 0)) });
    expect(feed).not.toBeNull();
    expect(feed!.changes.map((c) => c.event_id)).toEqual(["effect_1", "apply_1", "apply_context_ref", "closure_1", "directive_closed_1"]);
    expect(feed!.changes[0]!).toMatchObject({ category: "world_effect", irreversible_effect_count: 1 });
    expect(feed!.changes[1]!).toMatchObject({
      category: "source_change",
      source_event_id: "proposal_1",
      source_kind: "contract_amendment_proposed",
      target: "repo:cli/changes.ts",
      commit_sha: "abcdef123456",
      directive_text: "ship observability surfaces",
      task_goal: "implement acc changes",
    });
    expect(feed!.changes[2]!).toMatchObject({
      category: "source_change",
      source_event_id: "proposal_2",
      source_kind: "lesson_extracted",
      target: "repo:cli/context.ts",
    });
    expect(feed!.changes[3]!).toMatchObject({ category: "closure_audit", closure_residual: 0.12 });
    expect(feed!.changes[4]!).toMatchObject({ category: "directive_closed", summary: 'reason="all_tasks_terminal"' });

    const rendered = renderChangesFeed(feed!);
    expect(rendered).toContain("changes since 24h (5)");
    expect(rendered).toContain("source_change");
    expect(rendered).toContain("target=repo:cli/changes.ts");
    expect(rendered).toContain("closure_residual=0.12");
    expect(rendered).toContain("directive_closed");
  });

  test("runChanges --json emits a machine-readable feed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acc2-changes-"));
    const prevDb = process.env.ACC2_DB_PATH;
    process.env.ACC2_DB_PATH = join(dir, "changes.db");
    try {
      const db = openDb(process.env.ACC2_DB_PATH);
      insertEvent(db, { id: "json_apply", kind: "applied_change_committed", ts: new Date().toISOString(), payload: { status: "applied", target: "repo:cli/changes.ts" } });
      const cap = captureStdout();
      try {
        const code = await runChanges(["24h", "--json"]);
        expect(code).toBe(0);
      } finally {
        cap.restore();
      }
      const parsed = JSON.parse(cap.out.join(""));
      expect(parsed.count).toBe(1);
      expect(parsed.changes[0].event_id).toBe("json_apply");
      expect(parsed.changes[0].target).toBe("repo:cli/changes.ts");
    } finally {
      closeDb();
      rmSync(dir, { recursive: true, force: true });
      if (prevDb === undefined) delete process.env.ACC2_DB_PATH;
      else process.env.ACC2_DB_PATH = prevDb;
    }
  });

  test("invalid windows return null", () => {
    const db = openDb(":memory:");
    expect(buildChangesFeed(db, { window: "soon" })).toBeNull();
  });
});
