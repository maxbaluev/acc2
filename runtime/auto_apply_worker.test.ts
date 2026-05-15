// acc2 auto-apply worker tests — eligibility scan + signal idempotence
// + stage-2 helpers (anchored_replace_v1 parse + mechanical replacement).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { closeDb, openDb } from "../substrate/db";
import { emitEvent } from "./events";
import {
  collectAutoApplyEligible,
  collectStage2Candidates,
  computeReplacement,
  emitAutoApplySignal,
  evaluateOwnerProfileGate,
  extractAnchoredReplaceV1,
  runAutoApplyWorkerTick,
} from "./auto_apply_worker";
import { OWNER_PROFILE_DEFAULTS, type OwnerProfile } from "../substrate/types";

const emitProposal = (
  db: Database,
  opts: { target: string; anchor: string; diff: string; directive?: string },
): string => {
  return emitEvent(db, {
    kind: "contract_amendment_proposed",
    substrate_origin: "opencode",
    directive_id: opts.directive ?? "d_auto_apply_test",
    task_id: "t_auto_apply_test",
    payload: {
      target: opts.target,
      anchor: opts.anchor,
      current_behavior: "old text",
      proposed_behavior: {
        file_path: opts.target,
        anchor: opts.anchor,
        diff: opts.diff,
      },
      evidence_event_ids: [],
    },
  }).id;
};

describe("auto_apply_worker", () => {
  let tmpDir: string;
  let dbPath: string;
  let db: Database;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "acc2-auto-apply-"));
    dbPath = join(tmpDir, "state.db");
    db = openDb(dbPath);
  });

  afterEach(() => {
    closeDb(dbPath);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("collectAutoApplyEligible returns rows whose auto_apply_eligible=1", () => {
    // Eligible: runtime/* target + structured shape + no hazards.
    emitProposal(db, {
      target: "runtime/foo.ts",
      anchor: "section anchor",
      diff: "new replacement text",
    });
    // Ineligible: missing structured shape.
    emitEvent(db, {
      kind: "contract_amendment_proposed",
      substrate_origin: "opencode",
      directive_id: "d_auto_apply_test",
      task_id: "t_auto_apply_test",
      payload: { target: "runtime/bar.ts", anchor: "x", proposed_behavior: "freeform prose" },
    });
    // Ineligible: owner-gated target (CLAUDE.md).
    emitProposal(db, { target: "CLAUDE.md", anchor: "x", diff: "y" });

    const rows = collectAutoApplyEligible(db);
    expect(rows.length).toBe(1);
    expect(rows[0]?.target).toBe("runtime/foo.ts");
    expect(rows[0]?.structured_change).toBe(1);
  });

  test("runAutoApplyWorkerTick signals each eligible row exactly once", () => {
    const id1 = emitProposal(db, {
      target: "runtime/foo.ts",
      anchor: "first anchor",
      diff: "first replacement",
    });
    const id2 = emitProposal(db, {
      target: "cli/bar.ts",
      anchor: "second anchor",
      diff: "second replacement",
    });

    const first = runAutoApplyWorkerTick(db);
    expect(first.signaled.sort()).toEqual([id1, id2].sort());

    // Second tick: nothing left to signal (idempotence via existing
    // auto_apply_signaled events).
    const second = runAutoApplyWorkerTick(db);
    expect(second.signaled).toEqual([]);

    // Verify the signal rows landed.
    const signals = db
      .query("SELECT id, payload FROM events WHERE kind = 'auto_apply_signaled' ORDER BY ts ASC")
      .all() as Array<{ id: string; payload: string }>;
    expect(signals.length).toBe(2);
    const payloads = signals.map((s) => JSON.parse(s.payload) as Record<string, unknown>);
    expect(payloads[0]?.source_event_id).toBe(id1);
    expect(payloads[1]?.source_event_id).toBe(id2);
    expect(payloads[0]?.stage).toBe("stage_1_signal_only");
  });

  test("emitAutoApplySignal payload carries mirror_inline=true for observers", () => {
    emitProposal(db, {
      target: "runtime/foo.ts",
      anchor: "x",
      diff: "y",
    });
    const rows = collectAutoApplyEligible(db);
    expect(rows.length).toBe(1);
    const signalId = emitAutoApplySignal(db, rows[0]!, Date.now());
    expect(signalId).not.toBeNull();
    const row = db
      .query("SELECT payload FROM events WHERE id = ?")
      .get(signalId!) as { payload: string };
    const payload = JSON.parse(row.payload ?? "{}") as Record<string, unknown>;
    expect(payload.mirror_inline).toBe(true);
  });

  test("worker skips rows already signaled in a previous tick", () => {
    const id = emitProposal(db, {
      target: "runtime/foo.ts",
      anchor: "x",
      diff: "y",
    });
    const first = runAutoApplyWorkerTick(db);
    expect(first.signaled).toEqual([id]);

    // Add a SECOND eligible row, then re-tick. Only the new row signals.
    const id2 = emitProposal(db, {
      target: "runtime/baz.ts",
      anchor: "x2",
      diff: "y2",
    });
    const second = runAutoApplyWorkerTick(db);
    expect(second.signaled).toEqual([id2]);
  });

  // ── Stage-2 helpers ──────────────────────────────────────────

  test("extractAnchoredReplaceV1 reads object-form diff with before/after", () => {
    const p = {
      target: "runtime/foo.ts",
      current_behavior: "ignored when diff is object",
      proposed_behavior: {
        file_path: "runtime/foo.ts",
        anchor: "x",
        diff: { kind: "anchored_replace_v1", before: "OLD", after: "NEW" },
      },
    };
    const r = extractAnchoredReplaceV1(p);
    expect(r).toEqual({ filePath: "runtime/foo.ts", before: "OLD", after: "NEW" });
  });

  test("extractAnchoredReplaceV1 reads repo target_resource with object-form diff", () => {
    const p = {
      target_resource: "repo:runtime/foo.ts",
      current_behavior: "ignored when diff is object",
      proposed_behavior: {
        target_resource: "repo:runtime/foo.ts",
        anchor: "x",
        diff: { kind: "anchored_replace_v1", before: "OLD", after: "NEW" },
      },
    };
    const r = extractAnchoredReplaceV1(p);
    expect(r).toEqual({ filePath: "runtime/foo.ts", before: "OLD", after: "NEW" });
  });

  test("extractAnchoredReplaceV1 falls back to current_behavior + string diff", () => {
    const p = {
      target: "runtime/foo.ts",
      current_behavior: "OLD",
      proposed_behavior: {
        file_path: "runtime/foo.ts",
        anchor: "x",
        diff: "NEW",
      },
    };
    const r = extractAnchoredReplaceV1(p);
    expect(r).toEqual({ filePath: "runtime/foo.ts", before: "OLD", after: "NEW" });
  });

  test("extractAnchoredReplaceV1 rejects shapes missing required fields", () => {
    expect(extractAnchoredReplaceV1({ proposed_behavior: "freeform prose" })).toBeNull();
    expect(extractAnchoredReplaceV1({ proposed_behavior: { file_path: "x" } })).toBeNull();
    expect(extractAnchoredReplaceV1({ proposed_behavior: { file_path: "x", diff: { before: "" } } })).toBeNull();
  });

  test("computeReplacement applies a unique replacement and returns updated content", () => {
    const target = "test_target.ts";
    writeFileSync(join(tmpDir, target), "alpha BEFORE omega\n");
    const r = computeReplacement(target, "BEFORE", "AFTER", tmpDir);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.updated).toBe("alpha AFTER omega\n");
  });

  test("computeReplacement refuses ambiguous matches", () => {
    const target = "test_ambig.ts";
    writeFileSync(join(tmpDir, target), "BEFORE\nthen BEFORE again\n");
    const r = computeReplacement(target, "BEFORE", "AFTER", tmpDir);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("before_text_ambiguous");
  });

  test("computeReplacement refuses missing target file", () => {
    const r = computeReplacement("does/not/exist.ts", "x", "y", tmpDir);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("target_file_not_found");
  });

  test("computeReplacement refuses when before text is not present", () => {
    const target = "test_missing.ts";
    writeFileSync(join(tmpDir, target), "completely different content\n");
    const r = computeReplacement(target, "BEFORE", "AFTER", tmpDir);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("before_text_not_found");
  });

  test("collectStage2Candidates returns signaled-but-not-applied rows", () => {
    const id1 = emitProposal(db, {
      target: "runtime/a.ts",
      anchor: "anchor-a",
      diff: "diff-a",
    });
    const id2 = emitProposal(db, {
      target: "runtime/b.ts",
      anchor: "anchor-b",
      diff: "diff-b",
    });
    // Both signaled but not applied.
    runAutoApplyWorkerTick(db);
    const beforeApply = collectStage2Candidates(db);
    expect(beforeApply.length).toBe(2);

    // Mark id1 applied; id2 remains in the candidate pool.
    emitEvent(db, {
      kind: "contract_amendment_applied",
      substrate_origin: "claude_root",
      directive_id: "d_auto_apply_test",
      task_id: "t_auto_apply_test",
      context_refs: [id1],
      payload: { source_event_id: id1, status: "applied", commit_sha: "abcd1234" },
    });
    const afterApply = collectStage2Candidates(db);
    expect(afterApply.length).toBe(1);
    expect(afterApply[0]?.source_event_id).toBe(id2);
  });

  test("runAutoApplyWorkerTick reports stage2_candidates count", () => {
    emitProposal(db, { target: "runtime/c.ts", anchor: "anc", diff: "txt" });
    const first = runAutoApplyWorkerTick(db);
    // After signaling, the row enters the stage-2 candidate pool.
    expect(first.stage2_candidates).toBe(1);
  });

  // ── Layer-2 OwnerProfile gate ─────────────────────────────────────

  test("evaluateOwnerProfileGate refuses target matching things_to_never_do, manual_review_patterns, time_window, and cautious+multi-file shapes; otherwise passes", () => {
    const basePayload: Record<string, unknown> = {
      target: "runtime/foo.ts",
      current_behavior: "OLD",
      proposed_behavior: {
        target_resource: "repo:runtime/foo.ts",
        anchor: "x",
        diff: { kind: "anchored_replace_v1", before: "OLD", after: "NEW" },
      },
    };

    // 1. Defaults pass.
    const passDefaults = evaluateOwnerProfileGate(
      { ...OWNER_PROFILE_DEFAULTS } as OwnerProfile,
      "runtime/foo.ts",
      basePayload,
      Date.UTC(2026, 4, 15, 12, 0, 0), // noon UTC
    );
    expect(passDefaults.gated).toBe(false);

    // 2. things_to_never_do hard-block (substring match).
    const blockNever = evaluateOwnerProfileGate(
      { ...OWNER_PROFILE_DEFAULTS, things_to_never_do: ["runtime/foo"] } as OwnerProfile,
      "runtime/foo.ts",
      basePayload,
      Date.UTC(2026, 4, 15, 12, 0, 0),
    );
    expect(blockNever.gated).toBe(true);
    if (blockNever.gated) {
      expect(blockNever.field).toBe("things_to_never_do");
      expect(blockNever.matched_pattern).toBe("runtime/foo");
    }

    // 3. manual_review_patterns glob match (runtime/*.test.ts).
    const blockReview = evaluateOwnerProfileGate(
      { ...OWNER_PROFILE_DEFAULTS, manual_review_patterns: ["runtime/*.test.ts"] } as OwnerProfile,
      "runtime/auto_apply_worker.test.ts",
      basePayload,
      Date.UTC(2026, 4, 15, 12, 0, 0),
    );
    expect(blockReview.gated).toBe(true);
    if (blockReview.gated) {
      expect(blockReview.field).toBe("manual_review_patterns");
      expect(blockReview.matched_pattern).toBe("runtime/*.test.ts");
    }

    // 4. time_window — current hour outside the window.
    const blockTime = evaluateOwnerProfileGate(
      { ...OWNER_PROFILE_DEFAULTS, time_window: { start_hour: 9, end_hour: 17 } } as OwnerProfile,
      "runtime/foo.ts",
      basePayload,
      Date.UTC(2026, 4, 15, 22, 0, 0), // 22:00 UTC, outside 9-17
    );
    expect(blockTime.gated).toBe(true);
    if (blockTime.gated) expect(blockTime.field).toBe("time_window");

    // 5. Low autonomy_score + multi-file payload — single-file payload
    //    passes (the gate refuses STRICTLY > 1 file). The low-score arm
    //    is a forward-compatible hook; here we assert the OTHER three
    //    gates fire and the score gate passes by default for the
    //    canonical single-file shape.
    const passLowScoreSingle = evaluateOwnerProfileGate(
      { ...OWNER_PROFILE_DEFAULTS, autonomy_score: 0.2 } as OwnerProfile,
      "runtime/foo.ts",
      basePayload,
      Date.UTC(2026, 4, 15, 12, 0, 0),
    );
    expect(passLowScoreSingle.gated).toBe(false);
  });

  test("autonomy_score below multi-file threshold blocks multi-file diff", () => {
    const multiFilePayload = {
      target: "runtime/foo.ts",
      diff: {
        kind: "anchored_replace_v1",
        before: "old1",
        after: "new1",
      },
      // Adjacent affected file inferred by countTouchedFiles is the gate's
      // responsibility — payload-level shape only carries the primary
      // target. The gate's count > 1 path requires a second target_files
      // entry. We construct one explicitly:
      target_files: ["runtime/foo.ts", "runtime/bar.ts"],
    } as Record<string, unknown>;
    const lowScore = evaluateOwnerProfileGate(
      { ...OWNER_PROFILE_DEFAULTS, autonomy_score: 0.2 } as OwnerProfile,
      "runtime/foo.ts",
      multiFilePayload,
      Date.UTC(2026, 4, 15, 12, 0, 0),
    );
    expect(lowScore.gated).toBe(true);
    if (lowScore.gated) {
      expect(lowScore.field).toBe("autonomy_score");
      expect(lowScore.reason).toContain("below_multi_file_threshold");
    }
  });

  test("autonomy_score_floor lifts effective score above threshold", () => {
    const multiFilePayload = {
      target: "runtime/foo.ts",
      target_files: ["runtime/foo.ts", "runtime/bar.ts"],
    } as Record<string, unknown>;
    // Raw 0.1 but floor 0.5 → effective 0.5, multi-file passes.
    const lifted = evaluateOwnerProfileGate(
      { ...OWNER_PROFILE_DEFAULTS, autonomy_score: 0.1, autonomy_score_floor: 0.5 } as OwnerProfile,
      "runtime/foo.ts",
      multiFilePayload,
      Date.UTC(2026, 4, 15, 12, 0, 0),
    );
    expect(lifted.gated).toBe(false);
  });
});
