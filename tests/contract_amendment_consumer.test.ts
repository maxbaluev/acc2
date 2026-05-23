// acc2 F11 — contract amendment flywheel consumer tests (2026-05-18,
// contract 2AMJKN0GTX32790173EPYH6YT4). Cites design KCs
// GZ979CTKZS369ASEK9H1R2VHT8, 5RFPKQ90CX4853W8GZWB1CAQ58,
// TYHSDKY7296C320WR27CT85YDW, JN8ND1TFQ11FHD178RNZSHH554,
// 8265T7YM3S103E0DBFM7WP09D4.
//
// Six cases (A-F):
//   A. well-defined proposal → route_to_implementation within one
//      worker tick (falsifying test
//      brain_emitted_contract_routed_through_consumer_within_one_tick).
//   B. null predicate → owner_input_required.
//   C. supersession → closure_obsolete on the prior proposal.
//   D. redundancy via applied_change_committed → closure_complete.
//   E. prompt section inclusion + byte-budget truncation.
//   F. timestamp-aware current-root closure selection: multiple
//      task_closure_audited rows for a reused root id after
//      directive_amended → the helper picks only post-amendment rows.

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { closeDb, openDb } from "../substrate/db";
import { emitEvent } from "../runtime/events";
import { runContractAmendmentConsumer } from "../runtime/contract_amendment_consumer";
import { pendingContractAmendments } from "../substrate/views";
import { evaluatePendingAmendmentBacklogSelection } from "../runtime/pending_amendment_backlog_verifier";
import {
  selectCurrentRootClosureAudit,
  closureResidualsForLineage,
} from "../runtime/closure_audit";

afterAll(() => closeDb());
beforeEach(() => closeDb());

const setTs = (db: ReturnType<typeof openDb>, id: string, ts: Date): void => {
  db.run("UPDATE events SET ts = ? WHERE id = ?", [ts.toISOString(), id]);
};

const NOW = new Date("2026-05-18T12:00:00.000Z");
const ago = (ms: number): Date => new Date(NOW.getTime() - ms);

describe("F11 — contract amendment flywheel consumer", () => {
  test("(A) brain_emitted_contract_routed_through_consumer_within_one_tick", async () => {
    const db = openDb(":memory:");
    const proposal = emitEvent(db, {
      kind: "contract_amendment_proposed",
      substrate_origin: "opencode",
      directive_id: "DIR_A",
      task_id: "T_A",
      payload: {
        target_resource: "repo:acc2/example_module",
        proposed_behavior: {
          target_resource: "repo:acc2/example_module",
          predicate: "closure_complete(example_path)",
          target_files: ["runtime/example.ts"],
          dependencies: [],
          summary: "Implement example_module",
        },
      },
    });
    // Score the proposal with a low verifier residual so the universal
    // implementation gate (residual < 0.3) admits it.
    emitEvent(db, {
      kind: "action_scored",
      substrate_origin: "substrate",
      directive_id: "DIR_A",
      task_id: "T_A",
      context_refs: [proposal.id],
      payload: { residual: 0.1, breakdown: { implementation_readiness: 0.1 }, verifier_kind: "deterministic_code" },
    });
    setTs(db, proposal.id, ago(60_000));

    const summary = await runContractAmendmentConsumer(db);
    expect(summary.scanned).toBeGreaterThanOrEqual(1);
    expect(summary.route_to_implementation_count).toBe(1);
    const verdict = summary.verdicts.find((v) => v.proposal_id === proposal.id);
    expect(verdict?.verdict).toBe("route_to_implementation");
    expect(verdict?.emitted_event_ids.length).toBe(1);

    const opened = db
      .query<{ kind: string; payload: string }, [string]>(
        "SELECT kind, payload FROM events WHERE id = ?",
      )
      .get(verdict!.emitted_event_ids[0]!);
    expect(opened?.kind).toBe("task_node_opened");
    const openedPayload = JSON.parse(opened?.payload ?? "{}") as Record<string, unknown>;
    expect(openedPayload.source_proposal_id).toBe(proposal.id);
    expect(openedPayload.f11_consumer_verdict).toBe(
      `f11_consumer_verdict:route_to_implementation:${proposal.id}`,
    );

    // Idempotency: a second tick must NOT emit another task_node_opened.
    const second = await runContractAmendmentConsumer(db);
    expect(second.route_to_implementation_count).toBe(0);
    expect(second.noop_count).toBeGreaterThanOrEqual(1);
  });

  test("(B) proposal without verifier residual is unscored, not missing repo clarification", async () => {
    const db = openDb(":memory:");
    const proposal = emitEvent(db, {
      kind: "contract_amendment_proposed",
      substrate_origin: "opencode",
      directive_id: "DIR_B",
      task_id: "T_B",
      payload: {
        target_resource: "owner_policy:language",
        proposed_behavior: {
          target_resource: "owner_policy:language",
          summary: "Prefer owner language policy evidence over repo field completeness.",
        },
      },
    });
    setTs(db, proposal.id, ago(60_000));

    const summary = await runContractAmendmentConsumer(db);
    expect(summary.route_to_clarification_count).toBe(0);
    const verdict = summary.verdicts.find((v) => v.proposal_id === proposal.id);
    expect(verdict?.verdict).toBe("noop_unscored");
    expect(verdict?.emitted_event_ids.length).toBe(0);
  });

  test("(B2) low verifier residual routes to implementation without predicate or target_files", async () => {
    const db = openDb(":memory:");
    const proposal = emitEvent(db, {
      kind: "contract_amendment_proposed",
      substrate_origin: "opencode",
      directive_id: "DIR_B2",
      task_id: "T_B2",
      payload: {
        target_resource: "calendar:weekly_review",
        proposed_behavior: { target_resource: "calendar:weekly_review", summary: "Add weekly review ritual." },
      },
    });
    emitEvent(db, {
      kind: "action_scored",
      substrate_origin: "substrate",
      directive_id: "DIR_B2",
      task_id: "T_B2",
      context_refs: [proposal.id],
      payload: { residual: 0.12, breakdown: { implementation_readiness: 0.12 }, verifier_kind: "deterministic_code" },
    });
    setTs(db, proposal.id, ago(60_000));

    const summary = await runContractAmendmentConsumer(db);
    const verdict = summary.verdicts.find((v) => v.proposal_id === proposal.id);
    expect(verdict?.verdict).toBe("route_to_implementation");
  });

  test("(C) supersession emits closure_obsolete on prior proposal", async () => {
    const db = openDb(":memory:");
    const older = emitEvent(db, {
      kind: "contract_amendment_proposed",
      substrate_origin: "opencode",
      directive_id: "DIR_C",
      task_id: "T_OLD",
      payload: {
        target_resource: "repo:acc2/superseded_target",
        proposed_behavior: {
          target_resource: "repo:acc2/superseded_target",
          predicate: "closure_complete(old)",
          target_files: ["runtime/old.ts"],
        },
      },
    });
    setTs(db, older.id, ago(3_600_000));
    const newer = emitEvent(db, {
      kind: "contract_amendment_proposed",
      substrate_origin: "opencode",
      directive_id: "DIR_C",
      task_id: "T_NEW",
      payload: {
        target_resource: "repo:acc2/superseded_target",
        proposed_behavior: {
          target_resource: "repo:acc2/superseded_target",
          predicate: "closure_complete(new)",
          target_files: ["runtime/new.ts"],
        },
      },
    });
    // Score the newer proposal so it routes to implementation under the
    // residual-gated universal triage.
    emitEvent(db, {
      kind: "action_scored",
      substrate_origin: "substrate",
      directive_id: "DIR_C",
      task_id: "T_NEW",
      context_refs: [newer.id],
      payload: { residual: 0.1, breakdown: { implementation_readiness: 0.1 }, verifier_kind: "deterministic_code" },
    });
    setTs(db, newer.id, ago(60_000));

    const summary = await runContractAmendmentConsumer(db);
    expect(summary.closure_obsolete_count).toBe(1);
    const verdictOld = summary.verdicts.find((v) => v.proposal_id === older.id);
    expect(verdictOld?.verdict).toBe("closure_obsolete_supersession");
    expect(verdictOld?.emitted_event_ids.length).toBe(1);

    // The newer proposal should ALSO appear and route to implementation
    // (predicate + target_files present, no supersession upstream).
    const verdictNew = summary.verdicts.find((v) => v.proposal_id === newer.id);
    expect(verdictNew?.verdict).toBe("route_to_implementation");

    // Verify the obsolete emit carries the right payload.
    const obsolete = db
      .query<{ kind: string; payload: string }, [string]>(
        "SELECT kind, payload FROM events WHERE id = ?",
      )
      .get(verdictOld!.emitted_event_ids[0]!);
    expect(obsolete?.kind).toBe("closure_obsolete");
    const payload = JSON.parse(obsolete?.payload ?? "{}") as Record<string, unknown>;
    expect(payload.superseded_by).toBe(newer.id);
    expect(payload.source_event_id).toBe(older.id);

    // Re-running must NOT double-emit.
    const second = await runContractAmendmentConsumer(db);
    expect(second.closure_obsolete_count).toBe(0);
  });

  test("(D) redundancy via applied_change_committed → closure_complete", async () => {
    const db = openDb(":memory:");
    // Proposal A (the one we're testing): emitted first.
    const propA = emitEvent(db, {
      kind: "contract_amendment_proposed",
      substrate_origin: "opencode",
      directive_id: "DIR_D",
      task_id: "T_D_A",
      payload: {
        target_resource: "repo:acc2/redundant_target",
        proposed_behavior: {
          target_resource: "repo:acc2/redundant_target",
          predicate: "closure_complete(target)",
          target_files: ["runtime/target.ts"],
        },
      },
    });
    setTs(db, propA.id, ago(7_200_000));

    // Proposal B: a DIFFERENT amendment that shipped first via apply.
    const propB = emitEvent(db, {
      kind: "contract_amendment_proposed",
      substrate_origin: "opencode",
      directive_id: "DIR_D",
      task_id: "T_D_B",
      payload: {
        target_resource: "repo:acc2/other_target",
        proposed_behavior: {
          target_resource: "repo:acc2/other_target",
          predicate: "closure_complete(other)",
          target_files: ["runtime/other.ts"],
        },
      },
    });
    setTs(db, propB.id, ago(3_600_000));

    // applied_change_committed shipped after propA, cites propB, but
    // its target_resource matches propA. That's the redundancy signal.
    const applied = emitEvent(db, {
      kind: "applied_change_committed",
      substrate_origin: "claude",
      directive_id: "DIR_D",
      task_id: "T_D_B",
      context_refs: [propB.id],
      payload: {
        source_event_id: propB.id,
        target_resource: "repo:acc2/redundant_target",
        status: "applied",
      },
    });
    setTs(db, applied.id, ago(60_000));

    const summary = await runContractAmendmentConsumer(db);
    const verdict = summary.verdicts.find((v) => v.proposal_id === propA.id);
    expect(verdict?.verdict).toBe("closure_complete_redundancy");

    const ev = db
      .query<{ kind: string; payload: string }, [string]>(
        "SELECT kind, payload FROM events WHERE id = ?",
      )
      .get(verdict!.emitted_event_ids[0]!);
    expect(ev?.kind).toBe("closure_complete");
    const payload = JSON.parse(ev?.payload ?? "{}") as Record<string, unknown>;
    expect(payload.resolving_event_id).toBe(applied.id);
    expect(payload.source_event_id).toBe(propA.id);
  });

  test("(D2) pending_contract_amendments_view exposes deterministic triage metadata", () => {
    const db = openDb(":memory:");
    const dependency = emitEvent(db, {
      kind: "contract_amendment_proposed",
      substrate_origin: "opencode",
      directive_id: "DIR_D2",
      task_id: "T_D2_DEP",
      payload: {
        target_resource: "repo:acc2/dependency",
        proposed_behavior: {
          target_resource: "repo:acc2/dependency",
          predicate: "closure_complete(dep)",
          target_files: ["runtime/dep.ts"],
        },
      },
    });
    // Score dependency so it shows as ready_for_implementation under the
    // residual-based universal triage gate.
    emitEvent(db, {
      kind: "action_scored",
      substrate_origin: "substrate",
      directive_id: "DIR_D2",
      task_id: "T_D2_DEP",
      context_refs: [dependency.id],
      payload: { residual: 0.1, verifier_kind: "deterministic_code" },
    });
    setTs(db, dependency.id, ago(4_000_000));

    const blocked = emitEvent(db, {
      kind: "contract_amendment_proposed",
      substrate_origin: "opencode",
      directive_id: "DIR_D2",
      task_id: "T_D2_BLOCKED",
      payload: {
        target_resource: "repo:acc2/blocked",
        proposed_behavior: {
          target_resource: "repo:acc2/blocked",
          predicate: "closure_complete(blocked)",
          target_files: ["runtime/blocked.ts"],
          dependencies: [dependency.id],
        },
      },
    });
    setTs(db, blocked.id, ago(3_000_000));

    const unscored = emitEvent(db, {
      kind: "contract_amendment_proposed",
      substrate_origin: "opencode",
      directive_id: "DIR_D2",
      task_id: "T_D2_UNSCORED",
      payload: {
        target_resource: "repo:acc2/unscored",
        proposed_behavior: { target_resource: "repo:acc2/unscored" },
      },
    });
    setTs(db, unscored.id, ago(2_000_000));

    const ready = emitEvent(db, {
      kind: "contract_amendment_proposed",
      substrate_origin: "opencode",
      directive_id: "DIR_D2",
      task_id: "T_D2_READY",
      payload: {
        target_resource: "repo:acc2/ready",
        proposed_behavior: {
          target_resource: "repo:acc2/ready",
          predicate: "closure_complete(ready)",
          target_files: ["runtime/ready.ts"],
          dependencies: [],
        },
      },
    });
    emitEvent(db, {
      kind: "action_scored",
      substrate_origin: "substrate",
      directive_id: "DIR_D2",
      task_id: "T_D2_READY",
      context_refs: [ready.id],
      payload: { residual: 0.1, verifier_kind: "deterministic_code" },
    });
    setTs(db, ready.id, ago(1_000_000));

    const rows = pendingContractAmendments(db, { directiveId: "DIR_D2" });
    expect(rows[0]?.proposal_id).toBe(dependency.id);
    expect(rows[0]?.triage_state).toBe("ready_for_implementation");
    expect(rows[0]?.selection_rank).toBe(1);
    expect(rows.find((r) => r.proposal_id === blocked.id)?.triage_state).toBe("blocked_by_dependencies");
    expect(rows.find((r) => r.proposal_id === blocked.id)?.open_dependency_count).toBe(1);
    // Under the universal residual gate, a proposal with no action_scored
    // residual is `unscored` (not `needs_clarification`); missing_fields is
    // always `[]` because predicate/target_files completeness is no longer
    // an owner-clarification signal.
    expect(rows.find((r) => r.proposal_id === unscored.id)?.triage_state).toBe("unscored");
    expect(rows.find((r) => r.proposal_id === unscored.id)?.missing_fields).toEqual([]);

    const verified = evaluatePendingAmendmentBacklogSelection({ rows, selected_proposal_id: rows[0]!.proposal_id });
    expect(verified.residual).toBe(0);
    expect(verified.eligible_for_f16_f18_implementation).toBe(true);
    expect(verified.expected_top_proposal_id).toBe(rows[0]!.proposal_id);

    const wrong = evaluatePendingAmendmentBacklogSelection({ rows, selected_proposal_id: blocked.id });
    expect(wrong.breakdown.selected_top_match).toBe(1);
    expect(wrong.residual).toBeGreaterThanOrEqual(0.3);
  });

  test("(E) prompt_composer outstanding_contract_amendments section honours row cap and byte budget", async () => {
    const db = openDb(":memory:");
    // Emit > row cap (10) proposals so we exercise truncation.
    const ids: string[] = [];
    for (let i = 0; i < 15; i++) {
      const proposal = emitEvent(db, {
        kind: "contract_amendment_proposed",
        substrate_origin: "opencode",
        directive_id: "DIR_E",
        task_id: `T_E_${i}`,
        payload: {
          target_resource: `repo:acc2/example_${i}_with_padding_to_blow_byte_budget_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`,
          proposed_behavior: {
            target_resource: `repo:acc2/example_${i}`,
            predicate: `closure_complete(slot_${i})_padding_to_blow_byte_budget_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`,
            target_files: [`runtime/example_${i}.ts`],
          },
        },
      });
      // Stagger timestamps so newer-first sorting is deterministic.
      setTs(db, proposal.id, new Date(NOW.getTime() - (15 - i) * 60_000));
      ids.push(proposal.id);
    }

    const rows = pendingContractAmendments(db);
    expect(rows.length).toBe(15);

    // Use the prompt_composer hook from the reloadable registry —
    // composePrompt itself requires a task_node_opened, so we directly
    // exercise the section builder via the exported helpers (the
    // composer test suite covers composePrompt end-to-end).
    const { composePrompt } = await import("../runtime/prompt_composer");
    // The composer needs a task — emit a minimal directive + root task
    // so it can find the goal text.
    const directive = emitEvent(db, {
      kind: "directive_opened",
      substrate_origin: "owner",
      directive_id: "DIR_E",
      payload: { directive_text: "test directive" },
    });
    const task = emitEvent(db, {
      kind: "task_node_opened",
      substrate_origin: "opencode",
      directive_id: "DIR_E",
      task_id: "ROOT_E",
      payload: { goal: "test goal" },
    });
    void directive;
    void task;

    const composed = await composePrompt(db, { taskId: "ROOT_E", budgetTokens: 50_000 });
    const section = composed.sections.find((s) => s.name === "outstanding_contract_amendments");
    expect(section).toBeDefined();
    expect(composed.text).toContain("OUTSTANDING CONTRACT AMENDMENTS:");
    // Row cap = 10 (plus header + maybe truncation line).
    const lineCount = (composed.text.match(/^ {2}\[[A-Za-z0-9]+\]/gm) ?? []).length;
    expect(lineCount).toBeLessThanOrEqual(10);
    // Byte budget: section body must be ≤ ~2000 chars + headroom for
    // header.
    const sectionText = composed.text.split("OUTSTANDING CONTRACT AMENDMENTS:")[1] ?? "";
    const sectionHead = sectionText.split("\n\n")[0] ?? sectionText;
    expect(sectionHead.length).toBeLessThanOrEqual(2200);
  });

  test("(F) timestamp-aware current-root closure selection", () => {
    const db = openDb(":memory:");
    const directiveId = "DIR_F";
    const rootTaskId = "ROOT_F";

    // Old closure audit BEFORE directive_amended (stale evidence).
    const stale = emitEvent(db, {
      kind: "task_closure_audited",
      substrate_origin: "opencode",
      directive_id: directiveId,
      task_id: rootTaskId,
      payload: { closure_residual: 0.02 },
    });
    setTs(db, stale.id, ago(3 * 24 * 3_600_000));

    // directive_amended — supersession point.
    const amended = emitEvent(db, {
      kind: "directive_amended",
      substrate_origin: "opencode",
      directive_id: directiveId,
      payload: { summary: "amend with new requirements" },
    });
    setTs(db, amended.id, ago(2 * 24 * 3_600_000));

    // Fresh closure audit AFTER the amendment, same task_id — this is
    // the row the helper must pick.
    const fresh = emitEvent(db, {
      kind: "task_closure_audited",
      substrate_origin: "opencode",
      directive_id: directiveId,
      task_id: rootTaskId,
      payload: { closure_residual: 0.45 },
    });
    setTs(db, fresh.id, ago(60_000));

    const sel = selectCurrentRootClosureAudit(db, directiveId, rootTaskId);
    expect(sel).not.toBeNull();
    expect(sel?.closure_audit_event_id).toBe(fresh.id);
    expect(sel?.closure_residual).toBe(0.45);
    // The stale row MUST NOT be selected even though it has the lower
    // residual a naive ASC-ordered selector might prefer.
    expect(sel?.closure_audit_event_id).not.toBe(stale.id);

    // closureResidualsForLineage must also filter out stale residuals.
    const lineage = new Set<string>([rootTaskId]);
    const residuals = closureResidualsForLineage(db, directiveId, lineage);
    expect(residuals).toEqual([0.45]);
  });
});
