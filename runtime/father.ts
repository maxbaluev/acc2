// acc2 Father — brainless scheduler running on a fixed cadence
// (v2-design.md §14).
//
// Father is a recurring task in the substrate, NOT a separate process. Each
// tick reads:
//   - active_objectives_view (non-terminal, non-archived directives)
//   - rolling_review_due_view (long-horizon goals whose cadence has come due)
//   - directive_conflicts_view (blocks/watches/depletes edges)
//
// and picks the highest-priority work that is NOT blocked by an unresolved
// higher-priority directive. Father then OPENS a directive (compiling from a
// template) or a review subtask — it NEVER calls an LLM. The drift-prevention
// rule (§14): the only events Father may emit are from FatherAction. Any
// other event_kind with substrate_origin='father' is a structural fault
// surfaced by detectFatherDrift.
//
// Father respects the §3 owner-yield contract: if the owner spoke recently
// (`owner_input_received` within OWNER_ACTIVE_WINDOW_MS), Father emits
// `father_yielded` and returns without opening any directive.
//
// Templates: §14 says "compile_directive_from_template", "template only, NO
// free-form generation". The canonical templates live as a static list in
// this file (DIRECTIVE_TEMPLATES). They are conservative defaults — owners
// can still author free-form directives via `acc task`; Father uses the
// templates to fill maintenance / hygiene / review windows when no
// owner-authored work is queued. Keeping templates static (not in
// substrate/seed.ts) keeps the drift-prevention surface small: the entire
// template set is one source file the adversarial test can audit.

import type { Database } from "bun:sqlite";
import type { JsonValue } from "../substrate/types";
import { emitEvent } from "./events";
import { newId, nowIso } from "./ids";
import { activeObjectives, type ActiveObjectiveRow } from "../substrate/views";
import { readRollingReviewsDue, processRollingReviews, type RollingDirective } from "./rolling_reviewer";
import { readInterferenceEdges } from "./interference";
import { readCurrentMode } from "./crisis_mode";
import { inFlightDirectivesFromSql, CROSS_DIRECTIVE_BLOCKING_INTERACTIONS } from "./task_scheduler";
import { findRecipeMatch, RECIPE_DEFAULT_MIN_CONFIDENCE } from "./recipe_replay";

export type FatherAction =
  | "read_objectives"
  | "select_priority"
  | "compile_directive_from_template"
  | "open_directive"
  | "open_review_directive"
  | "journal_cycle"
  | "yield"
  | "self_suspend";

/** Canonical Father action set. The drift detector compares every event from
 *  substrate_origin='father' against this taxonomy. */
export const FATHER_ACTION_EVENT_KINDS: ReadonlySet<string> = new Set([
  // Father-action events Father itself emits.
  "father_cycle_recorded",
  "father_yielded",
  "father_drift_detected",
  "father_self_suspended",
  // Father may also open directives + review tasks. The §14 taxonomy folds
  // those into compile_directive_from_template / open_directive /
  // open_review_directive — they are valid events for Father to emit.
  "directive_opened",
  "task_node_opened",
  "directive_review_due",
  "directive_amended", // rolling-reviewer advances cadence via amendment
]);

export type FatherCycleResult = {
  cycle_id: string;
  action: FatherAction;
  detail: JsonValue;
  ts: string;
};

export type FatherDirectiveTemplate = {
  template_id: string;
  /** Fixed §14 action Father will record when this template fires. */
  action: Extract<FatherAction, "compile_directive_from_template">;
  directive_text: string;
  lifecycle: "finite" | "rolling_active";
  urgency: "normal" | "elevated";
  review_cadence?: "daily" | "weekly" | "monthly" | "quarterly" | "annually";
  initial_task_goal?: string;
};

/** Father's compiled directive templates. Each template is fully self-
 *  contained — Father never composes or generates text outside this list.
 *  Adding a template here is a code change subject to review.
 *
 *  Brain legacy-cleanup audit byaeuflif #2 (2026-05-15): the three
 *  extractor-pass templates (recipe / knowledge / act_artifact)
 *  were removed because the extractors worker (runtime/daemon.ts)
 *  now runs `extractRecipeCandidates`, `extractKnowledgePromotions`,
 *  `extractCodeArtifactScores`, and `extractSemanticDedup` on a
 *  bounded 5-minute cadence as substrate liveness functions. Father
 *  templating the same work duplicated the cadence and forked credit:
 *  promotions emitted by Father got tagged `substrate_origin=father`
 *  while those emitted by the worker got `substrate_auto`, so a single
 *  causal pass produced two competing-origin promotion events. Father
 *  now only templates work NOT owned by a canonical worker. */
export const DIRECTIVE_TEMPLATES: readonly FatherDirectiveTemplate[] = Object.freeze([
  {
    template_id: "father_owner_status_summary",
    action: "compile_directive_from_template",
    directive_text:
      "Owner-channel summary: enumerate active objectives, in-flight tasks, and any unresolved owner_input_required rows.",
    lifecycle: "finite",
    urgency: "normal",
    initial_task_goal:
      "Compose a short owner-status summary from active_objectives_view, ready tasks, and owner_conversation_view.",
  },
  {
    template_id: "father_compression_review",
    action: "compile_directive_from_template",
    directive_text:
      "Compression review: search the substrate and repo for duplicated prompt clauses, workflow branches, low-value event kinds, overlapping lessons, repeated verifier axes, and fragmented recipes; propose deletion, merge, or compression work ranked by architectural entropy reduction.",
    lifecycle: "finite",
    urgency: "normal",
    initial_task_goal:
      "Measure duplicated prompt clauses, workflow branches, low-value event kinds, overlapping lessons, repeated verifier axes, and fragmented recipes; propose concrete deletion/merge/compression amendments ranked by expected architectural entropy reduction.",
  },
]);

const OWNER_ACTIVE_WINDOW_MS_DEFAULT = 60_000;
const TEMPLATE_USE_COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes between same template fires

/** Check whether an `owner_input_received` event exists within the active
 *  window. When true Father MUST yield (§3 owner-yield contract). */
const ownerIsActive = (db: Database, nowIso: string, windowMs: number): boolean => {
  const row = db
    .query(
      `SELECT ts FROM events
       WHERE kind = 'owner_input_received'
       ORDER BY ts DESC LIMIT 1`,
    )
    .get() as { ts: string } | null;
  if (!row) return false;
  const dt = Date.parse(nowIso) - Date.parse(row.ts);
  return dt >= 0 && dt < windowMs;
};

export type PriorityChoice =
  | { kind: "rolling_review"; directive_id: string; row: RollingDirective }
  | { kind: "normal_objective"; directive_id: string; row: ActiveObjectiveRow }
  | { kind: "yield_template"; template: FatherDirectiveTemplate }
  | { kind: "none" };

/** Deterministic priority selector. The order:
 *    1. Any rolling_review_due directive — long-horizon goals must not slip.
 *    2. Active objectives sorted by urgency (crisis → elevated → normal),
 *       skipping any directive that is the target of an unresolved `blocks`
 *       edge from a non-terminal source AND down-ranking any directive that
 *       has an outbound cross-directive interference edge (`mutual_exclusion`
 *       or `resource_conflict`) pointing at an in-flight directive (so
 *       Father doesn't journal on it while the conflicting partner runs).
 *    3. If no work qualifies, fall back to a maintenance template whose last
 *       use is older than TEMPLATE_USE_COOLDOWN_MS.
 *    4. Otherwise yield (no work to do this tick).
 *
 *  `inFlightDirectives` is the set of directives currently running a brain
 *  dispatch — read SQL-side via `inFlightDirectivesFromSql` (multi-process
 *  safe). Pass an empty set when no scheduler is active; the down-rank
 *  collapses to a no-op. */
export const selectByPriorityAndFreshnessAndConflicts = (
  objectives: ActiveObjectiveRow[],
  rollingReviews: RollingDirective[],
  interferenceEdges: ReturnType<typeof readInterferenceEdges>,
  templates: readonly FatherDirectiveTemplate[],
  recentTemplateUses: Map<string, string>,
  nowIso: string,
  inFlightDirectives: ReadonlySet<string> = new Set<string>(),
  recipeBackedTemplateIds: ReadonlySet<string> = new Set<string>(),
  /** Multi-goal alignment (2026-05-15): directives that have unresolved
   *  owner_input_required events. Father MUST NOT pick a goal that's
   *  waiting for human input — that wastes brain dispatches on a goal
   *  that cannot make progress until the operator answers. Caller
   *  derives the set from the events ledger (see fatherIterate). */
  ownerBlockedDirectives: ReadonlySet<string> = new Set<string>(),
): PriorityChoice => {
  if (rollingReviews.length > 0) {
    const sorted = [...rollingReviews].sort((a, b) =>
      a.lifecycle.next_review_due.localeCompare(b.lifecycle.next_review_due),
    );
    return { kind: "rolling_review", directive_id: sorted[0]!.directive_id, row: sorted[0]! };
  }

  // Build a "blocked" set: directive_ids that are the to_directive of an
  // unresolved `blocks` edge. Father's view of "unresolved" is "no
  // goal_committed/abandoned on the from_directive" — since this function is
  // pure, we accept that information from the caller as a derived map.
  const blockedSet = new Set<string>();
  // Build a "conflict-deferred" set: directive_ids that have a
  // `mutual_exclusion` / `resource_conflict` edge to an in-flight directive
  // (in either direction — these interactions are symmetric). The set is
  // computed even when `inFlightDirectives` is empty (collapses to empty).
  const conflictDeferred = new Set<string>();
  for (const e of interferenceEdges) {
    if (e.kind === "blocks") blockedSet.add(e.to_directive);
    // `kind` on InterferenceEdge is canonicalised; cross-directive
    // interaction kinds (`mutual_exclusion`, `resource_conflict`) live in the
    // wider taxonomy C's Phase DAG branch extends. Read the payload-string
    // path to stay forward-compatible with both naming conventions.
    const interaction = (e as { kind: string }).kind;
    if (CROSS_DIRECTIVE_BLOCKING_INTERACTIONS.has(interaction)) {
      if (inFlightDirectives.has(e.to_directive)) conflictDeferred.add(e.from_directive);
      if (inFlightDirectives.has(e.from_directive)) conflictDeferred.add(e.to_directive);
    }
  }

  const urgencyOrder = (urgency: string): number => {
    if (urgency === "crisis") return 0;
    if (urgency === "elevated") return 1;
    return 2;
  };
  const objectivesSorted = [...objectives]
    .filter((o) => !blockedSet.has(o.directive_id))
    // Owner-input-required directives are NOT skipped silently — they
    // remain in the list but sort to the bottom via the ownerBlocked
    // tier below, so they get picked only when nothing else qualifies.
    // (Skipping entirely would hide them from Father's view; down-ranking
    // keeps the audit chain visible.)
    .sort((a, b) => {
      // Owner-blocked sort to bottom — Father picks them only if nothing
      // else qualifies; this preserves visibility (operator can SEE the
      // queue) while preventing wasted dispatches.
      const oa = ownerBlockedDirectives.has(a.directive_id) ? 1 : 0;
      const ob = ownerBlockedDirectives.has(b.directive_id) ? 1 : 0;
      if (oa !== ob) return oa - ob;
      // Conflict-deferred objectives sort AFTER non-deferred ones (down-rank,
      // do not skip — they remain selectable when nothing else qualifies).
      const da = conflictDeferred.has(a.directive_id) ? 1 : 0;
      const db = conflictDeferred.has(b.directive_id) ? 1 : 0;
      if (da !== db) return da - db;
      const ua = ((a.payload.urgency as string | undefined) ?? "normal");
      const ub = ((b.payload.urgency as string | undefined) ?? "normal");
      const orderA = urgencyOrder(ua);
      const orderB = urgencyOrder(ub);
      if (orderA !== orderB) return orderA - orderB;
      return a.opened_ts.localeCompare(b.opened_ts);
    });
  if (objectivesSorted.length > 0) {
    const head = objectivesSorted[0]!;
    return { kind: "normal_objective", directive_id: head.directive_id, row: head };
  }

  // Pick the oldest unused template (cool-down respected), preferring any
  // template whose root task currently has a Tier-0 recipe match. This keeps
  // recurring Father work on the substrate_replay lane whenever the organism
  // has already learned a safe trajectory for that recurring shape.
  const nowMs = Date.parse(nowIso);
  const eligibleTemplates = templates.filter((t) => {
    const last = recentTemplateUses.get(t.template_id);
    if (last) {
      const dt = nowMs - Date.parse(last);
      if (dt < TEMPLATE_USE_COOLDOWN_MS) return false;
    }
    return true;
  });
  const orderedTemplates = [...eligibleTemplates].sort((a, b) => {
    const ar = recipeBackedTemplateIds.has(a.template_id) ? 0 : 1;
    const br = recipeBackedTemplateIds.has(b.template_id) ? 0 : 1;
    return ar - br;
  });
  for (const t of orderedTemplates) {
    return { kind: "yield_template", template: t };
  }

  return { kind: "none" };
};

const fatherTemplateToProbeTask = (template: FatherDirectiveTemplate) => ({
  id: `father_template_probe:${template.template_id}`,
  directive_id: `father_template_probe:${template.template_id}`,
  parent_id: null,
  goal: template.initial_task_goal ?? template.directive_text,
  status: "ready" as const,
});

/** Return template ids whose root task would route through Tier-0 replay.
 *  Father does not replay directly and never calls an LLM; it only biases its
 *  recurring template selection toward learned, verifier-backed recipes so the
 *  scheduler/dispatcher can take the substrate_replay lane first. */
export const recipeBackedFatherTemplateIds = (
  db: Database,
  templates: readonly FatherDirectiveTemplate[] = DIRECTIVE_TEMPLATES,
): Set<string> => {
  const out = new Set<string>();
  for (const template of templates) {
    const match = findRecipeMatch(db, fatherTemplateToProbeTask(template), {
      minConfidence: RECIPE_DEFAULT_MIN_CONFIDENCE,
    });
    if (match) out.add(template.template_id);
  }
  return out;
};

/** Directives with unresolved owner_input_required events. A directive
 *  is owner-blocked when its most-recent owner_input_required has no
 *  later owner_decision_recorded for the same directive. Brain audit
 *  organism-alignment Track D (2026-05-15). */
const readOwnerBlockedDirectives = (db: Database): Set<string> => {
  const rows = db
    .query(
      `SELECT directive_id, kind, ts FROM events
       WHERE kind IN ('owner_input_required', 'owner_decision_recorded')
         AND directive_id IS NOT NULL
       ORDER BY ts ASC`,
    )
    .all() as Array<{ directive_id: string; kind: string; ts: string }>;
  // Walk in chronological order; track which directives are currently
  // open-on-input. owner_input_required opens the block; the next
  // owner_decision_recorded on the same directive closes it.
  const blocked = new Set<string>();
  for (const r of rows) {
    if (r.kind === "owner_input_required") blocked.add(r.directive_id);
    else if (r.kind === "owner_decision_recorded") blocked.delete(r.directive_id);
  }
  return blocked;
};

/** Find the most-recent fire timestamp for each Father directive template
 *  (recorded as a payload field on prior directive_opened events). */
const readTemplateUseTimestamps = (db: Database): Map<string, string> => {
  const rows = db
    .query(
      `SELECT ts, payload FROM events
       WHERE kind = 'directive_opened' AND substrate_origin = 'father'
       ORDER BY ts ASC`,
    )
    .all() as Array<{ ts: string; payload: string }>;
  const out = new Map<string, string>();
  for (const r of rows) {
    try {
      const p = JSON.parse(r.payload ?? "{}") as Record<string, unknown>;
      const tplId = p.father_template_id as string | undefined;
      if (tplId) out.set(tplId, r.ts);
    } catch { /* skip */ }
  }
  return out;
};

/** Open a Father-templated directive in the substrate. */
const openTemplatedDirective = (
  db: Database,
  template: FatherDirectiveTemplate,
  cycleId: string,
): { directive_id: string; task_id: string } => {
  if (template.action !== "compile_directive_from_template") {
    throw new Error(`invalid_father_template_action:${template.action}`);
  }
  const directiveId = newId();
  const taskId = newId();
  emitEvent(db, {
    kind: "directive_opened",
    substrate_origin: "father",
    directive_id: directiveId,
    task_id: directiveId,
    payload: {
      directive_text: template.directive_text,
      lifecycle: template.lifecycle,
      urgency: template.urgency,
      father_template_id: template.template_id,
      father_cycle_id: cycleId,
      father_action: template.action,
    } as JsonValue,
  });
  emitEvent(db, {
    kind: "task_node_opened",
    substrate_origin: "father",
    directive_id: directiveId,
    task_id: taskId,
    parent_task_id: null,
    payload: {
      goal: template.initial_task_goal ?? template.directive_text,
      lifecycle: "finite",
      urgency: template.urgency,
      father_template_id: template.template_id,
      father_action: template.action,
    } as JsonValue,
  });
  return { directive_id: directiveId, task_id: taskId };
};

export type FatherIterateOpts = {
  now?: string;
  ownerActiveWindowMs?: number;
  /** Optional reactive trigger context — populated when fatherIterate is
   *  invoked via the activation-bus path (fatherJournalOnEvent) so the
   *  journal_cycle payload can cite WHICH event triggered the cycle. */
  trigger?: { kind: string; event_id: string };
};

export type FatherJournalEvent = {
  kind: string;
  event_id: string;
  /** When known, the event's substrate_origin. The reactive entry point
   *  short-circuits when origin === "father" so self-emitted cycles
   *  cannot recursively re-trigger the journal. When omitted (e.g. the
   *  activation bus does not propagate origin), the helper looks the row
   *  up by event_id before deciding. */
  substrate_origin?: string | null;
};

export type FatherJournalOpts = {
  now?: string;
  journalEveryEvents?: number;
};

/** Count events since the last `father_cycle_recorded`. Used by the reactive
 *  entry point to throttle journal cycles to once per N events instead of
 *  once per cadence interval. */
const countEventsSinceLastFatherJournal = (db: Database): number => {
  const lastJournal = db
    .query<{ ts: string }, []>(
      "SELECT ts FROM events WHERE kind = 'father_cycle_recorded' ORDER BY ts DESC LIMIT 1",
    )
    .get();
  if (!lastJournal) {
    return db
      .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM events")
      .get()?.n ?? 0;
  }
  return db
    .query<{ n: number }, [string]>(
      "SELECT COUNT(*) AS n FROM events WHERE ts > ?",
    )
    .get(lastJournal.ts)?.n ?? 0;
};

/** Reactive entry point: wraps fatherIterate behind an event-driven gate so
 *  Father runs once per N events instead of on a fixed cadence. Returns null
 *  when the event is self-emitted (substrate_origin=father) or the throttle
 *  threshold has not been reached. */
export const fatherJournalOnEvent = async (
  db: Database,
  event: FatherJournalEvent,
  opts: FatherJournalOpts = {},
): Promise<FatherCycleResult | null> => {
  let origin = event.substrate_origin;
  if (origin === undefined) {
    const row = db
      .query<{ substrate_origin: string | null }, [string]>(
        "SELECT substrate_origin FROM events WHERE id = ?",
      )
      .get(event.event_id);
    origin = row?.substrate_origin ?? null;
  }
  if (origin === "father") return null;
  const threshold = opts.journalEveryEvents ?? 100;
  if (countEventsSinceLastFatherJournal(db) < threshold) return null;
  return fatherIterate(db, {
    now: opts.now,
    trigger: { kind: event.kind, event_id: event.event_id },
  });
};

/** Check whether Father is currently suspended due to a drift detection.
 *
 *  A suspension is active when the LATEST `father_drift_detected` event has
 *  not yet been cleared by a `father_drift_resolved` event that cites it via
 *  `context_refs`. The owner clears the suspension by emitting
 *  `father_drift_resolved` (manual admin path or via a future
 *  `acc admin father-resume` command).
 *
 *  Returns the drift event id when suspended, or null when clear. */
export const fatherSuspensionActive = (db: Database): string | null => {
  const drift = db
    .query(
      `SELECT id, ts FROM events
       WHERE kind = 'father_drift_detected'
       ORDER BY ts DESC LIMIT 1`,
    )
    .get() as { id: string; ts: string } | null;
  if (!drift) return null;

  // A resolve event clears the suspension when it cites the drift id in
  // context_refs. Citing is more robust than timestamp comparison because
  // sub-millisecond bursts (drift detect → immediate resolve) share a ts.
  const resolved = db
    .query(
      `SELECT id FROM events
       WHERE kind = 'father_drift_resolved'
         AND context_refs LIKE '%"' || ? || '"%'
       LIMIT 1`,
    )
    .get(drift.id) as { id: string } | null;
  if (resolved) return null;
  return drift.id;
};

/** Operator-facing API for clearing a Father drift suspension. Emits a
 *  `father_drift_resolved` event citing the drift detection so the next
 *  Father tick can resume normal iteration. Returns the resolved event id
 *  on success, or null when no suspension is active (no-op). */
export const resolveFatherDrift = (
  db: Database,
  opts: { reason?: string; now?: string } = {},
): { resolved_event_id: string; drift_event_id: string } | null => {
  const driftId = fatherSuspensionActive(db);
  if (!driftId) return null;
  const ts = opts.now ?? nowIso();
  const result = emitEvent(db, {
    kind: "father_drift_resolved",
    substrate_origin: "owner",
    context_refs: [driftId],
    payload: {
      drift_event_id: driftId,
      reason: opts.reason ?? "operator_acknowledged",
      ts,
    } as JsonValue,
  });
  return { resolved_event_id: result.id, drift_event_id: driftId };
};

/** One Father tick. Reads state, picks priority, opens a directive (or
 *  yields), emits father_cycle_recorded. NO LLM call ever happens — Father
 *  has zero bridge capability (drift-prevention enforced by detectFatherDrift
 *  + the adversarial test in father.test.ts). */
export const fatherIterate = async (
  db: Database,
  opts: FatherIterateOpts = {},
): Promise<FatherCycleResult> => {
  const cycleId = newId();
  const ts = opts.now ?? nowIso();
  const windowMs = opts.ownerActiveWindowMs ?? OWNER_ACTIVE_WINDOW_MS_DEFAULT;

  // Drift self-suspend (Batch 4 Hole 2). If the most recent
  // `father_drift_detected` event has NOT yet been cleared by a
  // `father_drift_resolved` row, Father refuses to iterate — the suspension
  // protects the substrate from compounding bad rows while the operator
  // investigates. The suspend itself is recorded as `father_self_suspended`
  // (a valid FATHER_ACTION event so it doesn't re-trigger the drift detector).
  const driftId = fatherSuspensionActive(db);
  if (driftId) {
    emitEvent(db, {
      kind: "father_self_suspended",
      substrate_origin: "father",
      context_refs: [driftId],
      payload: {
        cycle_id: cycleId,
        reason: "drift_detected",
        drift_event_id: driftId,
      } as JsonValue,
    });
    return {
      cycle_id: cycleId,
      action: "self_suspend",
      detail: { reason: "drift_detected", drift_event_id: driftId } as JsonValue,
      ts,
    };
  }

  // Owner-active backoff (§3 yield contract).
  if (ownerIsActive(db, ts, windowMs)) {
    emitEvent(db, {
      kind: "father_yielded",
      substrate_origin: "father",
      payload: {
        cycle_id: cycleId,
        reason: "owner_active",
        owner_active_window_ms: windowMs,
      } as JsonValue,
    });
    return {
      cycle_id: cycleId,
      action: "yield",
      detail: { reason: "owner_active" } as JsonValue,
      ts,
    };
  }

  // Read state inputs.
  const objectives = activeObjectives(db);
  const rolling = readRollingReviewsDue(db, ts);
  const edges = readInterferenceEdges(db);
  const templateUses = readTemplateUseTimestamps(db);
  const recipeBackedTemplates = recipeBackedFatherTemplateIds(db, DIRECTIVE_TEMPLATES);
  // Multi-process in-flight set (SQL-backed; no dependency on the scheduler's
  // in-memory Map). Used by the priority selector to down-rank objectives
  // that have a mutual_exclusion / resource_conflict edge to a directive
  // currently running a brain dispatch.
  const inFlight = inFlightDirectivesFromSql(db);
  // Multi-goal alignment (2026-05-15): directives with unresolved
  // owner_input_required events. A directive is owner-blocked when
  // its most-recent owner_input_required has no later owner_decision_recorded
  // (or task_committed clearing the gate). Father down-ranks owner-blocked
  // directives so brain dispatches don't waste cycles on goals that can't
  // make progress until the operator answers.
  const ownerBlocked = readOwnerBlockedDirectives(db);

  const choice = selectByPriorityAndFreshnessAndConflicts(
    objectives,
    rolling,
    edges,
    DIRECTIVE_TEMPLATES,
    templateUses,
    ts,
    inFlight,
    recipeBackedTemplates,
    ownerBlocked,
  );

  if (choice.kind === "rolling_review") {
    // Open a review subtask via the rolling reviewer module. The reviewer
    // emits directive_review_due + task_node_opened + directive_amended for
    // cadence advancement.
    await processRollingReviews(db, ts);
    emitEvent(db, {
      kind: "father_cycle_recorded",
      substrate_origin: "father",
      directive_id: choice.directive_id,
      payload: {
        cycle_id: cycleId,
        action: "open_review_directive",
        directive_id: choice.directive_id,
      } as JsonValue,
    });
    return {
      cycle_id: cycleId,
      action: "open_review_directive",
      detail: { directive_id: choice.directive_id } as JsonValue,
      ts,
    };
  }

  if (choice.kind === "normal_objective") {
    // Father DOES NOT decompose normal owner-authored objectives — the brain
    // does. Father only journals that the objective remains active so the
    // scheduler / dispatcher will pick up any unblocked ready task. We emit
    // father_cycle_recorded with action='journal_cycle' to record the tick.
    const mode = readCurrentMode(db, choice.directive_id);
    emitEvent(db, {
      kind: "father_cycle_recorded",
      substrate_origin: "father",
      directive_id: choice.directive_id,
      payload: {
        cycle_id: cycleId,
        action: "journal_cycle",
        directive_id: choice.directive_id,
        mode_urgency: mode === readCurrentMode(db, choice.directive_id) ? (choice.row.payload.urgency as string | undefined) ?? "normal" : "normal",
      } as JsonValue,
    });
    return {
      cycle_id: cycleId,
      action: "journal_cycle",
      detail: { directive_id: choice.directive_id } as JsonValue,
      ts,
    };
  }

  if (choice.kind === "yield_template") {
    const opened = openTemplatedDirective(db, choice.template, cycleId);
    emitEvent(db, {
      kind: "father_cycle_recorded",
      substrate_origin: "father",
      directive_id: opened.directive_id,
      payload: {
        cycle_id: cycleId,
        action: choice.template.action,
        template_id: choice.template.template_id,
        directive_id: opened.directive_id,
        tier0_replay_preferred: recipeBackedTemplates.has(choice.template.template_id),
      } as JsonValue,
    });
    return {
      cycle_id: cycleId,
      action: "compile_directive_from_template",
      detail: {
        template_id: choice.template.template_id,
        directive_id: opened.directive_id,
      } as JsonValue,
      ts,
    };
  }

  // No work and no eligible template — yield.
  emitEvent(db, {
    kind: "father_yielded",
    substrate_origin: "father",
    payload: {
      cycle_id: cycleId,
      reason: "no_work_in_queue",
    } as JsonValue,
  });
  return {
    cycle_id: cycleId,
    action: "yield",
    detail: { reason: "no_work_in_queue" } as JsonValue,
    ts,
  };
};

export type FatherLoopOpts = {
  signal?: AbortSignal;
  intervalMs?: number;
  /** Override clock for tests. */
  now?: () => string;
};

/** Long-running loop: invokes fatherIterate on a fixed cadence (default
 *  5 min normal; 30 s under crisis mode). Returns when the signal aborts.
 *  Errors are swallowed so a single bad tick can't kill Father (each tick
 *  records its own diagnostics). */
export const fatherLoop = async (
  db: Database,
  opts: FatherLoopOpts = {},
): Promise<void> => {
  const interval = opts.intervalMs ?? 5 * 60 * 1000;
  const clock = opts.now ?? nowIso;
  while (!opts.signal?.aborted) {
    try {
      await fatherIterate(db, { now: clock() });
    } catch { /* swallow per-tick */ }
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, interval);
      opts.signal?.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
    });
  }
};

export type FatherDriftReport = {
  drift_count: number;
  offending_event_ids: string[];
};

/** Drift detector: scans events where substrate_origin='father' and ensures
 *  every event kind belongs to FATHER_ACTION_EVENT_KINDS. Any event outside
 *  the set is a structural violation that emits father_drift_detected. The
 *  detector is idempotent — re-running on the same offenders does NOT
 *  re-emit (we dedup against the already-emitted offending_event_ids set). */
export const detectFatherDrift = (
  db: Database,
  lookbackEvents = 500,
): FatherDriftReport => {
  const rows = db
    .query(
      `SELECT id, kind FROM events
       WHERE substrate_origin = 'father'
       ORDER BY ts DESC LIMIT ?`,
    )
    .all(lookbackEvents) as Array<{ id: string; kind: string }>;

  // Already-reported offenders.
  const reportedRows = db
    .query(
      `SELECT context_refs FROM events WHERE kind = 'father_drift_detected'`,
    )
    .all() as Array<{ context_refs: string }>;
  const reported = new Set<string>();
  for (const r of reportedRows) {
    try {
      const refs = JSON.parse(r.context_refs ?? "[]") as string[];
      for (const ref of refs) reported.add(ref);
    } catch { /* skip */ }
  }

  const offending: string[] = [];
  for (const r of rows) {
    if (FATHER_ACTION_EVENT_KINDS.has(r.kind)) continue;
    if (reported.has(r.id)) continue;
    offending.push(r.id);
  }

  for (const offenderId of offending) {
    emitEvent(db, {
      kind: "father_drift_detected",
      substrate_origin: "substrate_auto",
      payload: {
        offender_event_id: offenderId,
        reason: "event_kind_outside_father_action_set",
      } as JsonValue,
      context_refs: [offenderId],
    });
  }

  return {
    drift_count: offending.length,
    offending_event_ids: offending,
  };
};
