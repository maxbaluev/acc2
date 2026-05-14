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
//     recent_residual_mean > 0.7  AND  total_invocations ≥ 5
//   OR `recent_kill_count` ≥ 3 (column-backed; incremented by the runtime
//      supervisor on hard_killed/orphaned subprocesses).
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

// Quarantine thresholds (v2-design.md §11.6). Defaults are tuned for fast
// detection of regressions; the env knobs let operators dial in per-deploy
// sensitivity without code edits.
const DEFAULT_QUARANTINE_RESIDUAL_THRESHOLD = 0.7;
const DEFAULT_QUARANTINE_MIN_OBSERVATIONS = 5;
const DEFAULT_QUARANTINE_KILL_COUNT_THRESHOLD = 3;
const QUARANTINE_VIOLATION_THRESHOLD = 5;

const quarantineResidualThreshold = (): number => {
  const raw = process.env.ACC2_QUARANTINE_RESIDUAL_THRESHOLD;
  if (raw === undefined || raw === "") return DEFAULT_QUARANTINE_RESIDUAL_THRESHOLD;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 1) return DEFAULT_QUARANTINE_RESIDUAL_THRESHOLD;
  return parsed;
};

const quarantineMinObservations = (): number => {
  const raw = process.env.ACC2_QUARANTINE_MIN_OBSERVATIONS;
  if (raw === undefined || raw === "") return DEFAULT_QUARANTINE_MIN_OBSERVATIONS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_QUARANTINE_MIN_OBSERVATIONS;
  return Math.floor(parsed);
};

const quarantineKillCountThreshold = (): number => {
  const raw = process.env.ACC2_QUARANTINE_KILL_COUNT_THRESHOLD;
  if (raw === undefined || raw === "") return DEFAULT_QUARANTINE_KILL_COUNT_THRESHOLD;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_QUARANTINE_KILL_COUNT_THRESHOLD;
  return Math.floor(parsed);
};

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

/** Quarantine an artifact whose EMA crossed the residual threshold, whose
 *  recent_kill_count crossed the kill-count threshold, OR which has
 *  emitted ≥ 5 consecutive `sandbox_violation` events. Idempotent — calling
 *  on an already-quarantined artifact is a no-op. Emits
 *  `code_artifact_quarantined` on transition with the triggering reason. */
export const maybeQuarantine = (
  db: Database,
  artifactId: string,
  emit: (event: EmitEventInput) => void,
): boolean => {
  const row = getArtifact(db, artifactId);
  if (!row) return false;
  if (row.status === "quarantined") return false;

  const residualThreshold = quarantineResidualThreshold();
  const minObservations = quarantineMinObservations();
  const killCountThreshold = quarantineKillCountThreshold();

  const invocations = countInvocations(row);
  const residualBreach =
    row.recentResidualMean > residualThreshold && invocations >= minObservations;
  const killBreach = row.recentKillCount >= killCountThreshold;
  const violationBreach = consecutiveViolations(db, artifactId) >= QUARANTINE_VIOLATION_THRESHOLD;

  if (!residualBreach && !killBreach && !violationBreach) return false;

  const reason = residualBreach
    ? "residual_mean_exceeded"
    : killBreach
      ? "kill_count_exceeded"
      : "consecutive_sandbox_violations";

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
      reason,
      recent_residual_mean: row.recentResidualMean,
      recent_kill_count: row.recentKillCount,
      consecutive_violations: violationBreach ? consecutiveViolations(db, artifactId) : 0,
      invocations,
      threshold_residual: residualThreshold,
      threshold_kill_count: killCountThreshold,
      min_observations: minObservations,
    } as JsonValue,
  });
  return true;
};

// ── Rehabilitation (Phase H — v2-design.md §11.6) ──────────────────
//
// Quarantined artifacts can re-enter `admitted` status after:
//   (a) 14-day cooldown elapsed since the latest `code_artifact_quarantined` event,
//   (b) the admission fixture re-passes,
//   (c) ≥ 10 controlled fixture invocations succeed in sequence.
//
// (c) is approximated: the rehabilitation flow runs the stored fixture 10
// times via the appropriate runtime (bun / uv / camofox) and ALL ten must
// return residual below the artifact's admission threshold. The runtime
// runner is injected so tests can substitute a deterministic stub.

const REHABILITATION_COOLDOWN_MS = 14 * 24 * 60 * 60 * 1000;
const REHABILITATION_CONTROLLED_INVOCATIONS = 10;

export type RehabFixtureRunner = (artifactId: string) => Promise<{ ok: boolean; residual: number }>;

export type RehabResult =
  | { rehabilitated: true; controlledRuns: number }
  | { rehabilitated: false; reason: "not_quarantined" | "cooldown_pending" | "fixture_run_failed" | "fixture_residual_too_high"; detail?: string };

/** Read the latest `code_artifact_quarantined` event ts for an artifact. */
const latestQuarantineTs = (db: Database, artifactId: string): string | null => {
  const row = db
    .query(
      `SELECT ts FROM events
       WHERE action_artifact_id = ? AND kind = 'code_artifact_quarantined'
       ORDER BY ts DESC LIMIT 1`,
    )
    .get(artifactId) as { ts: string } | null;
  return row?.ts ?? null;
};

/** Per v2-design.md §11.6: a quarantined artifact may re-enter `admitted`
 *  status after the 14-day cooldown elapses, the admission fixture
 *  re-passes, and 10 controlled fixture invocations all return residual
 *  below the artifact's admission threshold. The runner closure is
 *  injected so callers wire it to the appropriate runtime; tests pass a
 *  deterministic stub. Emits `code_artifact_rehabilitated` on transition. */
export const maybeRehabilitate = async (
  db: Database,
  artifactId: string,
  runner: RehabFixtureRunner,
  emit: (event: EmitEventInput) => void,
  opts?: { nowMs?: number },
): Promise<RehabResult> => {
  const row = getArtifact(db, artifactId);
  if (!row) return { rehabilitated: false, reason: "not_quarantined", detail: "artifact_not_found" };
  if (row.status !== "quarantined") {
    return { rehabilitated: false, reason: "not_quarantined" };
  }
  const quarantinedAt = latestQuarantineTs(db, artifactId);
  if (!quarantinedAt) {
    return { rehabilitated: false, reason: "not_quarantined", detail: "quarantine_event_missing" };
  }
  const now = opts?.nowMs ?? Date.now();
  const elapsed = now - new Date(quarantinedAt).getTime();
  if (elapsed < REHABILITATION_COOLDOWN_MS) {
    return {
      rehabilitated: false,
      reason: "cooldown_pending",
      detail: `${Math.floor(elapsed / 86_400_000)}d/14d`,
    };
  }

  // Run the admission fixture once. Subsequent runs constitute the
  // controlled-invocation gate — the spec says "≥ 10 controlled fixture
  // invocations succeed" so we run 10 total iterations, all of which must
  // pass. We collapse "admission fixture re-passes" with the first of the
  // 10 controlled runs (the spec's two clauses are the same fixture
  // executed under the same constraints).
  const threshold = row.fixtureExpectedResidual ?? 0.2;
  for (let i = 0; i < REHABILITATION_CONTROLLED_INVOCATIONS; i++) {
    const outcome = await runner(artifactId);
    if (!outcome.ok) {
      return {
        rehabilitated: false,
        reason: "fixture_run_failed",
        detail: `attempt_${i + 1}_of_${REHABILITATION_CONTROLLED_INVOCATIONS}`,
      };
    }
    if (outcome.residual >= threshold) {
      return {
        rehabilitated: false,
        reason: "fixture_residual_too_high",
        detail: `attempt_${i + 1}_residual_${outcome.residual.toFixed(3)}_threshold_${threshold.toFixed(3)}`,
      };
    }
  }

  const ts = nowIso();
  db.run(
    "UPDATE code_artifact SET status = ?, updated_at = ? WHERE id = ?",
    ["admitted", ts, artifactId],
  );
  emit({
    kind: "code_artifact_rehabilitated",
    substrate_origin: "substrate_auto",
    action_artifact_id: artifactId,
    payload: {
      artifact_id: artifactId,
      quarantined_at: quarantinedAt,
      cooldown_ms: elapsed,
      controlled_runs: REHABILITATION_CONTROLLED_INVOCATIONS,
    } as JsonValue,
  });
  return { rehabilitated: true, controlledRuns: REHABILITATION_CONTROLLED_INVOCATIONS };
};

/** List quarantined artifacts whose latest quarantine event is older than
 *  the cooldown window. The daemon's rehabilitation worker tick consumes
 *  this. */
export const listRehabilitationCandidates = (db: Database, nowMs?: number): CodeArtifactRow[] => {
  const ts = new Date((nowMs ?? Date.now()) - REHABILITATION_COOLDOWN_MS).toISOString();
  const rows = db
    .query(
      `SELECT ca.* FROM code_artifact ca
       WHERE ca.status = 'quarantined'
         AND EXISTS (
           SELECT 1 FROM events e
           WHERE e.action_artifact_id = ca.id
             AND e.kind = 'code_artifact_quarantined'
             AND e.ts <= ?
         )`,
    )
    .all(ts) as Array<Record<string, unknown>>;
  return rows.map(mapRow);
};

export const REHABILITATION_COOLDOWN_MS_FOR_TEST = REHABILITATION_COOLDOWN_MS;
export const REHABILITATION_CONTROLLED_INVOCATIONS_FOR_TEST = REHABILITATION_CONTROLLED_INVOCATIONS;

/** Daemon-side rehabilitation tick. Scans quarantined artifacts past their
 *  14-day cooldown and attempts rehabilitation via the supplied runner.
 *  Production default: ON. Tests opt-OUT via
 *  `ACC2_DISABLE_WORKERS=rehabilitation` (set in tests/preload.ts) so the
 *  unit suite does not run controlled fixture invocations as a side
 *  effect. Returns the per-artifact outcome list so callers can log /
 *  surface telemetry. */
export const rehabilitationWorkerTick = async (
  db: Database,
  runner: RehabFixtureRunner,
  emit: (event: EmitEventInput) => void,
  opts?: { nowMs?: number; maxArtifacts?: number },
): Promise<Array<{ artifact_id: string; result: RehabResult }>> => {
  const candidates = listRehabilitationCandidates(db, opts?.nowMs);
  const cap = opts?.maxArtifacts ?? candidates.length;
  const out: Array<{ artifact_id: string; result: RehabResult }> = [];
  for (const c of candidates.slice(0, cap)) {
    const result = await maybeRehabilitate(db, c.id, runner, emit, { nowMs: opts?.nowMs });
    out.push({ artifact_id: c.id, result });
  }
  return out;
};
