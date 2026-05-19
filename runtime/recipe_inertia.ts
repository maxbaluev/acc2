// acc2 recipe inertia decay — Layer-2 SMART axis closure (brain audit
// QQEHAW97GS0AX7TEQ717Y3P174, 2026-05-15).
//
// Layer-2 intelligence is the substrate's recipe layer: it COMPOUNDS skill
// by promoting successful replays. The brain audit lesson observed that the
// current loop only PROMOTES (success → +0.05 confidence); it never DECAYS
// inert rows. A recipe extracted a year ago, replayed once, that nobody has
// touched since, stays at its frozen high-water confidence forever and can
// keep winning the Tier-0 dispatch lane against newer, better recipes.
// Inertia decay closes that gap: rows that haven't been replayed in
// `RECIPE_INERTIA_DECAY_DAYS` (default 14) days get a small confidence
// haircut on every decay tick, so an unused recipe slowly drifts out of
// the Tier-0 lane until something proves it again (a successful replay
// bumps it back via updateRecipeConfidence).
//
// Decay shape:
//   - Tick cadence is owned by the caller (a daemon worker or test). One
//     call to `applyRecipeInertiaDecay(db)` is one tick.
//   - Idempotency: if a recipe ALREADY received an `inertia_decayed` event
//     in the same second (ts equality), skip it. This makes back-to-back
//     calls in the same wall-clock second decay each recipe ONCE.
//   - Floor: confidence multiplied by (1 - 0.05) but never below 0.1 — even
//     a decayed recipe stays slightly above the auto-archive floor so it
//     CAN be revived by a single success bump (which adds +0.05 → above
//     archive floor → eligible for retrieval again).
//   - Eligibility: a recipe is "inert" when no replay row exists for its
//     id within the last N days. We use action_predicted rows with
//     substrate_origin='recipe' and payload.recipe_id == <id> as the proxy
//     for "this recipe was replayed". If no replay ever happened AND the
//     seed was extracted > N days ago, the recipe is decayed.
//
// All decay rows are emitted as `recipe-shape knowledge` events tagged with
// payload.confidence_update = "inertia_decayed" + context_refs pointing
// back to the prior canonical recipe row. The view picks the
// HIGHEST-confidence row per (goal_shape, topology_signature) pair, so
// repeated decay rows naturally compound across the time axis: an inert
// recipe at 0.85 decays to 0.8075 → 0.767 → 0.729 → ... → 0.1, then stops
// (floor). When a new success arrives, updateRecipeConfidence emits a row
// at 0.15 (the latest decayed + 0.05), which is below the auto-archive
// floor of 0.2 but above 0.0 — the recipe needs further successes to
// re-cross the Tier-0 threshold.

import type { Database } from "bun:sqlite";
import type { JsonValue } from "../substrate/types";
import { emitEvent } from "./events";
import { recipesLatestView, type RecipesLatestRow } from "../substrate/views";

/** Days a recipe can sit un-replayed before decay applies on the next tick. */
export const RECIPE_INERTIA_DECAY_DAYS = 14;

/** Multiplicative decay applied per tick. 5% is small enough that a
 *  single missed replay doesn't tank the recipe, large enough that
 *  ~14 ticks (≈ 6 months of inactivity at the 14-day cadence) removes
 *  it from the Tier-0 lane entirely. */
export const RECIPE_INERTIA_DECAY = 0.05;

/** Floor: confidence never decays below this. A revived recipe can climb
 *  back up via updateRecipeConfidence on the next success. */
export const RECIPE_INERTIA_FLOOR = 0.1;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export type RecipeInertiaOutcome = {
  /** Total recipes inspected (the size of recipes_latest_view). */
  scanned: number;
  /** Recipes that received a decay row this tick. */
  decayed: number;
  /** Recipes skipped because they were not inert (replayed recently). */
  skipped_recent_replay: number;
  /** Recipes skipped because the previous decay row landed in the same
   *  second (idempotency dedup). */
  skipped_same_second: number;
  /** Recipes skipped because their confidence is already at the floor. */
  skipped_at_floor: number;
  /** Recipe ids that received a decay row this tick. */
  decayed_recipe_ids: string[];
};

/** Find the most-recent replay timestamp for a recipe key. A "replay" is
 *  an `action_predicted` row whose substrate_origin is 'recipe' and whose
 *  payload.recipe_id matches the supplied id. Returns null when no replay
 *  has ever happened for that recipe key. */
const lastReplayTsForRecipe = (
  db: Database,
  recipeId: string,
): string | null => {
  const row = db
    .query(
      `SELECT ts FROM events
       WHERE kind = 'action_predicted'
         AND substrate_origin = 'recipe'
         AND json_extract(payload, '$.recipe_id') = ?
       ORDER BY ts DESC
       LIMIT 1`,
    )
    .get(recipeId) as { ts: string } | null;
  return row?.ts ?? null;
};

/** Find the extracted_ts (the recipe row's own ts) for a given event id. */
const extractedTsForEvent = (db: Database, eventId: string): string | null => {
  const row = db
    .query("SELECT ts FROM events WHERE id = ? LIMIT 1")
    .get(eventId) as { ts: string } | null;
  return row?.ts ?? null;
};

/** Has this recipe key already been decayed in the SAME wall-clock second?
 *  Idempotency guard: back-to-back calls within one second produce ONE
 *  decay row per recipe, not two. The match key is the recipe's
 *  (goal_shape, topology_signature) pair — decay rows always carry both. */
const decayedThisSecond = (
  db: Database,
  goalShape: string,
  topologySignature: string,
  nowIso: string,
): boolean => {
  const second = nowIso.slice(0, 19); // strip ms/tz for second-level compare
  const rows = db
    .query(
      `SELECT ts, payload FROM events
       WHERE kind IN ('knowledge_candidate', 'knowledge_promoted')
         AND COALESCE(
           json_extract(payload, '$.recipe_shape.enabled'),
           json_extract(payload, '$.recipe.enabled'),
           json_extract(payload, '$.is_recipe'),
           0
         ) IN (1, 'true')
         AND json_extract(payload, '$.confidence_update') = 'inertia_decayed'
         AND json_extract(payload, '$.goal_shape') = ?
         AND json_extract(payload, '$.topology_signature') = ?
         AND substr(ts, 1, 19) = ?
       LIMIT 1`,
    )
    .get(goalShape, topologySignature, second) as { ts: string; payload: string } | null;
  return rows !== null;
};

/** Per-tick decay pass: scan recipes_latest_view, emit one decay event per
 *  inert recipe key. Returns counts so the caller (daemon worker or test)
 *  can observe per-tick activity. */
export const applyRecipeInertiaDecay = (
  db: Database,
): RecipeInertiaOutcome => {
  const outcome: RecipeInertiaOutcome = {
    scanned: 0,
    decayed: 0,
    skipped_recent_replay: 0,
    skipped_same_second: 0,
    skipped_at_floor: 0,
    decayed_recipe_ids: [],
  };

  let viewRows: RecipesLatestRow[];
  try {
    viewRows = recipesLatestView(db);
  } catch (err) {
    try {
      emitEvent(db, {
        kind: "error_caught",
        substrate_origin: "substrate_auto",
        payload: {
          where: "recipe_inertia.applyRecipeInertiaDecay.recipesLatestView",
          recoverable: true,
          message: (err as Error).message,
        } as JsonValue,
      });
    } catch { /* db may be closed */ }
    return outcome;
  }

  outcome.scanned = viewRows.length;
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const ageThresholdMs = RECIPE_INERTIA_DECAY_DAYS * MS_PER_DAY;

  for (const r of viewRows) {
    const lastReplay = lastReplayTsForRecipe(db, r.id);
    const extracted = extractedTsForEvent(db, r.id);

    // Eligibility: inert when last replay > N days ago, OR (no replay ever
    // AND extracted > N days ago). When neither ts is available we cannot
    // assess inertia — skip rather than decay blindly.
    let isInert = false;
    if (lastReplay) {
      const ageMs = nowMs - Date.parse(lastReplay);
      isInert = ageMs >= ageThresholdMs;
    } else if (extracted) {
      const ageMs = nowMs - Date.parse(extracted);
      isInert = ageMs >= ageThresholdMs;
    }
    if (!isInert) {
      outcome.skipped_recent_replay += 1;
      continue;
    }

    // Floor: already at or below the floor — nothing to do.
    if (r.confidence <= RECIPE_INERTIA_FLOOR) {
      outcome.skipped_at_floor += 1;
      continue;
    }

    // Idempotency: did we already emit an inertia_decayed row in the same
    // wall-clock second for this key?
    if (decayedThisSecond(db, r.goal_shape, r.topology_signature, nowIso)) {
      outcome.skipped_same_second += 1;
      continue;
    }

    const decayed = Math.max(
      RECIPE_INERTIA_FLOOR,
      r.confidence * (1 - RECIPE_INERTIA_DECAY),
    );

    // Preserve the original payload (trajectory, topology, etc.) and only
    // overwrite confidence + add the decay metadata. context_refs cite the
    // prior canonical row so the four-link credit chain stays whole even
    // for substrate-self-correction events.
    const priorPayload = r.payload ?? {};
    const priorRecipeShape =
      (priorPayload.recipe_shape && typeof priorPayload.recipe_shape === "object")
        ? (priorPayload.recipe_shape as Record<string, unknown>)
        : priorPayload;
    const newPayload: Record<string, unknown> = {
      ...priorPayload,
      claim: `Reusable trajectory ${r.id} confidence decayed by inertia.`,
      evidence: [`previous_confidence=${r.confidence}`, "no replay within inertia window"],
      implications: ["Stale recipe-shape knowledge decays toward floor until a fresh success refreshes it."],
      applies_to: ["reusable_trajectory", r.goal_shape],
      confidence_estimate: decayed,
      goal_shape: r.goal_shape,
      topology_signature: r.topology_signature,
      confidence: decayed,
      previous_confidence: r.confidence,
      confidence_update: "inertia_decayed",
      derived_from_recipe_id: r.id,
      derived_from_knowledge_id: r.id,
      inertia_decay_days: RECIPE_INERTIA_DECAY_DAYS,
      inertia_decay_step: RECIPE_INERTIA_DECAY,
      recipe_shape: {
        ...priorRecipeShape,
        enabled: true,
        confidence: decayed,
        previous_confidence: r.confidence,
        confidence_update: "inertia_decayed",
        derived_from_recipe_id: r.id,
        derived_from_knowledge_id: r.id,
        inertia_decay_days: RECIPE_INERTIA_DECAY_DAYS,
        inertia_decay_step: RECIPE_INERTIA_DECAY,
      },
    };

    emitEvent(db, {
      kind: "knowledge_candidate",
      substrate_origin: "substrate_auto",
      payload: newPayload as JsonValue,
      context_refs: [r.id],
    });
    outcome.decayed += 1;
    outcome.decayed_recipe_ids.push(r.id);
  }

  return outcome;
};
