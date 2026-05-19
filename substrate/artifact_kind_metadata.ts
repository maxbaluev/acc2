// acc2 artifact-kind metadata — posterior-scored grounding gates per
// artifact kind. F4c (2026-05-18, contract 897XTN2GF11XB9D4N45N2R9W58),
// design KCs Q5JBEYJ9GS5D35J7EF3YWQ7NS4 (strategic_artifact_detection_property_v1)
// and P2EBADX3JD7A3EQ5ZDK8VGS5JR (strategy_first_kind_posterior_design).
//
// Replaces the hard-coded `atms_report_v*` prefix check that previously
// gated strategy-first admission. The substrate now learns
// `needs_strategic_grounding` as a Beta-scored scalar per kind: high prior
// for atms_report_v* kinds (seeded), zero for everything else until owner
// rejection (or another posterior-update path) raises it.
//
// Schema (one row per `artifact_kind` string):
//   artifact_kind                TEXT PRIMARY KEY
//   needs_strategic_grounding    REAL (Beta mean, defaults to 0.0)
//   posterior_alpha              REAL (Beta α, defaults to 1.0)
//   posterior_beta               REAL (Beta β, defaults to 1.0)
//   last_updated_ts              TEXT (ISO-8601)
//
// Rule (used by admission, candidate screen, closure check, classifier):
//   needs_strategic_grounding > 0.5 → enforce _strategic_direction_chosen
//   citation. Missing row → defaults to 0.0 → no enforcement.

import type { Database } from "bun:sqlite";

export const STRATEGIC_GROUNDING_THRESHOLD = 0.5;

export type ArtifactKindMetadata = {
  artifact_kind: string;
  needs_strategic_grounding: number;
  posterior_alpha: number;
  posterior_beta: number;
  last_updated_ts: string;
};

const DDL = `
CREATE TABLE IF NOT EXISTS artifact_kind_metadata (
  artifact_kind             TEXT PRIMARY KEY,
  needs_strategic_grounding REAL NOT NULL DEFAULT 0.0,
  posterior_alpha           REAL NOT NULL DEFAULT 1.0,
  posterior_beta            REAL NOT NULL DEFAULT 1.0,
  last_updated_ts           TEXT NOT NULL
);
`;

const INDEX_DDL =
  "CREATE INDEX IF NOT EXISTS idx_artifact_kind_metadata_needs_strategic ON artifact_kind_metadata(needs_strategic_grounding)";

// Legacy `atms_report_v*` prefix kinds that the strategy-first gate
// hard-coded pre-F4c. Seeded as `needs_strategic_grounding=1.0` with a
// high-prior Beta (α=10, β=1) so existing admission and closure tests
// stay green under the new abstraction. Everything else stays absent
// until owner-rejection feedback (or another posterior path) admits it.
const SEED_KINDS: ReadonlyArray<{
  artifact_kind: string;
  needs_strategic_grounding: number;
  posterior_alpha: number;
  posterior_beta: number;
}> = [
  { artifact_kind: "atms_report_v1",  needs_strategic_grounding: 1.0, posterior_alpha: 10, posterior_beta: 1 },
  { artifact_kind: "atms_report_v2",  needs_strategic_grounding: 1.0, posterior_alpha: 10, posterior_beta: 1 },
  { artifact_kind: "atms_report_v3",  needs_strategic_grounding: 1.0, posterior_alpha: 10, posterior_beta: 1 },
  { artifact_kind: "atms_report_v4",  needs_strategic_grounding: 1.0, posterior_alpha: 10, posterior_beta: 1 },
  { artifact_kind: "atms_report_v5",  needs_strategic_grounding: 1.0, posterior_alpha: 10, posterior_beta: 1 },
  { artifact_kind: "atms_report_v6",  needs_strategic_grounding: 1.0, posterior_alpha: 10, posterior_beta: 1 },
  { artifact_kind: "atms_report_v7",  needs_strategic_grounding: 1.0, posterior_alpha: 10, posterior_beta: 1 },
  { artifact_kind: "atms_report_v8",  needs_strategic_grounding: 1.0, posterior_alpha: 10, posterior_beta: 1 },
  { artifact_kind: "atms_report_v9",  needs_strategic_grounding: 1.0, posterior_alpha: 10, posterior_beta: 1 },
  { artifact_kind: "atms_report_v10", needs_strategic_grounding: 1.0, posterior_alpha: 10, posterior_beta: 1 },
  { artifact_kind: "atms_report_v11", needs_strategic_grounding: 1.0, posterior_alpha: 10, posterior_beta: 1 },
  { artifact_kind: "atms_report_v12", needs_strategic_grounding: 1.0, posterior_alpha: 10, posterior_beta: 1 },
  { artifact_kind: "atms_report_v13", needs_strategic_grounding: 1.0, posterior_alpha: 10, posterior_beta: 1 },
  // Generic version-less kind for historical bridge emit paths.
  { artifact_kind: "atms_report_v",   needs_strategic_grounding: 1.0, posterior_alpha: 10, posterior_beta: 1 },
];

/** Returns the canonical list of seeded kinds. Exposed for tests + the
 *  init-time seed surface (substrate/seed.ts seedArtifactKindMetadata). */
export const getSeedKindList = (): ReadonlyArray<{
  artifact_kind: string;
  needs_strategic_grounding: number;
  posterior_alpha: number;
  posterior_beta: number;
}> => SEED_KINDS;

/** Idempotently create the metadata table AND seed the legacy
 *  `atms_report_v*` rows. The seed is idempotent via INSERT OR IGNORE
 *  so a re-run on a populated DB is a no-op. Called from substrate/db.ts
 *  runMigrations so fresh installs and existing DBs both have it. The
 *  seed lives here (rather than in substrate/seed.ts) because the
 *  migration layer cannot import seed.ts without a circular dependency,
 *  and admission tests rely on the legacy prefix-kinds existing on a
 *  bare `openDb(":memory:")`. The substrate/seed.ts wrapper still
 *  re-runs the seed (idempotent) plus emits the audit event. */
export const ensureArtifactKindMetadataTable = (db: Database): void => {
  db.run(DDL);
  db.run(INDEX_DDL);
  const ts = new Date().toISOString();
  for (const row of SEED_KINDS) {
    db.run(
      `INSERT INTO artifact_kind_metadata
         (artifact_kind, needs_strategic_grounding, posterior_alpha, posterior_beta, last_updated_ts)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(artifact_kind) DO NOTHING`,
      [row.artifact_kind, row.needs_strategic_grounding, row.posterior_alpha, row.posterior_beta, ts],
    );
  }
};

const nowIso = (): string => new Date().toISOString();

/** Look up a single kind's metadata. Returns null when no row exists. */
export const getArtifactKindMetadata = (
  db: Database,
  artifact_kind: string,
): ArtifactKindMetadata | null => {
  if (typeof artifact_kind !== "string" || artifact_kind.length === 0) return null;
  const row = db
    .query<ArtifactKindMetadata, [string]>(
      `SELECT artifact_kind, needs_strategic_grounding, posterior_alpha,
              posterior_beta, last_updated_ts
         FROM artifact_kind_metadata WHERE artifact_kind = ? LIMIT 1`,
    )
    .get(artifact_kind);
  return row ?? null;
};

/** Returns true when EITHER input.kind OR input.name resolves to a
 *  metadata row whose `needs_strategic_grounding` exceeds the threshold.
 *  Used by the admission gate and the candidate screen so both sites
 *  agree on which artifacts require strategic-direction grounding.
 *
 *  The `name` arm exists for legacy candidates where the kind discriminator
 *  was empty but the name string carried the version marker. New code
 *  should set `kind`; the name arm is a behavior-preserving compatibility
 *  shim under the new abstraction. */
export const requiresStrategicGrounding = (
  db: Database,
  input: { kind?: string | null; name?: string | null },
): { required: boolean; matched_kind: string | null; needs_strategic_grounding: number } => {
  const candidates: string[] = [];
  if (typeof input.kind === "string" && input.kind.length > 0) candidates.push(input.kind);
  if (typeof input.name === "string" && input.name.length > 0) candidates.push(input.name);
  for (const c of candidates) {
    const meta = getArtifactKindMetadata(db, c);
    if (meta && meta.needs_strategic_grounding > STRATEGIC_GROUNDING_THRESHOLD) {
      return {
        required: true,
        matched_kind: meta.artifact_kind,
        needs_strategic_grounding: meta.needs_strategic_grounding,
      };
    }
  }
  return { required: false, matched_kind: null, needs_strategic_grounding: 0 };
};

/** Returns every artifact_kind whose `needs_strategic_grounding`
 *  posterior exceeds the threshold. Used by intent_classifier and
 *  strategy_first_closure_check to enumerate "kinds that need strategic
 *  grounding right now" without hard-coding any single prefix. */
export const listStrategicallyGroundedKinds = (db: Database): string[] => {
  try {
    const rows = db
      .query<{ artifact_kind: string }, [number]>(
        `SELECT artifact_kind FROM artifact_kind_metadata
          WHERE needs_strategic_grounding > ?
          ORDER BY artifact_kind ASC`,
      )
      .all(STRATEGIC_GROUNDING_THRESHOLD);
    return rows.map((r) => r.artifact_kind);
  } catch {
    // Defensive: pre-migration DBs may not have the table yet.
    return [];
  }
};

const recomputeMean = (alpha: number, beta: number): number => {
  const denom = alpha + beta;
  if (denom <= 0) return 0;
  return alpha / denom;
};

export type UpsertInput = {
  artifact_kind: string;
  needs_strategic_grounding?: number;
  posterior_alpha?: number;
  posterior_beta?: number;
};

/** Insert or replace a metadata row. The `last_updated_ts` is stamped
 *  here so callers do not need to thread a clock. Returns the new row. */
export const upsertArtifactKindMetadata = (
  db: Database,
  input: UpsertInput,
): ArtifactKindMetadata => {
  const alpha = input.posterior_alpha ?? 1.0;
  const beta = input.posterior_beta ?? 1.0;
  const mean =
    input.needs_strategic_grounding !== undefined
      ? input.needs_strategic_grounding
      : recomputeMean(alpha, beta);
  const ts = nowIso();
  db.run(
    `INSERT INTO artifact_kind_metadata
       (artifact_kind, needs_strategic_grounding, posterior_alpha, posterior_beta, last_updated_ts)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(artifact_kind) DO UPDATE SET
       needs_strategic_grounding = excluded.needs_strategic_grounding,
       posterior_alpha           = excluded.posterior_alpha,
       posterior_beta            = excluded.posterior_beta,
       last_updated_ts           = excluded.last_updated_ts`,
    [input.artifact_kind, mean, alpha, beta, ts],
  );
  return {
    artifact_kind: input.artifact_kind,
    needs_strategic_grounding: mean,
    posterior_alpha: alpha,
    posterior_beta: beta,
    last_updated_ts: ts,
  };
};

/** Owner-rejection feedback path. Increments `posterior_alpha` by
 *  `weight` (default 1.0), reduces `posterior_beta` toward neutral, and
 *  recomputes `needs_strategic_grounding` from the new Beta mean. Creates
 *  the row with priors (α=1, β=1) if it does not exist so the FIRST
 *  rejection is still credited. */
export const incrementStrategicGroundingPosterior = (
  db: Database,
  artifact_kind: string,
  weight: number = 1.0,
): ArtifactKindMetadata => {
  const existing = getArtifactKindMetadata(db, artifact_kind);
  const alpha = (existing?.posterior_alpha ?? 1.0) + weight;
  const beta = existing?.posterior_beta ?? 1.0;
  const mean = recomputeMean(alpha, beta);
  return upsertArtifactKindMetadata(db, {
    artifact_kind,
    needs_strategic_grounding: mean,
    posterior_alpha: alpha,
    posterior_beta: beta,
  });
};

const newEventId = (): string =>
  crypto.randomUUID().replace(/-/g, "").slice(0, 26).toUpperCase();

/** Owner-confirmation feedback wire. When the owner confirms a prior
 *  `lane_routing_refused` (reason `decorative_citation` or similar) was
 *  correct, call this with the refused kind: the posterior bumps and
 *  the substrate emits `artifact_kind_strategic_grounding_updated` so
 *  the change is auditable. Returns the new metadata row.
 *
 *  This is the F4c learning path: the catalog is otherwise empty and
 *  self-extends through use. */
export const recordOwnerConfirmedRefusal = (
  db: Database,
  params: {
    artifact_kind: string;
    weight?: number;
    refused_event_id?: string;
    owner_observation_event_id?: string;
  },
): ArtifactKindMetadata => {
  const previous = getArtifactKindMetadata(db, params.artifact_kind);
  const updated = incrementStrategicGroundingPosterior(
    db,
    params.artifact_kind,
    params.weight ?? 1.0,
  );
  const contextRefs: string[] = [];
  if (params.refused_event_id) contextRefs.push(params.refused_event_id);
  if (params.owner_observation_event_id) contextRefs.push(params.owner_observation_event_id);
  db.run(
    `INSERT INTO events (id, ts, directive_id, task_id, loop_id, substrate_origin, kind, payload, context_refs)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      newEventId(),
      updated.last_updated_ts,
      "system",
      "system",
      "system",
      "substrate_auto",
      "artifact_kind_strategic_grounding_updated",
      JSON.stringify({
        artifact_kind: params.artifact_kind,
        previous_score: previous?.needs_strategic_grounding ?? 0,
        new_score: updated.needs_strategic_grounding,
        previous_alpha: previous?.posterior_alpha ?? 1.0,
        new_alpha: updated.posterior_alpha,
        previous_beta: previous?.posterior_beta ?? 1.0,
        new_beta: updated.posterior_beta,
        source: "owner_confirmed_refusal",
        refused_event_id: params.refused_event_id ?? null,
        owner_observation_event_id: params.owner_observation_event_id ?? null,
      }),
      JSON.stringify(contextRefs),
    ],
  );
  return updated;
};
