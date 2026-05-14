// acc2 artifact store — CRUD + posterior update + LATM promotion / quarantine
// thresholds for the `code_artifact` table (v2-design.md §11.4, §11.5, §11.6).
//
// Posterior model:
//   - Beta(α, β) with α + β = total observations.
//   - residual ≤ 0.3 counts as a "success": α += (1 − residual/0.3) ≈ 1 when
//     residual is 0, 0 at the band boundary.
//   - residual ≥ 0.7 counts as a "failure": β += (residual − 0.7)/0.3 ≈ 1 when
//     residual is 1, 0 at the band boundary.
//   - Mid-band 0.3 < residual < 0.7 contributes proportionally to both — α
//     and β each grow by a fraction so the posterior tracks the
//     informativeness of the observation without forcing it to a discrete
//     win/loss.
//
// EMA of residual: half-life N = 20 events → decay = 0.5^(1/N). New
// `recent_residual_mean` = decay × old + (1 − decay) × new_residual.
//
// LATM promotion threshold (v2-design.md §11.5):
//     score ≥ 0.85  AND  confidence ≥ 0.7  AND  total_invocations ≥ 20.
//
// Quarantine (v2-design.md §11.6):
//     recent_residual_mean > 0.6  AND  total_invocations ≥ 10
//   OR ≥ 5 consecutive `sandbox_violation` events for this artifact in the
//     events table.
//
// Idempotency: maybePromote/maybeQuarantine return `true` only on the
// transition (status change). Subsequent calls with the same status return
// `false` and emit nothing. Promotion is one-way in Phase C — rehabilitation
// is Phase H.

import type { Database } from "bun:sqlite";
import type { CodeArtifactStatus, JsonValue, Runtime, SandboxDecl } from "../substrate/types";
import { newId, nowIso } from "./ids";
import type { EmitEventInput } from "./events";

export type CodeArtifactRow = {
  id: string;
  runtime: Runtime;
  body: string;
  declaredSandbox: SandboxDecl;
  stateRoot: string | null;
  posteriorAlpha: number;
  posteriorBeta: number;
  score: number;
  confidence: number;
  recentResidualMean: number;
  recentKillCount: number;
  status: CodeArtifactStatus;
  name: string | null;
  fixtureInput: JsonValue | null;
  fixtureExpectedResidual: number | null;
  createdAt: string;
  updatedAt: string;
};

export type InsertArtifactInput = Omit<CodeArtifactRow, "createdAt" | "updatedAt" | "id"> & {
  id?: string;
};

// ── EMA / scoring helpers ──────────────────────────────────────────

const EMA_HALF_LIFE_EVENTS = 20;
const EMA_DECAY = Math.pow(0.5, 1 / EMA_HALF_LIFE_EVENTS);

const PROMOTION_SCORE_THRESHOLD = 0.85;
const PROMOTION_CONFIDENCE_THRESHOLD = 0.7;
const PROMOTION_INVOCATION_THRESHOLD = 20;

const QUARANTINE_RESIDUAL_THRESHOLD = 0.6;
const QUARANTINE_MIN_INVOCATIONS = 10;
const QUARANTINE_VIOLATION_THRESHOLD = 5;

const SUCCESS_BAND = 0.3;
const FAILURE_BAND = 0.7;

const recomputeScore = (alpha: number, beta: number): number => alpha / (alpha + beta);
const recomputeConfidence = (alpha: number, beta: number): number => {
  const n = alpha + beta;
  return 1 - 1 / Math.sqrt(n + 1);
};

const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));

// ── Row mapping ────────────────────────────────────────────────────

const mapRow = (raw: Record<string, unknown>): CodeArtifactRow => ({
  id: raw.id as string,
  runtime: raw.runtime as Runtime,
  body: raw.body as string,
  declaredSandbox: JSON.parse(raw.declared_sandbox as string) as SandboxDecl,
  stateRoot: (raw.state_root as string | null) ?? null,
  posteriorAlpha: raw.posterior_alpha as number,
  posteriorBeta: raw.posterior_beta as number,
  score: raw.score as number,
  confidence: raw.confidence as number,
  recentResidualMean: raw.recent_residual_mean as number,
  recentKillCount: raw.recent_kill_count as number,
  status: raw.status as CodeArtifactStatus,
  name: (raw.name as string | null) ?? null,
  fixtureInput: JSON.parse((raw.fixture_input as string) ?? "null") as JsonValue | null,
  fixtureExpectedResidual: (raw.fixture_expected_residual as number | null) ?? null,
  createdAt: raw.created_at as string,
  updatedAt: raw.updated_at as string,
});

// ── CRUD ────────────────────────────────────────────────────────────

/** Insert a new code_artifact row. The caller supplies the posterior priors
 *  (alpha/beta) directly so admission can seed (0.5, 0.3) — the store does
 *  not back-compute them. id is generated unless caller passes one. */
export const insertArtifact = (db: Database, input: InsertArtifactInput): CodeArtifactRow => {
  const id = input.id ?? newId();
  const ts = nowIso();
  const stateRoot = input.stateRoot ?? "";
  db.run(
    `INSERT INTO code_artifact (
       id, runtime, body, declared_sandbox, state_root,
       posterior_alpha, posterior_beta, score, confidence,
       recent_residual_mean, recent_kill_count, status, name,
       fixture_input, fixture_expected_residual,
       created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.runtime,
      input.body,
      JSON.stringify(input.declaredSandbox),
      stateRoot,
      input.posteriorAlpha,
      input.posteriorBeta,
      input.score,
      input.confidence,
      input.recentResidualMean,
      input.recentKillCount,
      input.status,
      input.name,
      JSON.stringify(input.fixtureInput ?? null),
      input.fixtureExpectedResidual ?? 0,
      ts,
      ts,
    ],
  );
  return getArtifact(db, id) as CodeArtifactRow;
};

export const getArtifact = (db: Database, id: string): CodeArtifactRow | null => {
  const row = db.query("SELECT * FROM code_artifact WHERE id = ?").get(id) as Record<string, unknown> | null;
  if (!row) return null;
  return mapRow(row);
};

export const listArtifactsByRuntime = (
  db: Database,
  runtime: Runtime,
  limit = 100,
): CodeArtifactRow[] => {
  const rows = db
    .query(
      "SELECT * FROM code_artifact WHERE runtime = ? ORDER BY score DESC, updated_at DESC LIMIT ?",
    )
    .all(runtime, limit) as Array<Record<string, unknown>>;
  return rows.map(mapRow);
};

// ── Posterior update ───────────────────────────────────────────────

/** Apply a single action_scored outcome to an artifact's posterior + EMA.
 *  Returns the refreshed row. residual is clamped to [0,1] defensively. */
export const applyResidualOutcome = (
  db: Database,
  artifactId: string,
  residual: number,
  ts: string,
): CodeArtifactRow => {
  const row = getArtifact(db, artifactId);
  if (!row) throw new Error(`code_artifact_not_found:${artifactId}`);
  const r = clamp01(residual);

  // Discretise into success/failure bands plus a mid-band that contributes
  // proportionally to both. The bands meet at 0.3 and 0.7 so the algebra is
  // continuous; outside the bands one side dominates.
  let alphaDelta = 0;
  let betaDelta = 0;
  if (r <= SUCCESS_BAND) {
    alphaDelta = 1 - r / SUCCESS_BAND;
  } else if (r >= FAILURE_BAND) {
    betaDelta = (r - FAILURE_BAND) / (1 - FAILURE_BAND);
  } else {
    // Linear interpolation across the mid-band.
    const t = (r - SUCCESS_BAND) / (FAILURE_BAND - SUCCESS_BAND);
    alphaDelta = (1 - t) * 0.5; // taper from 0.5 → 0 across mid-band
    betaDelta = t * 0.5;        // taper from 0 → 0.5 across mid-band
  }

  const newAlpha = row.posteriorAlpha + alphaDelta;
  const newBeta = row.posteriorBeta + betaDelta;
  const newScore = recomputeScore(newAlpha, newBeta);
  const newConfidence = recomputeConfidence(newAlpha, newBeta);
  const newEma = EMA_DECAY * row.recentResidualMean + (1 - EMA_DECAY) * r;

  db.run(
    `UPDATE code_artifact SET
       posterior_alpha = ?, posterior_beta = ?,
       score = ?, confidence = ?,
       recent_residual_mean = ?,
       updated_at = ?
     WHERE id = ?`,
    [newAlpha, newBeta, newScore, newConfidence, newEma, ts, artifactId],
  );
  return getArtifact(db, artifactId) as CodeArtifactRow;
};

// ── Promotion / quarantine ─────────────────────────────────────────

const synthesizeName = (row: CodeArtifactRow): string => {
  // First-comment heuristic: look for `//` or `#` on the first non-empty line.
  const lines = row.body.split(/\r?\n/);
  for (const ln of lines) {
    const trimmed = ln.trim();
    if (trimmed.length === 0) continue;
    const m = trimmed.match(/^(?:\/\/+|#+)\s*([^\n]+)/);
    if (m && m[1]) {
      return m[1].trim().slice(0, 80).replace(/[^a-zA-Z0-9 _-]/g, "_");
    }
    break;
  }
  return `auto_${row.id.slice(-8)}`;
};

const countInvocations = (row: CodeArtifactRow): number => row.posteriorAlpha + row.posteriorBeta - 2;

/** Promote an admitted artifact whose posterior crossed the threshold.
 *  Emits a `code_artifact_promoted` event via `emit` and stamps a name on
 *  the row if it didn't have one. Returns `true` if the row transitioned
 *  from 'admitted' to 'promoted'; `false` otherwise. */
export const maybePromote = (
  db: Database,
  artifactId: string,
  emit: (event: EmitEventInput) => void,
): boolean => {
  const row = getArtifact(db, artifactId);
  if (!row) return false;
  if (row.status !== "admitted") return false;

  const invocations = countInvocations(row);
  if (
    row.score < PROMOTION_SCORE_THRESHOLD ||
    row.confidence < PROMOTION_CONFIDENCE_THRESHOLD ||
    invocations < PROMOTION_INVOCATION_THRESHOLD
  ) {
    return false;
  }

  const name = row.name ?? synthesizeName(row);
  const ts = nowIso();
  db.run(
    "UPDATE code_artifact SET status = ?, name = ?, updated_at = ? WHERE id = ?",
    ["promoted", name, ts, artifactId],
  );
  emit({
    kind: "code_artifact_promoted",
    substrate_origin: "substrate_auto",
    action_artifact_id: artifactId,
    payload: {
      artifact_id: artifactId,
      name,
      score: row.score,
      confidence: row.confidence,
      invocations,
    } as JsonValue,
  });
  return true;
};

/** Count consecutive `sandbox_violation` events for an artifact, walking
 *  backwards in time from the most recent event. Stops at the first non-
 *  violation row for the artifact. */
const consecutiveViolations = (db: Database, artifactId: string): number => {
  const rows = db
    .query(
      `SELECT kind FROM events
       WHERE action_artifact_id = ? AND kind IN ('sandbox_violation','artifact_observed')
       ORDER BY ts DESC LIMIT 50`,
    )
    .all(artifactId) as Array<{ kind: string }>;
  let count = 0;
  for (const r of rows) {
    if (r.kind === "sandbox_violation") {
      count++;
    } else {
      break;
    }
  }
  return count;
};

/** Quarantine an artifact whose EMA crossed the threshold, OR which has
 *  emitted ≥ 5 consecutive `sandbox_violation` events. Emits
 *  `code_artifact_quarantined` on transition. */
export const maybeQuarantine = (
  db: Database,
  artifactId: string,
  emit: (event: EmitEventInput) => void,
): boolean => {
  const row = getArtifact(db, artifactId);
  if (!row) return false;
  if (row.status === "quarantined") return false;

  const invocations = countInvocations(row);
  const residualBreach =
    row.recentResidualMean > QUARANTINE_RESIDUAL_THRESHOLD &&
    invocations >= QUARANTINE_MIN_INVOCATIONS;
  const violationBreach = consecutiveViolations(db, artifactId) >= QUARANTINE_VIOLATION_THRESHOLD;

  if (!residualBreach && !violationBreach) return false;

  const ts = nowIso();
  db.run(
    "UPDATE code_artifact SET status = ?, updated_at = ? WHERE id = ?",
    ["quarantined", ts, artifactId],
  );
  emit({
    kind: "code_artifact_quarantined",
    substrate_origin: "substrate_auto",
    action_artifact_id: artifactId,
    payload: {
      artifact_id: artifactId,
      reason: residualBreach ? "residual_mean_exceeded" : "consecutive_sandbox_violations",
      recent_residual_mean: row.recentResidualMean,
      consecutive_violations: violationBreach ? consecutiveViolations(db, artifactId) : 0,
      invocations,
    } as JsonValue,
  });
  return true;
};
