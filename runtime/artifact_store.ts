// acc2 artifact store — CRUD + posterior update + LATM promotion / quarantine
// thresholds for the `act_artifact` table (Architecture.md, §11.5, §11.6).
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
// LATM promotion threshold (Architecture.md):
//     score ≥ 0.85  AND  confidence ≥ 0.7  AND  total_invocations ≥ 20.
//
// Quarantine (Architecture.md):
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
import type { ActArtifactStatus, ArtifactInterfaceMetadata, JsonValue, Runtime, SandboxDecl } from "../substrate/types";
import { newId, nowIso } from "./ids";
import type { EmitEventInput } from "./events";
import { emitEvent } from "./events";
import { parseResourceRefs, repoTargetFilesFromResources, resourcesFromTargetFiles, type ResourceRef } from "./resource_uri";
import { betaMean, betaStreamConfidence, residualToBetaDeltas } from "./posterior";
import { resolveArtifactId } from "../substrate/migration_runner";

export type ActArtifactRow = {
  id: string;
  /** Path A (2026-05-20, contract A0DQT211JH): nullable for non-executing
   *  data-class rows. Executable rows carry a concrete Runtime string. */
  runtime: Runtime | null;
  /** Free-string discriminator for the row's purpose. Schema default is
   *  `runtime_action`; typed rows declare their own (e.g.
   *  `dispatch_strategy_v1`, `published_drive_doc`). Historical rows
   *  authored before the L8 rename may carry `code_artifact`; mapRow
   *  preserves whatever is stored. See schema.sql:86. */
  kind: string;
  body: string;
  /** Path A: nullable for data-class rows (no executable semantics). */
  declaredSandbox: SandboxDecl | null;
  stateRoot: string | null;
  posteriorAlpha: number;
  posteriorBeta: number;
  score: number;
  confidence: number;
  recentResidualMean: number;
  recentKillCount: number;
  status: ActArtifactStatus;
  name: string | null;
  fixtureInput: JsonValue | null;
  fixtureExpectedResidual: number | null;
  // Brain dataflow audit bxdhdkm9e #3 (2026-05-15): provenance + intent.
  // Why the artifact exists, what it touches, which candidate produced
  // it, and which owner gate (if any) approved it. NULL for legacy
  // seed artifacts pre-dating these fields.
  intent: string | null;
  summary: string | null;
  targetFiles: string[] | null;
  targetResources: ResourceRef[] | null;
  sourceCandidateId: string | null;
  ownerGateVerdict: "auto" | "owner_approved" | "owner_rejected" | null;
  // C5 (2026-05-18, contract HJJS1665H961B2SRYHC5J85D14): provenance
  // chain. supersedes / supersededBy reference prior/successor
  // artifact_ids (both nullable). lostVersionCount annotates partial
  // backfill placeholders for artifacts whose external resource was
  // destructively trashed without a substrate chain.
  supersedes: string | null;
  supersededBy: string | null;
  lostVersionCount: number;
  // UNIVERSAL_ (2026-05-24, directive 3XETJCYT, kc BD86CJ6HQS): first-
  // class, domain-NEUTRAL interface metadata so the substrate + brain can
  // understand WHAT an artifact does, WHEN to use it, and HOW to call it
  // for ANY goal (Telegram action, browser flow, calendar handle,
  // checklist, contact, script). Persisted as one nullable JSON column;
  // NULL for legacy rows (backward-compatible).
  interfaceMetadata: ArtifactInterfaceMetadata | null;
  createdAt: string;
  updatedAt: string;
};

export type InsertArtifactInput = Omit<
  ActArtifactRow,
  | "createdAt"
  | "updatedAt"
  | "id"
  | "targetResources"
  | "supersedes"
  | "supersededBy"
  | "lostVersionCount"
  | "kind"
  | "intent"
  | "summary"
  | "targetFiles"
  | "sourceCandidateId"
  | "ownerGateVerdict"
  | "interfaceMetadata"
> & {
  id?: string;
  /** Optional kind discriminator. Defaults to `runtime_action` on
   *  insert when omitted (matches the schema default). */
  kind?: string;
  /** Provenance / intent fields default to NULL on insert when omitted
   *  (matches the schema default and the legacy-seed semantics). */
  intent?: string | null;
  summary?: string | null;
  targetFiles?: string[] | null;
  sourceCandidateId?: string | null;
  ownerGateVerdict?: ActArtifactRow["ownerGateVerdict"];
  targetResources?: ResourceRef[] | string[] | null;
  supersedes?: string | null;
  supersededBy?: string | null;
  lostVersionCount?: number | null;
  /** UNIVERSAL_ (2026-05-24): domain-neutral interface descriptor.
   *  Defaults to NULL on insert when omitted (legacy-seed semantics). */
  interfaceMetadata?: ArtifactInterfaceMetadata | null;
};

// ── EMA / scoring helpers ──────────────────────────────────────────

const EMA_HALF_LIFE_EVENTS = 20;
const EMA_DECAY = Math.pow(0.5, 1 / EMA_HALF_LIFE_EVENTS);

const PROMOTION_SCORE_THRESHOLD = 0.85;
const PROMOTION_CONFIDENCE_THRESHOLD = 0.7;
const PROMOTION_INVOCATION_THRESHOLD = 20;

// Quarantine thresholds (Architecture.md). Defaults are tuned for fast
// detection of regressions; the env knobs let operators dial in per-deploy
// sensitivity without code edits.
// Universal threshold values — pending f13 adaptive-scoring contract
// (GEZ955QDYN3R): each of these should learn from observed
// false-quarantine vs. true-kill correlation, not be env-tuned. No
// production operator ever overrode them.
const QUARANTINE_RESIDUAL_THRESHOLD = 0.7;
const QUARANTINE_MIN_OBSERVATIONS = 5;
const QUARANTINE_KILL_COUNT_THRESHOLD = 3;
const QUARANTINE_VIOLATION_THRESHOLD = 5;

const quarantineResidualThreshold = (): number => QUARANTINE_RESIDUAL_THRESHOLD;
const quarantineMinObservations = (): number => QUARANTINE_MIN_OBSERVATIONS;
const quarantineKillCountThreshold = (): number => QUARANTINE_KILL_COUNT_THRESHOLD;

// Canonical Beta math lives in `runtime/posterior.ts`; the local
// aliases preserve the call-site names so the surrounding diff stays
// minimal. `recomputeScore` = `betaMean`; `recomputeConfidence` is the
// stream-form variant (`1 − 1/√(α + β + 1)`), the same shape used in
// `runtime/credit.ts` for residual-stream updates.
const recomputeScore = betaMean;
const recomputeConfidence = betaStreamConfidence;

const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));

// ── Row mapping ────────────────────────────────────────────────────

const parseStringArray = (raw: unknown): string[] | null => {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "string" || raw === "") return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : null;
  } catch { return null; }
};

/** UNIVERSAL_ (2026-05-24): parse the nullable JSON `interface_metadata`
 *  column. Backward-compatible — NULL / empty / malformed JSON all decode
 *  to null so legacy rows (and rows written before the column existed)
 *  read cleanly without throwing. The descriptor is an open-ended
 *  payload, so we trust whatever JSON object is stored (free-string fields
 *  per Architecture.md "add capability vocabulary by admitting payload"). */
const parseInterfaceMetadata = (raw: unknown): ArtifactInterfaceMetadata | null => {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "string" || raw === "") return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as ArtifactInterfaceMetadata;
    }
    return null;
  } catch { return null; }
};

const mapRow = (raw: Record<string, unknown>): ActArtifactRow => ({
  id: raw.id as string,
  runtime: (raw.runtime as Runtime | null) ?? null,
  kind: ((raw.kind as string | null) ?? "code_artifact"),
  body: raw.body as string,
  declaredSandbox: (() => {
    const ds = raw.declared_sandbox as string | null | undefined;
    if (ds === null || ds === undefined) return null;
    try { return JSON.parse(ds) as SandboxDecl; } catch { return null; }
  })(),
  stateRoot: (raw.state_root as string | null) ?? null,
  posteriorAlpha: raw.posterior_alpha as number,
  posteriorBeta: raw.posterior_beta as number,
  score: raw.score as number,
  confidence: raw.confidence as number,
  recentResidualMean: raw.recent_residual_mean as number,
  recentKillCount: raw.recent_kill_count as number,
  status: raw.status as ActArtifactStatus,
  name: (raw.name as string | null) ?? null,
  fixtureInput: (() => {
    const fi = raw.fixture_input as string | null | undefined;
    if (fi === null || fi === undefined) return null;
    try { return JSON.parse(fi) as JsonValue; } catch { return null; }
  })(),
  fixtureExpectedResidual: (raw.fixture_expected_residual as number | null) ?? null,
  intent: (raw.intent as string | null) ?? null,
  summary: (raw.summary as string | null) ?? null,
  targetFiles: parseStringArray(raw.target_files),
  targetResources: parseResourceRefs(raw.target_resources) ?? resourcesFromTargetFiles(parseStringArray(raw.target_files)),
  sourceCandidateId: (raw.source_candidate_id as string | null) ?? null,
  ownerGateVerdict: (raw.owner_gate_verdict as ActArtifactRow["ownerGateVerdict"]) ?? null,
  supersedes: (raw.supersedes as string | null) ?? null,
  supersededBy: (raw.superseded_by as string | null) ?? null,
  lostVersionCount: ((raw.lost_version_count as number | null) ?? 0),
  interfaceMetadata: parseInterfaceMetadata(raw.interface_metadata),
  createdAt: raw.created_at as string,
  updatedAt: raw.updated_at as string,
});

// ── CRUD ────────────────────────────────────────────────────────────

/** Insert a new act_artifact row. The caller supplies the posterior priors
 *  (alpha/beta) directly so admission can seed (0.5, 0.3) — the store does
 *  not back-compute them. id is generated unless caller passes one. */
export const insertArtifact = (db: Database, input: InsertArtifactInput): ActArtifactRow => {
  const id = input.id ?? newId();
  const ts = nowIso();
  // Path A (2026-05-20, contract A0DQT211JH): state_root nullable; do
  // not coerce undefined into "" (would mask data-class rows). Same for
  // declared_sandbox + fixture_input + fixture_expected_residual:
  // executable rows bind their JSON; data-class rows bind NULL.
  const stateRoot = input.stateRoot ?? null;
  const targetResources = parseResourceRefs(input.targetResources) ?? resourcesFromTargetFiles(input.targetFiles ?? null);
  const targetFiles = input.targetFiles ?? repoTargetFilesFromResources(targetResources);
  const declaredSandboxJson = input.declaredSandbox === null || input.declaredSandbox === undefined
    ? null
    : JSON.stringify(input.declaredSandbox);
  const fixtureInputJson = input.fixtureInput === null || input.fixtureInput === undefined
    ? null
    : JSON.stringify(input.fixtureInput);
  const fixtureExpected = input.fixtureExpectedResidual ?? null;
  // UNIVERSAL_ (2026-05-24): serialize the domain-neutral interface
  // descriptor to its nullable JSON column. Omitted → NULL (legacy-seed
  // semantics, backward-compatible).
  const interfaceMetadataJson = input.interfaceMetadata === null || input.interfaceMetadata === undefined
    ? null
    : JSON.stringify(input.interfaceMetadata);
  db.run(
    `INSERT INTO act_artifact (
       id, runtime, kind, body, declared_sandbox, state_root,
       posterior_alpha, posterior_beta, score, confidence,
       recent_residual_mean, recent_kill_count, status, name,
       fixture_input, fixture_expected_residual,
       intent, summary, target_files, target_resources, source_candidate_id, owner_gate_verdict,
       supersedes, superseded_by, lost_version_count, interface_metadata,
       created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.runtime ?? null,
      input.kind ?? "runtime_action",
      input.body,
      declaredSandboxJson,
      stateRoot,
      input.posteriorAlpha,
      input.posteriorBeta,
      input.score,
      input.confidence,
      input.recentResidualMean,
      input.recentKillCount,
      input.status,
      input.name,
      fixtureInputJson,
      fixtureExpected,
      input.intent ?? null,
      input.summary ?? null,
      targetFiles ? JSON.stringify(targetFiles) : null,
      targetResources ? JSON.stringify(targetResources.map((r) => r.uri)) : null,
      input.sourceCandidateId ?? null,
      input.ownerGateVerdict ?? null,
      input.supersedes ?? null,
      input.supersededBy ?? null,
      input.lostVersionCount ?? 0,
      interfaceMetadataJson,
      ts,
      ts,
    ],
  );
  return getArtifact(db, id) as ActArtifactRow;
};

export const getArtifact = (db: Database, id: string): ActArtifactRow | null => {
  // ALIAS_CHAI (directive 3XETJCYT): resolve OLD → CURRENT id through the
  // append-only act_artifact_aliased chain so a renamed handle (across
  // many version gaps) still finds its current row. Memoized + cycle-
  // refused inside resolveArtifactId; un-aliased ids resolve to themselves.
  // This is the canonical read seam — credit.ts, dispatch_decider.ts,
  // task_dispatcher.ts, render_pipeline.ts, artifact_provenance.ts, and
  // recipe_replay.ts all funnel their by-id lookups through here.
  const resolvedId = resolveArtifactId(db, id);
  const row = db.query("SELECT * FROM act_artifact WHERE id = ?").get(resolvedId) as Record<string, unknown> | null;
  if (!row) return null;
  return mapRow(row);
};

export type DeliverableGroundbaseRecord = {
  groundbaseArtifactId: string;
  currentBestArtifactId: string | null;
  lockedOutlineArtifactId: string | null;
  requirementsLedgerArtifactId: string | null;
  currentBestBody: string;
  lockedOutline: string;
  requirementsLedger: string[];
  satisfiedRequirementIds: string[];
  lineageArtifactIds: string[];
  evidenceEventIds: string[];
};

const parseJsonRecord = (raw: string): Record<string, unknown> => {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
};

const stringArray = (value: unknown): string[] => Array.isArray(value)
  ? value.filter((v): v is string => typeof v === "string" && v.trim().length > 0)
  : [];

/** Resolve the head of a supersedes lineage: follow superseded_by links from a
 *  starting artifact until none remains, returning the most-current row. This is
 *  the deliverable-compounding "current best" rule — the latest accepted version,
 *  not whichever id the groundbase pointer was first authored against. */
const resolveLineageHead = (db: Database, startId: string): ActArtifactRow | null => {
  let current = getArtifact(db, startId);
  const seen = new Set<string>();
  while (current && current.supersededBy && !seen.has(current.id)) {
    seen.add(current.id);
    const next = getArtifact(db, current.supersededBy);
    if (!next) break;
    current = next;
  }
  return current;
};

/** Collect the full supersedes lineage (oldest → newest) for a head artifact. */
const collectLineageIds = (db: Database, headId: string): string[] => {
  const chain: string[] = [];
  let cursor: ActArtifactRow | null = getArtifact(db, headId);
  const seen = new Set<string>();
  while (cursor && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    chain.push(cursor.id);
    cursor = cursor.supersedes ? getArtifact(db, cursor.supersedes) : null;
  }
  return chain.reverse();
};

/** Return the directive's latest deliverable groundbase, with artifact bodies
 *  dereferenced server-side so brain prompts never depend on sandboxed
 *  filesystem reads. Groundbase rows are data-class act_artifact entries:
 *  kind='deliverable_groundbase', target_resources containing
 *  ledger:directive/<id> (or state_root = directive id), body JSON containing
 *  current_best_artifact_id, locked_outline_artifact_id,
 *  requirements_ledger_artifact_id, and satisfied_requirement_ids. The
 *  current-best body is resolved through the supersedes lineage HEAD so the
 *  groundbase always reflects the most-current accepted version. */
export const readDeliverableGroundbase = (db: Database, directiveId: string): DeliverableGroundbaseRecord | null => {
  const row = db
    .query<{ id: string; body: string; source_candidate_id: string | null }, [string, string]>(
      `SELECT id, body, source_candidate_id FROM act_artifact
        WHERE kind = 'deliverable_groundbase'
          AND status IN ('admitted','promoted')
          AND (target_resources LIKE ? OR state_root = ?)
        ORDER BY updated_at DESC, rowid DESC
        LIMIT 1`,
    )
    .get(`%ledger:directive/${directiveId}%`, directiveId);
  if (!row) return null;
  const payload = parseJsonRecord(row.body);
  const currentBestPointer = typeof payload.current_best_artifact_id === "string" ? payload.current_best_artifact_id : null;
  const lockedOutlineArtifactId = typeof payload.locked_outline_artifact_id === "string" ? payload.locked_outline_artifact_id : null;
  const requirementsLedgerArtifactId = typeof payload.requirements_ledger_artifact_id === "string" ? payload.requirements_ledger_artifact_id : null;
  // Resolve the HEAD of the supersedes lineage — the most-current accepted body —
  // rather than whatever id the groundbase pointer was first authored against.
  const currentBest = currentBestPointer ? resolveLineageHead(db, currentBestPointer) : null;
  const currentBestArtifactId = currentBest?.id ?? currentBestPointer;
  const lockedOutline = lockedOutlineArtifactId ? getArtifact(db, lockedOutlineArtifactId) : null;
  const requirementsLedger = requirementsLedgerArtifactId ? getArtifact(db, requirementsLedgerArtifactId) : null;
  const parsedRequirements = requirementsLedger ? parseJsonRecord(requirementsLedger.body).requirements : payload.requirements;
  const lineageArtifactIds = currentBest
    ? collectLineageIds(db, currentBest.id)
    : stringArray(payload.lineage_artifact_ids ?? (currentBestArtifactId ? [currentBestArtifactId] : []));
  return {
    groundbaseArtifactId: row.id,
    currentBestArtifactId,
    lockedOutlineArtifactId,
    requirementsLedgerArtifactId,
    currentBestBody: currentBest?.body ?? "",
    lockedOutline: lockedOutline?.body ?? (typeof payload.locked_outline === "string" ? payload.locked_outline : ""),
    requirementsLedger: stringArray(parsedRequirements),
    satisfiedRequirementIds: stringArray(payload.satisfied_requirement_ids),
    lineageArtifactIds,
    evidenceEventIds: [row.source_candidate_id, currentBest?.sourceCandidateId, lockedOutline?.sourceCandidateId, requirementsLedger?.sourceCandidateId].filter((v): v is string => typeof v === "string"),
  };
};

export const listArtifactsByRuntime = (
  db: Database,
  runtime: Runtime,
  limit = 100,
): ActArtifactRow[] => {
  // Path A (2026-05-20, contract A0DQT211JH): exclude data-class rows
  // (runtime IS NULL). This selector is executable-only — invoking a
  // null-runtime row has no semantics.
  const rows = db
    .query(
      "SELECT * FROM act_artifact WHERE runtime IS NOT NULL AND runtime = ? ORDER BY score DESC, updated_at DESC LIMIT ?",
    )
    .all(runtime, limit) as Array<Record<string, unknown>>;
  return rows.map(mapRow);
};

// ── Posterior update ───────────────────────────────────────────────

// Time-decay half-life on Beta posteriors (2026-05-15). Old corroborations
// shouldn't outweigh fresh contradictions indefinitely — that locks an
// artifact's posterior into its early history. Apply an exponential decay
// to (alpha-1, beta-1) before adding the new delta so each prior
// observation halves its weight every POSTERIOR_HALF_LIFE_MS. The Beta
// shape is preserved (deltas still produce monotone score moves) but
// stale evidence gracefully ages out, letting recent reality dominate.
//
// alpha=1, beta=1 is the prior — those baselines stay fixed (we only
// decay the EVIDENCE accumulated on top of the prior).
const DEFAULT_POSTERIOR_HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const posteriorHalfLifeMs = (): number => DEFAULT_POSTERIOR_HALF_LIFE_MS;

const decayedEvidence = (currentEvidence: number, dtMs: number): number => {
  const halfLife = posteriorHalfLifeMs();
  if (halfLife <= 0 || dtMs <= 0) return currentEvidence;
  const decayFactor = Math.pow(0.5, dtMs / halfLife);
  return currentEvidence * decayFactor;
};

/** Re-export the canonical residual→Beta-delta band map from
 *  `runtime/posterior.ts` (P6 stage B moved the band algebra there to
 *  break the posterior↔artifact_store cycle). Kept as a named re-export
 *  here so existing importers (`runtime/credit.ts`,
 *  `runtime/recipe_replay.ts`, tests) that pull `residualToBetaDeltas`
 *  from artifact_store keep resolving without an import-site churn. */
export { residualToBetaDeltas };

/** Apply a single action_scored outcome to an artifact's posterior + EMA.
 *  Returns the refreshed row. residual is clamped to [0,1] defensively.
 *  Time-decay (2026-05-15): the accumulated alpha-1 + beta-1 evidence is
 *  exponentially decayed by the elapsed wall time since the last update
 *  (default half-life: 30 days) before the new delta lands. This stops
 *  ancient corroborations from outweighing fresh contradictions.
 *
 *  Hole 7 fix (2026-05-19): after the EMA / posterior write lands,
 *  `maybeQuarantine` runs automatically so every EMA mutation is
 *  paired with its demotion check. Before this change, the four
 *  `task_dispatcher.ts` fallback paths and the two `recipe_replay.ts`
 *  branches drove `recent_residual_mean` upward without ever calling
 *  `maybeQuarantine` — only `credit.distributeCredit` did. Result:
 *  `act_artifact_quarantined` events were structurally impossible to
 *  emit from the dispatcher fallbacks or recipe replay, even when
 *  artifacts crossed the residual + invocation thresholds. The fix
 *  binds the demotion gate to the same primitive that touches the
 *  EMA, restoring LATM cycle symmetry: every score-up can promote;
 *  every score-down can quarantine. Callers may pass a custom `emit`
 *  closure when they need event metadata (directive_id, task_id,
 *  …); omitted, the default emitter writes via `emitEvent(db, …)`
 *  directly so existing call sites get the wiring for free.
 *
 *  Weighted variant consolidation (per KC 81VSHW67Q51XZC683B2XTR79FR,
 *  cleanup audit batch 1): `opts.weight` scales the Beta posterior
 *  deltas. weight=1.0 (default) is the canonical unweighted path.
 *  weight>1.0 is the Shapley/LATM novelty-bonus credit path that used
 *  to live in `credit.ts:applyWeightedResidualOutcome`. When weight!==1.0
 *  the EMA blends the weighted residual with a neutral 0.5 background
 *  so a bonused observation cannot drive the EMA outside [0,1] and
 *  stays monotonic in evidence regardless of N. weight=1.0 preserves
 *  the raw-residual EMA update bit-for-bit. */
export const applyResidualOutcome = (
  db: Database,
  artifactId: string,
  residual: number,
  ts: string,
  emit?: (event: EmitEventInput) => void,
  opts?: { weight?: number },
): ActArtifactRow => {
  // ALIAS_CHAI: resolve OLD → CURRENT before the posterior write so credit
  // cited against a renamed id lands on the CURRENT row, not a phantom.
  // getArtifact already resolves for the read; we resolve the id we UPDATE
  // by so the write targets the same row.
  artifactId = resolveArtifactId(db, artifactId);
  const row = getArtifact(db, artifactId);
  if (!row) throw new Error(`act_artifact_not_found:${artifactId}`);
  const r = clamp01(residual);
  const weight = opts?.weight ?? 1.0;

  const { alphaDelta: rawAlphaDelta, betaDelta: rawBetaDelta } = residualToBetaDeltas(r);
  const alphaDelta = rawAlphaDelta * weight;
  const betaDelta  = rawBetaDelta  * weight;

  // Decay accumulated evidence (alpha-1, beta-1 — the prior stays fixed).
  const prevTs = Date.parse(row.updatedAt);
  const curTs = Date.parse(ts);
  const dtMs = Number.isFinite(prevTs) && Number.isFinite(curTs) ? Math.max(0, curTs - prevTs) : 0;
  const decayedAlphaEvidence = decayedEvidence(Math.max(0, row.posteriorAlpha - 1), dtMs);
  const decayedBetaEvidence  = decayedEvidence(Math.max(0, row.posteriorBeta  - 1), dtMs);
  const newAlpha = 1 + decayedAlphaEvidence + alphaDelta;
  const newBeta  = 1 + decayedBetaEvidence  + betaDelta;
  const newScore = recomputeScore(newAlpha, newBeta);
  const newConfidence = recomputeConfidence(newAlpha, newBeta);
  // EMA: weight=1.0 → raw residual (canonical). weight!==1.0 → blend the
  // weighted contribution with a neutral 0.5 background so a bonused
  // observation stays bounded and monotonic in evidence. weight is capped
  // at 1.0 inside the mix so values >1 produce a 100%-residual blend
  // (matching the prior credit.ts behavior).
  const wForEma = Math.min(1, weight);
  const emaContribution = weight === 1.0 ? r : r * wForEma + 0.5 * (1 - wForEma);
  const newEma = EMA_DECAY * row.recentResidualMean + (1 - EMA_DECAY) * emaContribution;

  db.run(
    `UPDATE act_artifact SET
       posterior_alpha = ?, posterior_beta = ?,
       score = ?, confidence = ?,
       recent_residual_mean = ?,
       updated_at = ?
     WHERE id = ?`,
    [newAlpha, newBeta, newScore, newConfidence, newEma, ts, artifactId],
  );

  // Hole 7 fix: pair every EMA mutation with the demotion check. The
  // default emitter writes through `emitEvent(db, …)` so callers that
  // don't supply one still get quarantine wiring (closing the LATM
  // cycle for the dispatcher fallbacks and recipe replay).
  const quarantineEmit = emit ?? ((event: EmitEventInput) => { emitEvent(db, event); });
  maybeQuarantine(db, artifactId, quarantineEmit);

  return getArtifact(db, artifactId) as ActArtifactRow;
};

// ── Promotion / quarantine ─────────────────────────────────────────

const synthesizeName = (row: ActArtifactRow): string => {
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

const countInvocations = (row: ActArtifactRow): number => row.posteriorAlpha + row.posteriorBeta - 2;

/** Promote an admitted artifact whose posterior crossed the threshold.
 *  Emits a `act_artifact_promoted` event via `emit` and stamps a name on
 *  the row if it didn't have one. Returns `true` if the row transitioned
 *  from 'admitted' to 'promoted'; `false` otherwise. */
export const maybePromote = (
  db: Database,
  artifactId: string,
  emit: (event: EmitEventInput) => void,
): boolean => {
  artifactId = resolveArtifactId(db, artifactId); // ALIAS_CHAI: write the CURRENT row
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
    "UPDATE act_artifact SET status = ?, name = ?, updated_at = ? WHERE id = ?",
    ["promoted", name, ts, artifactId],
  );
  emit({
    kind: "act_artifact_promoted",
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
 *  `act_artifact_quarantined` on transition with the triggering reason. */
export const maybeQuarantine = (
  db: Database,
  artifactId: string,
  emit: (event: EmitEventInput) => void,
): boolean => {
  artifactId = resolveArtifactId(db, artifactId); // ALIAS_CHAI: write the CURRENT row
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
    "UPDATE act_artifact SET status = ?, updated_at = ? WHERE id = ?",
    ["quarantined", ts, artifactId],
  );
  emit({
    kind: "act_artifact_quarantined",
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

// ── Hard-kill counter + terminal retirement (brain sandbox audit
//    bsfxsvgh9, 2026-05-15) ────────────────────────────────────────
//
// Pre-fix: recent_kill_count was a column on act_artifact but NO
// production code path incremented it on runtime_subprocess_hard_killed
// / artifact_observed hard_kill events. The kill-count quarantine gate
// (>= 3 kills triggers quarantine) was therefore dead — the artifact
// could be hard-killed indefinitely and stay admitted.
//
// recordArtifactKill: increments the counter, emits a structural
// `artifact_health_counter_updated` event for audit, and runs
// maybeQuarantine + maybeRetire so the artifact transitions
// status when thresholds breach. Idempotency: the increment is
// always recorded; the quarantine/retire transitions are no-ops on
// repeat.
//
// maybeRetire: terminal state. Unlike quarantine (rehabilitatable),
// retired artifacts are NEVER re-admitted. Triggers:
//   - recent_kill_count >= 10
//   - >= 3 prior act_artifact_quarantined events
//   - >= 3 irreversible_effect_recorded events without
//     owner_consent_event_id (in the last 24h)

const RETIRE_KILL_COUNT_THRESHOLD = 10;
const RETIRE_QUARANTINE_COUNT_THRESHOLD = 3;
const RETIRE_IRREVERSIBLE_COUNT_THRESHOLD = 3;
const RETIRE_IRREVERSIBLE_WINDOW_MS = 24 * 60 * 60 * 1000;

const countPriorQuarantines = (db: Database, artifactId: string): number => {
  // F4a: match both canonical and legacy kind strings so historical
  // events authored before the act_artifact rename still count.
  const row = db
    .query(
      `SELECT COUNT(*) AS n FROM events
       WHERE kind IN ('act_artifact_quarantined', 'code_artifact_quarantined')
         AND action_artifact_id = ?`,
    )
    .get(artifactId) as { n: number } | null;
  return row?.n ?? 0;
};

const countRecentIrreversibleWithoutConsent = (
  db: Database,
  artifactId: string,
  windowMs: number = RETIRE_IRREVERSIBLE_WINDOW_MS,
): number => {
  const cutoff = new Date(Date.now() - windowMs).toISOString();
  const rows = db
    .query(
      `SELECT payload FROM events
       WHERE kind = 'irreversible_effect_recorded'
         AND action_artifact_id = ?
         AND ts > ?`,
    )
    .all(artifactId, cutoff) as Array<{ payload: string }>;
  let n = 0;
  for (const r of rows) {
    try {
      const p = JSON.parse(r.payload ?? "{}") as Record<string, unknown>;
      if (!p.owner_consent_event_id) n++;
    } catch { /* malformed → count it (worst-case for the artifact, fail-closed) */ n++; }
  }
  return n;
};

/** Increment recent_kill_count and run downstream transitions. */
export const recordArtifactKill = (
  db: Database,
  artifactId: string,
  emit: (event: EmitEventInput) => void,
  reason: string,
): { newCount: number; quarantined: boolean; retired: boolean } => {
  artifactId = resolveArtifactId(db, artifactId); // ALIAS_CHAI: write the CURRENT row
  const row = getArtifact(db, artifactId);
  if (!row) return { newCount: 0, quarantined: false, retired: false };
  const newCount = row.recentKillCount + 1;
  const ts = nowIso();
  db.run(
    "UPDATE act_artifact SET recent_kill_count = ?, updated_at = ? WHERE id = ?",
    [newCount, ts, artifactId],
  );
  emit({
    kind: "artifact_health_counter_updated",
    substrate_origin: "substrate_auto",
    action_artifact_id: artifactId,
    payload: {
      artifact_id: artifactId,
      counter: "recent_kill_count",
      new_value: newCount,
      reason,
    } as JsonValue,
  });
  const quarantined = maybeQuarantine(db, artifactId, emit);
  const retired = maybeRetire(db, artifactId, emit);
  return { newCount, quarantined, retired };
};

/** Terminal retirement transition. Idempotent (no-op when already retired). */
export const maybeRetire = (
  db: Database,
  artifactId: string,
  emit: (event: EmitEventInput) => void,
): boolean => {
  artifactId = resolveArtifactId(db, artifactId); // ALIAS_CHAI: write the CURRENT row
  const row = getArtifact(db, artifactId);
  if (!row) return false;
  if (row.status === "retired") return false;

  const killExceeded = row.recentKillCount >= RETIRE_KILL_COUNT_THRESHOLD;
  const priorQuarantines = countPriorQuarantines(db, artifactId);
  const quarantinesExceeded = priorQuarantines >= RETIRE_QUARANTINE_COUNT_THRESHOLD;
  const irreversibleCount = countRecentIrreversibleWithoutConsent(db, artifactId);
  const irreversibleExceeded = irreversibleCount >= RETIRE_IRREVERSIBLE_COUNT_THRESHOLD;

  if (!killExceeded && !quarantinesExceeded && !irreversibleExceeded) return false;

  const reason = killExceeded
    ? "kill_count_terminal"
    : quarantinesExceeded
      ? "repeat_quarantines_terminal"
      : "irreversible_violations_terminal";

  const ts = nowIso();
  db.run(
    "UPDATE act_artifact SET status = ?, updated_at = ? WHERE id = ?",
    ["retired", ts, artifactId],
  );
  emit({
    kind: "act_artifact_retired",
    substrate_origin: "substrate_auto",
    action_artifact_id: artifactId,
    payload: {
      artifact_id: artifactId,
      reason,
      recent_kill_count: row.recentKillCount,
      prior_quarantines: priorQuarantines,
      recent_irreversible_without_consent: irreversibleCount,
    } as JsonValue,
  });
  return true;
};

// ── Rehabilitation (Phase H — Architecture.md) ──────────────────
//
// Quarantined artifacts can re-enter `admitted` status after:
//   (a) the cause-aware cooldown elapsed since the latest
//       `act_artifact_quarantined` event,
//   (b) the admission fixture re-passes,
//   (c) ≥ 10 controlled fixture invocations succeed in sequence.
//
// (c) is approximated: the rehabilitation flow runs the stored fixture 10
// times via the appropriate runtime (bun / uv / camofox) and ALL ten must
// return residual below the artifact's admission threshold. The runtime
// runner is injected so tests can substitute a deterministic stub.

const REHABILITATION_COOLDOWN_MS = 14 * 24 * 60 * 60 * 1000;
const REHABILITATION_INFRASTRUCTURE_COOLDOWN_MS = 15 * 60 * 1000;
const REHABILITATION_CONTROLLED_INVOCATIONS = 10;

type QuarantineEvent = { ts: string; reason: string | null };

export type RehabFixtureRunner = (artifactId: string) => Promise<{ ok: boolean; residual: number }>;

export type RehabResult =
  | { rehabilitated: true; controlledRuns: number }
  | { rehabilitated: false; reason: "not_quarantined" | "cooldown_pending" | "fixture_run_failed" | "fixture_residual_too_high"; detail?: string };

const quarantineReasonIndicatesInfrastructureEvidenceGap = (reason: string | null): boolean => {
  if (!reason) return false;
  return reason.includes("sandbox_enforcement_missing") || reason.includes("evidence_missing");
};

const rehabilitationCooldownMsForReason = (reason: string | null): number => {
  if (quarantineReasonIndicatesInfrastructureEvidenceGap(reason)) {
    return REHABILITATION_INFRASTRUCTURE_COOLDOWN_MS;
  }
  return REHABILITATION_COOLDOWN_MS;
};

const quarantineReasonFromPayload = (payload: string | null): string | null => {
  try {
    const parsed = JSON.parse(payload ?? "{}") as Record<string, unknown>;
    return typeof parsed.reason === "string" ? parsed.reason : null;
  } catch {
    return null;
  }
};

/** Read the latest quarantine event ts + reason for an artifact.
 *  F4a: matches both canonical and legacy kind strings so historical
 *  events authored before the act_artifact rename still resolve. */
const latestQuarantineEvent = (db: Database, artifactId: string): QuarantineEvent | null => {
  const row = db
    .query(
      `SELECT ts, payload FROM events
       WHERE action_artifact_id = ?
         AND kind IN ('act_artifact_quarantined', 'code_artifact_quarantined')
       ORDER BY ts DESC LIMIT 1`,
    )
    .get(artifactId) as { ts: string; payload: string | null } | null;
  if (!row) return null;
  return { ts: row.ts, reason: quarantineReasonFromPayload(row.payload) };
};

/** Per Architecture.md: a quarantined artifact may re-enter `admitted`
 *  status after the cause-aware cooldown elapses, the admission fixture
 *  re-passes, and 10 controlled fixture invocations all return residual
 *  below the artifact's admission threshold. The runner closure is
 *  injected so callers wire it to the appropriate runtime; tests pass a
 *  deterministic stub. Emits `act_artifact_rehabilitated` on transition. */
export const maybeRehabilitate = async (
  db: Database,
  artifactId: string,
  runner: RehabFixtureRunner,
  emit: (event: EmitEventInput) => void,
  opts?: { nowMs?: number },
): Promise<RehabResult> => {
  artifactId = resolveArtifactId(db, artifactId); // ALIAS_CHAI: write the CURRENT row
  const row = getArtifact(db, artifactId);
  if (!row) return { rehabilitated: false, reason: "not_quarantined", detail: "artifact_not_found" };
  if (row.status !== "quarantined") {
    return { rehabilitated: false, reason: "not_quarantined" };
  }
  const quarantine = latestQuarantineEvent(db, artifactId);
  if (!quarantine) {
    return { rehabilitated: false, reason: "not_quarantined", detail: "quarantine_event_missing" };
  }
  const now = opts?.nowMs ?? Date.now();
  const elapsed = now - new Date(quarantine.ts).getTime();
  const requiredCooldownMs = rehabilitationCooldownMsForReason(quarantine.reason);
  if (elapsed < requiredCooldownMs) {
    return {
      rehabilitated: false,
      reason: "cooldown_pending",
      detail: `${elapsed}ms/${requiredCooldownMs}ms`,
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
    "UPDATE act_artifact SET status = ?, updated_at = ? WHERE id = ?",
    ["admitted", ts, artifactId],
  );
  emit({
    kind: "act_artifact_rehabilitated",
    substrate_origin: "substrate_auto",
    action_artifact_id: artifactId,
    payload: {
      artifact_id: artifactId,
      quarantined_at: quarantine.ts,
      quarantine_reason: quarantine.reason,
      cooldown_ms: elapsed,
      required_cooldown_ms: requiredCooldownMs,
      controlled_runs: REHABILITATION_CONTROLLED_INVOCATIONS,
    } as JsonValue,
  });
  return { rehabilitated: true, controlledRuns: REHABILITATION_CONTROLLED_INVOCATIONS };
};

/** List quarantined artifacts whose latest quarantine event is older than
 *  the cause-aware cooldown window. The daemon's rehabilitation worker tick
 *  consumes this. */
export const listRehabilitationCandidates = (db: Database, nowMs?: number): ActArtifactRow[] => {
  const now = nowMs ?? Date.now();
  const rows = db
    .query("SELECT * FROM act_artifact WHERE status = 'quarantined'")
    .all() as Array<Record<string, unknown>>;
  return rows
    .map(mapRow)
    .filter((row) => {
      const quarantine = latestQuarantineEvent(db, row.id);
      if (!quarantine) return false;
      const elapsed = now - new Date(quarantine.ts).getTime();
      return elapsed >= rehabilitationCooldownMsForReason(quarantine.reason);
    });
};

export const REHABILITATION_COOLDOWN_MS_FOR_TEST = REHABILITATION_COOLDOWN_MS;
export const REHABILITATION_CONTROLLED_INVOCATIONS_FOR_TEST = REHABILITATION_CONTROLLED_INVOCATIONS;

/** Daemon-side rehabilitation tick. Scans quarantined artifacts past their
 *  cause-aware cooldown and attempts rehabilitation via the supplied runner.
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
