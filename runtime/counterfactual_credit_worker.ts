// acc2 T4.1 — counterfactual credit scorer worker.
//
// docs/roadmap.md Tier 6 `counterfactual_comparison_predicate`:
//   Problem: rejected alternatives lack fair evidence.
//   Contract: persist top-K alternatives at dispatch and score unchosen
//             alternatives after action scoring.
//   Closure predicate: counterfactual rows affect routing. Regret falls.
//
// At every selection boundary (artifact pick, route choice, retrieval
// top-K filter) the substrate emits one counterfactual_alternative_recorded
// with the rejected candidate set and a window_seconds. This worker:
//
//   1. Scans counterfactual_alternative_recorded rows older than
//      window_seconds that have NOT yet been scored.
//   2. Looks up the chosen path's action_scored residual (when present).
//   3. For each rejected candidate, emits act_artifact_score_updated:
//        - chosen succeeded (residual < SUCCESS_BAND, default 0.3) →
//          counterfactual_penalty=0.05 added to the chosen residual
//          (small negative posterior delta — the chosen was correct,
//          you would have lost).
//        - chosen failed (residual >= FAILURE_BAND) →
//          max(0, residual - counterfactual_bonus) emitted as the
//          rejected's outcome (small positive posterior delta — the
//          chosen lost, you might have done better).
//   4. Emits one counterfactual_closure_audited per scoring sweep
//      summarising scored count + how many rejected_ids later WON a
//      selection within 24h (closure-predicate proxy: counterfactual
//      rows affect routing).
//
// Idempotency: projection_key on every act_artifact_score_updated row
// is `counterfactual_credit:{counterfactual_event_id}:{rejected_id}` —
// reruns find the row already exists and skip. The closure audit row
// stamps `counterfactual_event_id` so the sweep is replay-safe.

import type { Database } from "bun:sqlite";
import type { JsonValue } from "../substrate/types";
import { emitEvent } from "./events";

const SUCCESS_BAND = 0.3;
const FAILURE_BAND = 0.7;
const DEFAULT_TICK_LIMIT = 200;
const DEFAULT_COUNTERFACTUAL_PENALTY = 0.05;
const DEFAULT_COUNTERFACTUAL_BONUS = 0.05;
const DEFAULT_WINDOW_SECONDS = 600;
const CLOSURE_LOOKBACK_MS = 24 * 60 * 60 * 1000;

export type CounterfactualCreditOptions = {
  now?: Date;
  maxRows?: number;
  counterfactualPenalty?: number;
  counterfactualBonus?: number;
  successBand?: number;
  failureBand?: number;
  closureLookbackMs?: number;
};

export type CounterfactualCreditSummary = {
  scanned: number;
  scored_count: number;
  terminalized_count: number;
  rejected_score_event_ids: string[];
  terminal_closure_event_ids: string[];
  skipped_recent: number;
  skipped_already_scored: number;
  skipped_no_chosen_residual: number;
  closure_event_id: string | null;
};

type CounterfactualRow = {
  id: string;
  ts: string;
  directive_id: string | null;
  task_id: string | null;
  payload: string | null;
  context_refs: string | null;
};

type RejectedCandidate = {
  id: string;
  score?: number;
  reason?: string;
  artifact_kind?: string;
};

type CounterfactualPayload = {
  selection_kind: string;
  selection_event_id?: string;
  chosen_id?: string;
  rejected_candidates: RejectedCandidate[];
  window_seconds: number;
};

const parseJson = <T>(s: string | null | undefined, fallback: T): T => {
  if (!s) return fallback;
  try { return JSON.parse(s) as T; } catch { return fallback; }
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

const readCounterfactualPayload = (raw: string | null): CounterfactualPayload | null => {
  const parsed = parseJson<unknown>(raw, null);
  if (!isRecord(parsed)) return null;
  const selectionKind = typeof parsed.selection_kind === "string" ? parsed.selection_kind : null;
  if (!selectionKind) return null;
  const rejected = Array.isArray(parsed.rejected_candidates) ? parsed.rejected_candidates : [];
  const cleaned: RejectedCandidate[] = [];
  for (const r of rejected) {
    if (!isRecord(r)) continue;
    const id = typeof r.id === "string" ? r.id : null;
    if (!id) continue;
    cleaned.push({
      id,
      score: typeof r.score === "number" ? r.score : undefined,
      reason: typeof r.reason === "string" ? r.reason : undefined,
      artifact_kind: typeof r.artifact_kind === "string" ? r.artifact_kind : undefined,
    });
  }
  const windowSeconds = typeof parsed.window_seconds === "number" && parsed.window_seconds > 0
    ? parsed.window_seconds
    : DEFAULT_WINDOW_SECONDS;
  return {
    selection_kind: selectionKind,
    selection_event_id: typeof parsed.selection_event_id === "string" ? parsed.selection_event_id : undefined,
    chosen_id: typeof parsed.chosen_id === "string" ? parsed.chosen_id : undefined,
    rejected_candidates: cleaned,
    window_seconds: windowSeconds,
  };
};

const residualFromActionScoredRow = (row: { residual: number | null; payload: string | null } | null): number | null => {
  if (!row) return null;
  if (typeof row.residual === "number") return row.residual;
  const parsed = parseJson<Record<string, unknown>>(row.payload, {});
  if (typeof parsed.residual === "number") return parsed.residual;
  return null;
};

const findChosenResidual = (
  db: Database,
  counterfactual: CounterfactualRow,
  payload: CounterfactualPayload,
): number | null => {
  if (payload.selection_event_id) {
    const row = db
      .query<{ residual: number | null; payload: string | null }, [string, string, string]>(
        `SELECT residual, payload FROM events
          WHERE kind = 'action_scored'
            AND (json_extract(payload, '$.source_event_id') = ?
              OR json_extract(payload, '$.selection_event_id') = ?
              OR EXISTS (SELECT 1 FROM json_each(context_refs) WHERE value = ?))
          ORDER BY ts DESC LIMIT 1`,
      )
      .get(payload.selection_event_id, payload.selection_event_id, payload.selection_event_id);
    const directResidual = residualFromActionScoredRow(row);
    if (directResidual !== null) return directResidual;
  }

  const fallback = db
    .query<{ residual: number | null; payload: string | null }, [string | null, string | null, string | null, string | null, string]>(
      `SELECT residual, payload FROM events
        WHERE kind = 'action_scored'
          AND (? IS NULL OR directive_id = ?)
          AND (? IS NULL OR task_id = ?)
          AND ts >= ?
        ORDER BY ts ASC LIMIT 1`,
    )
    .get(counterfactual.directive_id, counterfactual.directive_id, counterfactual.task_id, counterfactual.task_id, counterfactual.ts);
  return residualFromActionScoredRow(fallback);
};

const projectionKeyFor = (counterfactualEventId: string, rejectedId: string): string =>
  `counterfactual_credit:${counterfactualEventId}:${rejectedId}`;

const alreadyScored = (db: Database, projectionKey: string): boolean => {
  const row = db
    .query<{ x: number }, [string]>(
      `SELECT 1 AS x FROM events
        WHERE kind = 'act_artifact_score_updated'
          AND json_extract(payload, '$.projection_key') = ?
        LIMIT 1`,
    )
    .get(projectionKey);
  return row !== null;
};

const terminalProjectionKeyFor = (counterfactualEventId: string): string =>
  `counterfactual_credit_terminal:${counterfactualEventId}`;

const counterfactualAlreadyClosed = (db: Database, counterfactualEventId: string): boolean => {
  const row = db
    .query<{ x: number }, [string, string]>(
      `SELECT 1 AS x FROM events
        WHERE (kind = 'act_artifact_score_updated'
            AND json_extract(payload, '$.projection_key') LIKE ?)
           OR (kind = 'counterfactual_closure_audited'
            AND json_extract(payload, '$.projection_key') = ?)
        LIMIT 1`,
    )
    .get(`counterfactual_credit:${counterfactualEventId}:%`, terminalProjectionKeyFor(counterfactualEventId));
  return row !== null;
};

const readPendingCounterfactualRows = (db: Database, limit: number): CounterfactualRow[] =>
  db
    .query<CounterfactualRow, [number]>(
      `SELECT e.id, e.ts, e.directive_id, e.task_id, e.payload, e.context_refs
         FROM events e
        WHERE e.kind = 'counterfactual_alternative_recorded'
          AND NOT EXISTS (
            SELECT 1 FROM events s
             WHERE s.kind = 'act_artifact_score_updated'
               AND json_extract(s.payload, '$.projection_key') LIKE 'counterfactual_credit:' || e.id || ':%'
          )
          AND NOT EXISTS (
            SELECT 1 FROM events c
             WHERE c.kind = 'counterfactual_closure_audited'
               AND json_extract(c.payload, '$.projection_key') = 'counterfactual_credit_terminal:' || e.id
          )
        ORDER BY e.ts ASC
        LIMIT ?`,
    )
    .all(limit);

const emitTerminalClosure = (
  db: Database,
  row: CounterfactualRow,
  payload: CounterfactualPayload | null,
  now: Date,
  disposition: "invalid_payload" | "no_chosen_residual",
  ageMs: number | null,
): string => {
  const emitted = emitEvent(db, {
    kind: "counterfactual_closure_audited",
    substrate_origin: "substrate_auto",
    directive_id: row.directive_id ?? undefined,
    task_id: row.task_id ?? undefined,
    context_refs: [row.id],
    payload: {
      disposition,
      counterfactual_event_id: row.id,
      selection_kind: payload?.selection_kind ?? null,
      selection_event_id: payload?.selection_event_id ?? null,
      chosen_id: payload?.chosen_id ?? null,
      rejected_count: payload?.rejected_candidates.length ?? 0,
      scored_count: 0,
      closure_residual: 1,
      age_ms: ageMs,
      window_seconds: payload?.window_seconds ?? null,
      sweep_ts: now.toISOString(),
      projected_from: "counterfactual_credit_terminal_v1",
      projection_key: terminalProjectionKeyFor(row.id),
    } as JsonValue,
  });
  return emitted.id;
};

const countRejectedWins = (
  db: Database,
  rejectedIds: string[],
  windowStartMs: number,
  windowEndMs: number,
): number => {
  if (rejectedIds.length === 0) return 0;
  const startTs = new Date(windowStartMs).toISOString();
  const endTs = new Date(windowEndMs).toISOString();
  const placeholders = rejectedIds.map(() => "?").join(",");
  const rows = db
    .query(
      `SELECT DISTINCT json_extract(payload, '$.chosen_id') AS chosen
         FROM events
        WHERE kind = 'counterfactual_alternative_recorded'
          AND ts >= ? AND ts <= ?
          AND json_extract(payload, '$.chosen_id') IN (${placeholders})`,
    )
    .all(startTs, endTs, ...rejectedIds) as Array<{ chosen: string | null }>;
  let wins = 0;
  for (const r of rows) if (r.chosen) wins += 1;
  return wins;
};

export const runCounterfactualCreditWorker = async (
  db: Database,
  options: CounterfactualCreditOptions = {},
): Promise<CounterfactualCreditSummary> => {
  const now = options.now ?? new Date();
  const maxRows = Math.max(1, options.maxRows ?? DEFAULT_TICK_LIMIT);
  const penalty = options.counterfactualPenalty ?? DEFAULT_COUNTERFACTUAL_PENALTY;
  const bonus = options.counterfactualBonus ?? DEFAULT_COUNTERFACTUAL_BONUS;
  const successBand = options.successBand ?? SUCCESS_BAND;
  const failureBand = options.failureBand ?? FAILURE_BAND;
  const closureLookbackMs = options.closureLookbackMs ?? CLOSURE_LOOKBACK_MS;

  const summary: CounterfactualCreditSummary = {
    scanned: 0,
    scored_count: 0,
    terminalized_count: 0,
    rejected_score_event_ids: [],
    terminal_closure_event_ids: [],
    skipped_recent: 0,
    skipped_already_scored: 0,
    skipped_no_chosen_residual: 0,
    closure_event_id: null,
  };

  let totalRejectedScanned = 0;
  const rejectedIdsCovered = new Set<string>();
  let remainingScanBudget = maxRows * 10;

  while (remainingScanBudget > 0) {
    const rows = readPendingCounterfactualRows(db, Math.min(maxRows, remainingScanBudget));
    if (rows.length === 0) break;

    let madeTerminalProgress = false;
    for (const row of rows) {
      summary.scanned++;
      remainingScanBudget--;
      const payload = readCounterfactualPayload(row.payload);
      if (!payload) {
        const closureId = emitTerminalClosure(db, row, null, now, "invalid_payload", null);
        summary.terminalized_count++;
        summary.terminal_closure_event_ids.push(closureId);
        madeTerminalProgress = true;
        continue;
      }
      const windowMs = payload.window_seconds * 1000;
      const ageMs = now.getTime() - new Date(row.ts).getTime();
      if (ageMs < windowMs) {
        summary.skipped_recent++;
        remainingScanBudget = 0;
        break;
      }
      if (counterfactualAlreadyClosed(db, row.id)) {
        summary.skipped_already_scored++;
        continue;
      }
      const chosenResidual = findChosenResidual(db, row, payload);
      if (chosenResidual === null) {
        const closureId = emitTerminalClosure(db, row, payload, now, "no_chosen_residual", ageMs);
        summary.skipped_no_chosen_residual++;
        summary.terminalized_count++;
        summary.terminal_closure_event_ids.push(closureId);
        madeTerminalProgress = true;
        continue;
      }

      let rejectedResidual: number;
      if (chosenResidual < successBand) {
        rejectedResidual = Math.min(1, chosenResidual + penalty);
      } else if (chosenResidual >= failureBand) {
        rejectedResidual = Math.max(0, chosenResidual - bonus);
      } else {
        rejectedResidual = Math.min(1, chosenResidual + penalty * 0.5);
      }

      for (const rejected of payload.rejected_candidates) {
        totalRejectedScanned += 1;
        rejectedIdsCovered.add(rejected.id);
        const projectionKey = projectionKeyFor(row.id, rejected.id);
        if (alreadyScored(db, projectionKey)) continue;
        const emitted = emitEvent(db, {
          kind: "act_artifact_score_updated",
          substrate_origin: "substrate_auto",
          directive_id: row.directive_id ?? undefined,
          task_id: row.task_id ?? undefined,
          action_artifact_id: rejected.id,
          context_refs: [row.id],
          payload: {
            artifact_id: rejected.id,
            role: "counterfactual_rejected",
            residual: rejectedResidual,
            weight: 1,
            counterfactual_event_id: row.id,
            counterfactual_chosen_id: payload.chosen_id ?? null,
            counterfactual_chosen_residual: chosenResidual,
            counterfactual_selection_kind: payload.selection_kind,
            counterfactual_selection_event_id: payload.selection_event_id ?? null,
            counterfactual_reason: rejected.reason ?? null,
            counterfactual_artifact_kind: rejected.artifact_kind ?? null,
            counterfactual_score_at_loss: rejected.score ?? null,
            projected_from: "counterfactual_credit_v1",
            projection_key: projectionKey,
          } as JsonValue,
        });
        summary.scored_count++;
        summary.rejected_score_event_ids.push(emitted.id);
      }
    }

    if (!madeTerminalProgress || rows.length < maxRows) break;
  }

  if (summary.scored_count > 0) {
    const rejectedIds = Array.from(rejectedIdsCovered);
    const windowEndMs = now.getTime();
    const windowStartMs = windowEndMs - closureLookbackMs;
    const wins = countRejectedWins(db, rejectedIds, windowStartMs, windowEndMs);
    const closureResidual = rejectedIds.length > 0
      ? 1 - (wins / rejectedIds.length)
      : 1;
    const closure = emitEvent(db, {
      kind: "counterfactual_closure_audited",
      substrate_origin: "substrate_auto",
      payload: {
        scored_count: summary.scored_count,
        rejected_unique_count: rejectedIds.length,
        rejected_subsequent_wins: wins,
        closure_residual: closureResidual,
        total_rejected_scanned: totalRejectedScanned,
        closure_lookback_ms: closureLookbackMs,
        sweep_ts: now.toISOString(),
      } as JsonValue,
    });
    summary.closure_event_id = closure.id;
  }

  return summary;
};
