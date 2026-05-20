// Registry tests — pin the unification invariants so the four derived
// lists (`EventKind` union, `EMBEDDABLE_KINDS`, `HEALTH_METRIC_KINDS`,
// `MIRROR_INLINE_EVENT_TYPES`) cannot silently drift from
// `EVENT_KINDS` again.

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { closeDb, openDb } from "./db";
import { emitEvent } from "../runtime/events";
import {
  EMBEDDABLE_KINDS,
  EVENT_KINDS,
  HEALTH_METRIC_KINDS,
  MIRROR_INLINE_EVENT_TYPES,
  type EventKind,
} from "./event_kinds";
import { NARRATIVE_KINDS } from "../cli/observe";

afterAll(() => closeDb());
beforeEach(() => closeDb());

// ── helpers ────────────────────────────────────────────────────────

/** Recursively walk a directory and return every .ts file, skipping
 *  __pycache__ / node_modules / .test.ts. Used to grep production
 *  call sites for `kind: "<literal>"` patterns. */
const walkTsFiles = (root: string): string[] => {
  const out: string[] = [];
  const skip = new Set(["node_modules", ".git", "__pycache__", "fixtures"]);
  const walk = (dir: string): void => {
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const name of entries) {
      if (skip.has(name)) continue;
      const p = join(dir, name);
      let s: ReturnType<typeof statSync>;
      try { s = statSync(p); } catch { continue; }
      if (s.isDirectory()) walk(p);
      else if (s.isFile() && p.endsWith(".ts") && !p.endsWith(".test.ts")) {
        out.push(p);
      }
    }
  };
  walk(root);
  return out;
};

/** Test-only event kinds enumerated in docs/substrate-entity-map.md
 *  §"Test-only event kinds" — these live in test fixtures and never
 *  flow through production emitters, so they intentionally stay out of
 *  the registry. */
const TEST_ONLY_KINDS = new Set<string>([
  // (watch_test_* removed 2026-05-16 with the legacy TUI; see cli/watch.ts
  // skeleton header. Add new test-only kinds here as fixtures need them.)
]);

/** Strings that grep matches as `kind: "<value>"` but are NOT event
 *  kinds — `failure_kind` enum members, `target_kind` discriminators,
 *  edge kinds, view row_kind discriminators, lifecycle enum strings,
 *  stakeholder interaction enum members, etc. The canonical list lives
 *  in docs/substrate-entity-map.md §"Sub-payload string-literals".
 *  Keeping this set narrow forces the registry to absorb any actual
 *  new event kind rather than pretending it is a sub-payload value. */
const NON_EVENT_KIND_LITERALS = new Set([
  // task_edge_recorded.payload.kind values
  "requires", "refines", "watches", "blocks", "depletes",
  // FailureKind enum members (substrate/types.ts:34)
  "auth_missing", "rate_limit", "timeout", "parse_error",
  "subprocess_crash", "cycle_1_only_breach", "refinement_depth_exceeded",
  "verification_high_residual", "bridge_killed", "bridge_timeout",
  "artifact_runtime_error", "rolling_directive_archived",
  "directive_interference_cycle", "consecutive_bridge_failures",
  // credit.ts target_kind values
  "knowledge", "code_artifact",
  // View row_kind discriminators
  "node", "extension",
  // Lifecycle / cadence enum strings
  "rolling_active", "rolling_review", "normal_objective",
  "promoted", "demoted",
  // Stakeholder interaction enum
  "mutual_exclusion", "water_damage", "evacuation",
  // Interference-edge kinds (payload values of directive_interference_edge)
  "resource_conflict",
  "none", "unspecified", "yield_template",
  // Compositor task-kind strings
  "stakeholder_consult",
  // Bridge / extractor outcome enums
  "no_action", "mock_bridge_prompt_unrecognized",
  // irreversible_effect payload.kind values (not event kinds themselves)
  "net_outbound", "fs_write",
  // act_artifact / code_artifact registry sub-payload tag (the body of a
  // dispatch-strategy seed declares `kind: 'dispatch_strategy_v1'` as its
  // internal artifact-kind discriminator — NOT an event kind). Per brain
  // design 48SN4XF3WN4KBBCHHCANDRDQRW, strategy identity lives in the
  // artifact-registry payload, not in EVENT_KINDS.
  "dispatch_strategy_v1",
  // C3 (2026-05-18): master_report_generation_orchestrator seed declares
  // `kind: 'recipe'` as its registry-row discriminator (recipe row vs.
  // raw code_artifact). NOT an event kind — recipe content lives in the
  // code_artifact registry, surfaced into prompts via retrieval.
  "recipe",
  // C2 (2026-05-18, contract V32YTK7HKN6MS38KWJY1SKTXAW): render-pipeline
  // artifact kinds (free-string discriminators on code_artifact.kind), NOT
  // event kinds. Per the same act_artifact registry pattern as
  // dispatch_strategy_v1 and recipe above.
  "markdown_body",
  "docx_reference_style",
  "rendered_docx",
  "published_drive_doc",
  // Floor-section enforcement payload discriminator (sub-kind on
  // dispatcher_violation when prompt_composer drops a load-bearing floor
  // section under pathological budget). Not an event kind — the parent
  // event is dispatcher_violation.
  "floor_section_missing",
  // 2026-05-19 (brain 198YWW39K94KH2ZQ1A7XHP2T8R): substrate-primitive
  // act_artifact rows declare open-vocabulary `kind:` discriminators
  // (merger, decider, extractor, promoter, verifier, action, predicate,
  // exit_classifier) on the registry-row payload. NOT event kinds — the
  // primitive's runtime emission is action_predicted / action_scored,
  // and the `kind` field is the registry-row classifier the credit
  // pipeline reads to update the right Beta posterior.
  "merger",
  "decider",
  "extractor",
  "promoter",
  "verifier",
  "action",
  "predicate",
  "exit_classifier",
  // 2026-05-19 (brain dispatch J4HP5SYT3N4GK45S Candidate A): the
  // artifact_kind_backfill_worker infers `browser_action` as a concrete
  // act_artifact.kind discriminator for camofox-browser runtime rows.
  // NOT an event kind — the registry row carries `kind: "browser_action"`,
  // but no production code emits an event with that kind string.
  "browser_action",
  // T2.1 (2026-05-19, F-Universal-Threshold-Registry meta-move #1):
  // runtime/threshold_registry.ts admits act_artifact rows with
  // `kind: 'threshold_predicate'` so every runtime literal threshold
  // becomes a posterior-ranked row. NOT an event kind — the registry
  // row carries this discriminator; emissions still use action_scored /
  // act_artifact_score_updated under the standard machinery.
  "threshold_predicate",
  // Tier-S3 (2026-05-19, brain KC G3PR7X6TCD4T57D7T6GXCDY9AW):
  // runtime/trajectory_motif_extractor.ts admits act_artifact rows with
  // `kind: 'trajectory_motif_predicate'` so frequent multi-event motifs
  // become posterior-ranked rows. NOT an event kind — the registry row
  // carries this discriminator; emissions use trajectory_motif_observed.
  "trajectory_motif_predicate",
  // Tier-S5 (2026-05-19, brain KC G3PR7X6TCD4T57D7T6GXCDY9AW):
  // runtime/goal_shape_predicate_extractor.ts admits act_artifact rows
  // with `kind: 'goal_shape_strategy_predicate'` so each distinct
  // goal_shape tag becomes a posterior-ranked row scored by whether
  // the tag PREDICTS trajectory similarity (low residual variance).
  // NOT an event kind — the registry row carries this discriminator;
  // emissions use goal_shape_strategy_observed.
  "goal_shape_strategy_predicate",
]);

// ── tests ──────────────────────────────────────────────────────────

describe("EVENT_KINDS registry coverage", () => {
  test("every event kind emitted in production code is registered", () => {
    // Walk the three production directories and collect every
    // `kind: "<literal>"` occurrence. Cross-check against the registry.
    const root = join(import.meta.dirname ?? ".", "..");
    const files = [
      ...walkTsFiles(join(root, "substrate")),
      ...walkTsFiles(join(root, "runtime")),
      ...walkTsFiles(join(root, "cli")),
    ];
    const literals = new Set<string>();
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      // Match `kind: "<literal>"` and `kind: '<literal>'` and
      // `kind: \`<literal>\`` — only simple alphanumeric+underscore
      // values (excludes template expressions and dynamic kinds).
      // The negative lookbehind `(?<!\w)` rejects compound field names
      // like `lesson_kind:`, `failure_kind:`, `pattern_kind:`, etc.,
      // whose values are sub-payload enums, not event kinds. Without
      // this guard every FailureKind / lesson_kind value would leak
      // into the literals set and clog NON_EVENT_KIND_LITERALS.
      const re = /(?<!\w)kind:\s*["'`]([a-z_][a-z_0-9]*)["'`]/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) literals.add(m[1]);
    }
    // The grep also catches strings like `"kind: 'recipe-shape knowledge'"`
    // inside SQL queries (which DO carry real event kinds) and false
    // positives like `kind: "fs_write"` (an irreversible_effect payload
    // discriminator) — we filter the false-positive set explicitly via
    // NON_EVENT_KIND_LITERALS so future drift is loud.
    const missingFromRegistry: string[] = [];
    for (const lit of literals) {
      if (NON_EVENT_KIND_LITERALS.has(lit)) continue;
      if (TEST_ONLY_KINDS.has(lit)) continue;
      if (!(lit in EVENT_KINDS)) missingFromRegistry.push(lit);
    }
    expect(missingFromRegistry).toEqual([]);
  });

  test("the missing embedding-skip kind is registered", () => {
    // Per R's audit in docs/substrate-entity-map.md §"Non-union event
    // kinds emitted by live producers" — runtime-emitted kinds belong in
    // the union when the producer still exists.
    expect("embedding_skipped_missing_api_key" in EVENT_KINDS).toBe(true);
    const skipMeta = EVENT_KINDS.embedding_skipped_missing_api_key as
      typeof EVENT_KINDS[keyof typeof EVENT_KINDS];
    expect(skipMeta.producer).toBe("runtime");
  });

  test("emitEvent accepts the intent gate observability kinds", () => {
    const db = openDb(":memory:");
    expect(() =>
      emitEvent(db, {
        kind: "intent_classified",
        substrate_origin: "substrate_auto",
        directive_id: "d_event_kind_intent",
        task_id: "d_event_kind_intent",
        payload: {
          intent_class: "ad_hoc",
          confidence: 0.3,
          evidence: [],
          classifier_version: "test",
          directive_text_hash: "abc",
        },
      }),
    ).not.toThrow();
    expect(() =>
      emitEvent(db, {
        kind: "lane_routing_refused",
        substrate_origin: "substrate_auto",
        directive_id: "d_event_kind_intent",
        payload: {
          reason: "test_seed",
          refused_kind: "atms_report_v_supersedes",
        },
      }),
    ).not.toThrow();
    expect(() =>
      emitEvent(db, {
        kind: "refinement_depth_exceeded",
        substrate_origin: "substrate_auto",
        directive_id: "d_event_kind_intent",
        payload: { depth: 6, cap: 5 },
      }),
    ).not.toThrow();
    expect(() =>
      emitEvent(db, {
        kind: "verifier_residual_high",
        substrate_origin: "substrate_auto",
        directive_id: "d_event_kind_intent",
        payload: { residual: 0.9, verifier_kind: "deterministic_code" },
      }),
    ).not.toThrow();
  });
});

describe("derived sets match their pre-unification shape", () => {
  test("EMBEDDABLE_KINDS is the right-sized retrieval surface", () => {
    // 2026-05-15 right-sizing audit (sample=30/kind over 25k events):
    // 12 kinds carry retrievable semantic text 50-100% of the time and
    // are kept. Kinds that historically had embeddable:true but in
    // practice yielded 0-20% text hits (structured-only payloads:
    // action_scored, act_artifact_admitted, task_closure_audited,
    // applied_change_committed, lesson_apply_*, brain_message_emitted,
    // brain_reasoning_recorded) were flipped off — they polluted
    // retrieval with structured noise + brain self-talk.
    const expected = new Set([
      // Goals + sub-goals.
      "directive_opened",
      "directive_amended",
      "task_node_opened",
      // Brain knowledge.
      "knowledge_candidate",
      "knowledge_promoted",      // resolved via JOIN to candidate.claim
      // Brain action surface (intent text, 100% hit).
      "action_predicted",
      // Tools.
      "act_artifact_candidate",
      // Structural amendments.
      "contract_amendment_proposed",
      // Pre-apply correction/adversarial judgments.
      "pre_apply_adjudication_recorded",
      // Process insights.
      "lesson_extracted",
      // Owner channel.
      "owner_input_received",
      "owner_decision_recorded",
      // Owner profile + insight candidates (UX dispatch 2026-05-15):
      // stable preferences + Claude/brain observations about the owner.
      "owner_profile_recorded",
      "owner_insight_candidate",
      // Onboarding (bp93s80hn): demo router. The earlier
      // `owner_persona_detected` kind was removed 2026-05-15 — owner
      // adaptation is now a continuous rendering_signals map on
      // owner_profile_recorded (no fixed persona enum).
      "demo_dispatched",
      // External-push envelope.
      "external_event_received",
      // Human-In-the-Loop blocker (substrate-side HIDL surface): retrieval
      // over `summary` + `reason` lets the brain spot recurrence of the
      // same blocker (auth_expired, quota_exhausted, env_missing, …) and
      // propose a structural fix rather than re-asking the owner.
      "hidl_action_required",
    ]);
    const derived = new Set(EMBEDDABLE_KINDS);
    for (const kind of expected) expect(derived.has(kind as EventKind)).toBe(true);
    // And no surprises in the derived set — every embeddable kind has
    // the flag set in EVENT_KINDS.
    for (const kind of derived) {
      expect(EVENT_KINDS[kind].embeddable).toBe(true);
    }
    // The flipped-off kinds must NOT appear in the embeddable set.
    const removed = new Set([
      "action_scored",
      "act_artifact_admitted",
      "task_closure_audited",
      "applied_change_committed",
      "lesson_apply_requested",
      "brain_message_emitted",
      "brain_reasoning_recorded",
    ]);
    for (const kind of removed) expect(derived.has(kind as EventKind)).toBe(false);
  });

  test("HEALTH_METRIC_KINDS is the substrate-status counter set", () => {
    // Pinned: the registry-derived HEALTH_METRIC_KINDS must include the
    // three pre-unification SQL `COUNT(*)` lookups plus any later additions
    // (Batch 8 added bridge_health_degraded + supervisor_intervention_recorded).
    const expected = new Set([
      "dispatcher_violation",
      "irreversible_effect_recorded",
      "worker_tick_overrun",
      "bridge_health_degraded",
      "supervisor_intervention_recorded",
      // Brain audit bqlr29psq (2026-05-15): hot-reload failures count
      // toward substrate-status so operators can spot a noisy source
      // editor pumping bad code into the daemon.
      "daemon_hotreload_failed",
      // Brain elegance bc8je5f3x (2026-05-15): pathology budget
      // exhaustion is the unified "directive not converging" signal.
      "pathology_budget_exhausted",
      // Brain sandbox audit bsfxsvgh9 (2026-05-15): terminal retirement
      // of chronically-failing artifacts is a substrate-status metric.
      "act_artifact_retired",
      // Stage-2 auto-apply worker (2026-05-15): mechanical apply
      // failures are a substrate-status signal — the brain's proposal
      // passed structural gates but tests refused it.
      "applied_change_failed",
      // Daemon unhandled rejection (2026-05-16): top-level handler
      // registered to prevent FastMCP/mcp-proxy SSE-conflict exceptions
      // from crashing the daemon. Every firing is a substrate-status
      // signal so operators can see the underlying transport fault.
      "daemon_unhandled_rejection",
      // Restart drain timeout (2026-05-16, YEF00QZM amendment 8EAKQCJW):
      // graceful shutdown drain budget elapsed before all in-flight
      // dispatches finished — operator must see this to know dispatches
      // were force-killed and may have orphaned.
      "restart_drain_timed_out",
      // Hot-reload deep-improvement (2026-05-17): rejected = validation
      // refused the new module shape (missing expected_exports / smoke
      // probe failed). Operator sees recurrent rejections as a substrate
      // health signal — bad edits aren't silently dropped, they show in
      // substrate-status.
      "daemon_hotreload_rejected",
      // SELF01-04 runtime self-diagnostic (2026-05-17, directive
      // DNXPNDPBEN0MF8B5S4DTFMNP98): every runtime emits this on fault
      // detection (missing_binary, missing_credential, silent_exit,
      // handshake_timeout, ...). Counting them per-window lets operators
      // see install / bridge degradation at substrate-status surface.
      "runtime_self_diagnostic_recorded",
      // C1 (2026-05-18, contract DXQK3VYMCH7930TP20H4QSTP0R):
      // structural predicate gate refused a act_artifact_candidate
      // body destined for ceo_buyer / external_executive. Per-window
      // count lets operators see how often the gate fires (k_252
      // advisory→structural conversion evidence).
      "predicate_gate_rejected",
      // C3 (2026-05-18, directive QHTRBV6PFX2JVBMHDNDA4B03GC):
      // strategy-first gate refused an `atms_report_v*` candidate
      // because no cited knowledge_candidate ended with
      // `_strategic_direction_chosen`. Health-metric so dashboards can
      // show how often report admissions skip the strategy step.
      "atms_strategy_first_violation",
      // F4c (2026-05-18, contract 897XTN2GF11XB9D4N45N2R9W58):
      // posterior-scored artifact-kind metadata. The seed and
      // posterior-update events count as health metrics so dashboards
      // can audit how the catalog grows.
      "artifact_kind_metadata_seeded",
      "artifact_kind_strategic_grounding_updated",
      // C2 (2026-05-18, contract V32YTK7HKN6MS38KWJY1SKTXAW): render
      // pipeline admission gates rejected payload metadata. Counting
      // per-window lets operators see how often render lineage breaks
      // (missing markdown_body_id, wrong kind on resolved id, PDF
      // forbidden in Alex path).
      "rendered_docx_invalid_inputs",
      "published_drive_doc_invalid_inputs",
      // Contract TJGFQC72 (2026-05-18): intent classification + dark-kind
      // observability. Counting these per-window lets operators see
      // classifier coverage, lane-routing refusals, refinement-depth
      // exhaustion, and high-residual verifier outcomes from a single
      // surface.
      "intent_classified",
      "lane_routing_refused",
      "refinement_depth_exceeded",
      "verifier_residual_high",
      // F3 (2026-05-18): lifecycle closure terminators. closure_obsolete
      // and closure_owner_required count as health metrics because their
      // rate signals stuck-contract pile-ups and expired owner asks.
      // closure_complete is healthy traffic, not a metric.
      "closure_obsolete",
      "closure_owner_required",
      // Timer-reactive redesign (directive 7AS6BPTNSS2YZD5M2ZS3V3S1GG):
      // worker_safety_net_fired counts as health metric because non-zero
      // missed_work_count signals reactive activation gaps.
      "worker_safety_net_fired",
      // T0.1 (brain dispatch TFZ6AJXNPS6655QMFWT6KPB3QM): substrate-truth
      // gate at the closure-audit boundary. Counts as a health metric so
      // dashboards can surface how often the brain claimed a clean closure
      // while no contract_amendment_proposed rows matched its declared
      // target_files — the canonical k_252 advisory-gate-fake signal.
      "closure_blocked_no_amendments",
      // 2026-05-19 (pending_decision_retire_worker): auto-prune of stale /
      // test-file-target / anchor-missing pending_owner_decision rows
      // emits this so dashboards can count retire rate per stale-class.
      "pending_decision_retired",
      // 2026-05-19 (brain dispatch J4HP5SYT3N4GK45S Candidate A): the
      // artifact_kind_backfill_worker sweep emits one
      // artifact_kind_backfilled per applied verdict and one
      // artifact_kind_inference_uncertain per deferred row. Counted as
      // health metrics so dashboards can show substrate-wide alias-
      // removal convergence (legacy-kind row count → 0) and the rate at
      // which the sweep declined to mutate (signal a human-curated kind
      // override may be needed). artifact_kind_inferred is per-row audit
      // trail — NOT health metric (every scanned row emits one).
      "artifact_kind_backfilled",
      "artifact_kind_inference_uncertain",
    ]);
    const derived = new Set(HEALTH_METRIC_KINDS);
    expect(derived.size).toBe(expected.size);
    for (const kind of expected) expect(derived.has(kind as EventKind)).toBe(true);
    for (const kind of derived) {
      expect(EVENT_KINDS[kind].health_metric).toBe(true);
    }
  });

  test("MIRROR_INLINE_EVENT_TYPES has the expected pre-set members", () => {
    // Every kind in this set is one the orchestrator MUST surface
    // inline to the operator (per .claude/rules/orchestrator-runtime.md
    // "Background command observability"). `acc notify` subscribes to
    // this set directly. The chat-worthy operator events (HIDL blocker,
    // owner-input prompts, auto-apply outcomes, dispatcher violations,
    // bridge failures) are all routed here. Future additions are
    // pinned the same way — enumerate, then the bidirectional
    // invariant below catches drift.
    const expected = new Set([
      "hidl_action_required",
      "owner_input_required",
      "auto_apply_signaled",
      "applied_change_committed",
      "applied_change_failed",
      "dispatcher_violation",
      "bridge_failed",
      // Auto-share-knowledge directive (f392277, owner-approved 2026-05-16):
      // cross-terminal observers + orchestrator inline chat see brain-authored
      // knowledge as it lands — completes the two-sided merger surface.
      "knowledge_candidate",
      "knowledge_synthesized",
      // Daemon unhandled rejection (2026-05-16): operators must see
      // mid-flight FastMCP/transport faults inline so they can react
      // before the next dispatch orphans.
      "daemon_unhandled_rejection",
      // Restart drain timeout (2026-05-16, YEF00QZM amendment 8EAKQCJW):
      // operator must see when forced kill happened post-drain budget.
      "restart_drain_timed_out",
      // F3 (2026-05-18): owner-required closure terminators must surface
      // inline so the owner sees the expired ask in chat without
      // opening logs.
      "closure_owner_required",
    ]);
    const derived = new Set(MIRROR_INLINE_EVENT_TYPES);
    expect(derived.size).toBe(expected.size);
    for (const kind of expected) expect(derived.has(kind as EventKind)).toBe(true);
    // Also pin the bidirectional invariant: every entry with the flag
    // appears in the set, and every set member has the flag.
    for (const [kind, meta] of Object.entries(EVENT_KINDS)) {
      const inSet = MIRROR_INLINE_EVENT_TYPES.has(kind as EventKind);
      expect(inSet).toBe(meta.mirror_inline);
    }
  });

  test("NARRATIVE_KINDS is the operator-stream filter derived from the registry", () => {
    // The operator's default `acc tail` / `acc events` narrative surface
    // is derived from `EVENT_KINDS[k].narrative === true`. Pre-fix the
    // list was a hand-maintained Set in `cli/observe.ts` that drifted
    // whenever a new kind landed in the registry. Now there is one source
    // of truth.
    expect(NARRATIVE_KINDS.size).toBeGreaterThan(0);
    // Pin a small load-bearing subset so accidental flag-flips show up.
    expect(NARRATIVE_KINDS.has("directive_opened")).toBe(true);
    expect(NARRATIVE_KINDS.has("task_node_opened")).toBe(true);
    expect(NARRATIVE_KINDS.has("task_committed")).toBe(true);
    // Bidirectional invariant: every member of NARRATIVE_KINDS is in
    // EVENT_KINDS with narrative=true, and every entry with narrative=true
    // is in NARRATIVE_KINDS — no drift possible in either direction.
    for (const kind of NARRATIVE_KINDS) {
      expect(kind in EVENT_KINDS).toBe(true);
      expect(EVENT_KINDS[kind as EventKind].narrative).toBe(true);
    }
    for (const [kind, meta] of Object.entries(EVENT_KINDS)) {
      expect(NARRATIVE_KINDS.has(kind)).toBe(meta.narrative);
    }
  });

  test("EventKind union is exactly keyof typeof EVENT_KINDS", () => {
    // Compile-time identity is what we actually care about; runtime
    // verification is a smoke test that the derived `EventKind`
    // re-export from `substrate/types.ts` matches the registry's
    // keyspace.
    const keys = Object.keys(EVENT_KINDS);
    // Each entry has all five flags.
    for (const k of keys) {
      const m = EVENT_KINDS[k];
      expect(typeof m.producer).toBe("string");
      expect(typeof m.embeddable).toBe("boolean");
      expect(typeof m.mirror_inline).toBe("boolean");
      expect(typeof m.health_metric).toBe("boolean");
      expect(typeof m.narrative).toBe("boolean");
    }
    // Sanity: registry has at least the 108 canonical kinds from
    // docs/substrate-entity-map.md plus the two previously-missing
    // kinds plus any subsequent additions.
    expect(keys.length).toBeGreaterThanOrEqual(110);
  });
});
