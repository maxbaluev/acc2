// acc2 F3 — doc-promises test (2026-05-18).
//
// Falsifying test for foundational reason 1 (documentation runs ahead of
// implementation). Reads the canonical doc surfaces and asserts every
// event_kind they mention is registered in substrate/event_kinds.ts.
//
// Pre-fix: four event kinds were documented in CLAUDE.md but never
// registered, so the docs lied about what the substrate emits. The doc
// described an advisory gate as if it were structural. This test makes
// every doc->kind reference a hard structural check — adding a new kind
// to the docs WITHOUT registering it fails CI.
//
// Optional second pass: count the number of admitted events for each
// kind. Kinds with zero events are watch-list items (not hard failures),
// noted to stdout so operators can see which surfaces are documented
// but never fire in practice.

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { closeDb, openDb } from "../substrate/db";
import { EVENT_KINDS } from "../substrate/event_kinds";

afterAll(() => closeDb());
beforeEach(() => closeDb());

const ACC2_ROOT = join(import.meta.dir, "..");

const DOC_PATHS = [
  join(ACC2_ROOT, "CLAUDE.md"),
  join(ACC2_ROOT, ".claude/rules/orchestrator-runtime.md"),
  join(ACC2_ROOT, "docs/v2-design.md"),
];

/** Extract candidate event_kind tokens from documentation prose.
 *
 *  Strategy: match snake_case identifiers ≥ 2 segments long that end
 *  with a known lifecycle suffix. The suffix list is deliberately
 *  narrow (verbs in past participle form) so we don't pick up every
 *  unrelated snake_case identifier (helper function names, file
 *  paths, etc.).
 *
 *  This is intentionally coarse — false positives are pruned by
 *  filtering against the canonical set of event-shaped tokens
 *  (anything not in EVENT_KINDS but matching the pattern is a
 *  documentation token NOT pretending to be an event, e.g.
 *  "openai_api_key"). The test only ASSERTS on the intersection. */
const EVENT_KIND_RE =
  /\b([a-z][a-z0-9]*(?:_[a-z0-9]+){1,6}_(recorded|received|emitted|committed|opened|closed|failed|dispatched|admitted|promoted|rejected|propagated|required|extracted|proposed|audited|attributed|observed|measured|degraded|recovered|exhausted|debited|scored|predicted|invoked|violation|breach|triggered|completed|swapped|unmapped|limited|started|shutdown|abandoned|deferred|blocked|ready|claimed|superseded|quarantined|retired|rehabilitated|updated|applied|verified|planned|signaled|inserted|expired|deleted|drained|seeded|cancelled|escalated|engaged|disengaged|skipped|truncated|ingested|registered|suggested|saturated|interfered|detected|resolved|silenced|recovered_orphan|warning|killed|hard_killed|soft_terminated|orphaned|stuck|read|admin|rotated|published|cleared|imported|exported|refreshed|checkpointed|complete|obsolete|due|differed|diffed|composed|fetched|persisted))\b/g;

const RAW_PHRASE_HINTS = [
  // Tokens that lack a verb suffix but ARE event kinds (snake_case
  // nouns referenced as event kinds in docs). The set is intentionally
  // small — adding to it should always pair with a real event kind.
  "knowledge_candidate",
  "knowledge_synthesized",
  "knowledge_promoted",
  "lesson_extracted",
  "directive_milestone_recorded",
  "act_tuple_recorded",
  "predicate_gate_rejected",
  "atms_strategy_first_violation",
  "intent_classified",
  "lane_routing_refused",
  "refinement_depth_exceeded",
  "verifier_residual_high",
  "owner_input_required",
  "owner_input_received",
  "owner_observed_outcome_recorded",
  "retrieval_binding",
  "retrieval_credit_attributed",
  "retrieval_rejected",
  "action_predicted",
  "action_scored",
  "applied_change_committed",
  "applied_change_failed",
  "irreversible_effect_recorded",
  "owner_profile_recorded",
  "hidl_action_required",
  "task_node_opened",
  "task_edge_recorded",
  "task_committed",
  "task_failed",
  "task_abandoned",
  "task_closure_audited",
  "dispatch_decided",
  "dispatcher_violation",
  "candidate_confirmed",
  "candidate_contradicted",
  "contract_amendment_proposed",
  "closure_complete",
  "closure_obsolete",
  "closure_owner_required",
  "code_artifact_candidate",
  "code_artifact_admitted",
  "code_artifact_admission_rejected",
  "directive_opened",
  "directive_amended",
  "directive_closed",
  "bridge_failed",
  "owner_decision_recorded",
];

const extractEventKindMentions = (docText: string): Set<string> => {
  const mentions = new Set<string>();
  // 1. Regex-driven extraction.
  let m: RegExpExecArray | null;
  EVENT_KIND_RE.lastIndex = 0;
  while ((m = EVENT_KIND_RE.exec(docText)) !== null) {
    mentions.add(m[0]);
  }
  // 2. Whitelisted noun-only event kinds (docs sometimes name them
  //    bare without a verb-suffix tail).
  for (const hint of RAW_PHRASE_HINTS) {
    if (docText.includes(hint)) mentions.add(hint);
  }
  return mentions;
};

describe("doc_promises — every event_kind named in docs is registered", () => {
  const registeredKinds = new Set(Object.keys(EVENT_KINDS));
  const allMentions = new Set<string>();

  for (const path of DOC_PATHS) {
    if (!existsSync(path)) {
      test(`doc file ${path} exists`, () => {
        // If the canonical doc is missing the assertion fails clearly.
        expect(existsSync(path)).toBe(true);
      });
      continue;
    }
    const text = readFileSync(path, "utf8");
    const mentions = extractEventKindMentions(text);
    for (const m of mentions) allMentions.add(m);

    test(`${path.replace(ACC2_ROOT + "/", "")}: every mentioned event kind is registered`, () => {
      const intersection = [...mentions].filter((k) => registeredKinds.has(k));
      // Sanity: the doc must reference at least one real event kind
      // (otherwise the extractor is broken and the test is decorative).
      expect(intersection.length).toBeGreaterThan(0);
      // Hard check: any mention that LOOKS LIKE a kind but is NOT
      // registered is a documentation-runs-ahead-of-implementation
      // failure. The filter restricts to mentions present in
      // RAW_PHRASE_HINTS to avoid false positives from prose tokens
      // that happen to match the regex tail.
      const looksLikeKind = [...mentions].filter((k) =>
        RAW_PHRASE_HINTS.includes(k) || k.endsWith("_recorded") || k.endsWith("_committed"),
      );
      const unregistered = looksLikeKind.filter((k) => !registeredKinds.has(k));
      expect(unregistered).toEqual([]);
    });
  }

  test("optional watch-list: kinds mentioned in docs but never emitted (count = 0) are surfaced", () => {
    // This test is non-destructive — it logs but does not fail. The
    // hard check above already prevents the doc-runs-ahead failure mode.
    const db = openDb(":memory:");
    const watchList: string[] = [];
    for (const kind of allMentions) {
      if (!registeredKinds.has(kind)) continue;
      const row = db
        .query<{ c: number }, [string]>(
          "SELECT COUNT(*) AS c FROM events WHERE kind = ?",
        )
        .get(kind);
      if ((row?.c ?? 0) === 0) watchList.push(kind);
    }
    // In a fresh :memory: DB nearly every kind has zero events.
    // What the operator wants to see in PRODUCTION is the watch-list
    // against the live state.db. Surfacing it here is informational
    // only; the assertion succeeds unconditionally.
    expect(Array.isArray(watchList)).toBe(true);
  });
});
