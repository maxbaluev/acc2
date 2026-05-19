// Substrate liveness contract — single source of truth for "is this
// install ready for real-brain dispatch?" content checks.
//
// Two operator surfaces ask that question in slightly different shapes:
//   - `acc doctor`              (cli/doctor.ts) — per-check pass/fail UX
//   - `acc admin substrate-status` (cli/admin_substrate_status.ts) —
//     one-screen ALIVE / DEGRADED / DEAD verdict.
//
// Both used to declare their own seed-count floors. A future operator
// changing one number would forget the other and the two surfaces would
// silently disagree about whether the substrate is ready. This module
// extracts the floor numbers AND the verdict function into one place;
// both consumers import from here.
//
// LIVENESS_THRESHOLDS is the single source of truth for the seed-count
// floors. `computeLivenessReport` is the single source of truth for
// the ALIVE / DEGRADED / DEAD verdict.
//
// Verdict semantics (canonical):
//   - ALIVE     — every required signal observed >= required
//   - DEGRADED  — events > 0 AND vec_events extension loadable (vec
//                 events present), but at least one seed signal missing
//   - DEAD      — events == 0 (fresh install or substrate dropped)

import type { Database } from "bun:sqlite";

/** Canonical seed-count floors. Both doctor's per-check pass/fail
 *  surface and substrate-status' verdict computation derive from these
 *  numbers — change once here, both surfaces pick it up. */
export const LIVENESS_THRESHOLDS = {
  /** `events.kind = 'knowledge_promoted'` row count floor.
   *  `seedFoundationalKnowledge` (substrate/seed.ts) imports structural laws
   *  plus moved contract knowledge under owner-approval; the floor at 5 tolerates rotation but flips
   *  to FAIL on a structurally incomplete db. */
  knowledgePromoted: 5,
  /** `act_artifact` rows where name LIKE 'seed_%' OR id LIKE 'seed_%'
   *  floor. `seedActArtifacts` admits 8 canonical rows; floor at 5
   *  tolerates eviction. */
  actArtifactsSeed: 5,
  /** Recipe-shape knowledge row floor (knowledge_candidate /
   *  knowledge_promoted carrying recipe_shape.enabled). `seedRecipes`
   *  lays down 2 canonical Tier-0 trajectories; floor at 1 tolerates
   *  one eviction without flipping to FAIL. */
  recipesSeed: 1,
  /** `vec_events` virtual-table row count floor. Embedder writes one
   *  row per embeddable event; floor at 1 means the embedder has run
   *  at least once (vec extension loaded + at least one event indexed). */
  vecExtensionLoadable: 1,
} as const;

/** One signal in the liveness report — name, observed value, the floor
 *  it must meet, and whether it passed. Render layers iterate these to
 *  build per-signal output without re-encoding the threshold logic. */
export type LivenessSignal = {
  name: string;
  observed: number;
  required: number;
  pass: boolean;
};

/** Full liveness report — every signal plus the composite verdict. */
export type LivenessReport = {
  signals: LivenessSignal[];
  verdict: "ALIVE" | "DEGRADED" | "DEAD";
};

const safeCount = (db: Database, sql: string): number => {
  try {
    return (db.query(sql).get() as { c: number } | null)?.c ?? 0;
  } catch {
    return 0;
  }
};

/** Compute the canonical liveness report for a substrate. The verdict
 *  function is centralized here so doctor and substrate-status can both
 *  delegate. */
export const computeLivenessReport = (db: Database): LivenessReport => {
  const events = safeCount(db, "SELECT COUNT(*) AS c FROM events");
  const knowledgePromoted = safeCount(
    db,
    "SELECT COUNT(*) AS c FROM events WHERE kind = 'knowledge_promoted'",
  );
  const actArtifactsSeed = safeCount(
    db,
    "SELECT COUNT(*) AS c FROM act_artifact WHERE id LIKE 'seed_%' OR name LIKE 'seed_%'",
  );
  const recipesSeed = safeCount(
    db,
    `SELECT COUNT(*) AS c FROM events
     WHERE kind IN ('knowledge_candidate', 'knowledge_promoted')
       AND COALESCE(
         json_extract(payload, '$.recipe_shape.enabled'),
         json_extract(payload, '$.recipe.enabled'),
         json_extract(payload, '$.is_recipe'),
         0
       ) IN (1, 'true')`,
  );
  const vecEvents = safeCount(db, "SELECT COUNT(*) AS c FROM vec_events");

  const signals: LivenessSignal[] = [
    {
      name: "knowledgePromoted",
      observed: knowledgePromoted,
      required: LIVENESS_THRESHOLDS.knowledgePromoted,
      pass: knowledgePromoted >= LIVENESS_THRESHOLDS.knowledgePromoted,
    },
    {
      name: "actArtifactsSeed",
      observed: actArtifactsSeed,
      required: LIVENESS_THRESHOLDS.actArtifactsSeed,
      pass: actArtifactsSeed >= LIVENESS_THRESHOLDS.actArtifactsSeed,
    },
    {
      name: "recipesSeed",
      observed: recipesSeed,
      required: LIVENESS_THRESHOLDS.recipesSeed,
      pass: recipesSeed >= LIVENESS_THRESHOLDS.recipesSeed,
    },
    {
      name: "vecExtensionLoadable",
      observed: vecEvents,
      required: LIVENESS_THRESHOLDS.vecExtensionLoadable,
      pass: vecEvents >= LIVENESS_THRESHOLDS.vecExtensionLoadable,
    },
  ];

  let verdict: LivenessReport["verdict"];
  if (events === 0) {
    verdict = "DEAD";
  } else if (signals.every((s) => s.pass)) {
    verdict = "ALIVE";
  } else {
    verdict = "DEGRADED";
  }

  return { signals, verdict };
};
