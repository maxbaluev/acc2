import type { Database } from "bun:sqlite";
import type { JsonValue, OutcomeStatus } from "../substrate/types";
import { emitEvent, type EmittedEvent } from "./events";

export type OwnerOutcomeSignal = "worked" | "broke" | "partial" | "not_what_i_meant" | string;

export type OwnerOutcomeTarget = {
  directive_id?: string;
  task_id?: string;
  source_applied_change_event_id?: string;
  source_act_id?: string;
  action_scored_event_id?: string;
};

export type OwnerOutcomeInput = {
  signal: OwnerOutcomeSignal;
  text?: string;
  target?: OwnerOutcomeTarget;
  owner_input_event_id?: string;
};

export type OwnerOutcomeResidualAdjustment = {
  observed_residual: number;
  signal_class: "positive_strong" | "negative_strong" | "negative_weak" | "neutral";
  outcome: OutcomeStatus;
  verdict: "positive" | "negative" | "partial";
};

type EventRow = {
  id: string;
  directive_id: string | null;
  task_id: string | null;
  payload: string | Record<string, unknown> | null;
  context_refs?: string | string[] | null;
  residual?: number | null;
};

type McpCall = (toolName: string, args: Record<string, unknown>) => Promise<{
  ok: boolean;
  result?: Record<string, unknown>;
  error?: string;
}>;

const parsePayload = (raw: EventRow["payload"]): Record<string, unknown> => {
  if (!raw) return {};
  if (typeof raw === "object" && !Array.isArray(raw)) return raw;
  if (typeof raw !== "string") return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
};

const parseRefs = (raw: EventRow["context_refs"]): string[] => {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.filter((v): v is string => typeof v === "string");
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
};

const uniqueRefs = (refs: Array<string | undefined | null>): string[] =>
  Array.from(new Set(refs.filter((v): v is string => typeof v === "string" && v.length > 0)));

export const classifyOwnerOutcomeSignal = (text: string): OwnerOutcomeSignal | null => {
  const s = text.toLowerCase();
  if (/\b(not what i meant|wrong direction|misunderstood|not the ask)\b/.test(s)) return "not_what_i_meant";
  if (/\b(still broken|still fails|still not working|did not work|didn't work|does not work|not fixed|broke)\b/.test(s)) return "broke";
  if (/\b(partial|partly|closer|somewhat|needs adjustment|needs changes)\b/.test(s)) return "partial";
  if (/\b(this worked|it worked|that worked|works now|fixed|solved|success|looks good)\b/.test(s)) return "worked";
  return null;
};

export const ownerOutcomeResidualAdjustment = (signal: OwnerOutcomeSignal): OwnerOutcomeResidualAdjustment => {
  switch (signal) {
    case "worked":
      return { observed_residual: 0.05, signal_class: "positive_strong", outcome: "succeeded", verdict: "positive" };
    case "partial":
      return { observed_residual: 0.45, signal_class: "negative_weak", outcome: "pending", verdict: "partial" };
    case "not_what_i_meant":
      return { observed_residual: 0.9, signal_class: "negative_strong", outcome: "failed", verdict: "negative" };
    case "broke":
      return { observed_residual: 0.95, signal_class: "negative_strong", outcome: "failed", verdict: "negative" };
    default:
      return { observed_residual: 0.5, signal_class: "neutral", outcome: "pending", verdict: "partial" };
  }
};

const appliedChangeWhereClause = (target: OwnerOutcomeTarget | undefined): { sql: string; args: string[] } => {
  if (target?.source_applied_change_event_id) return { sql: "id = ?", args: [target.source_applied_change_event_id] };
  if (target?.source_act_id) {
    return {
      sql: "(json_extract(payload, '$.source_act_id') = ? OR EXISTS (SELECT 1 FROM json_each(context_refs) WHERE value = ?))",
      args: [target.source_act_id, target.source_act_id],
    };
  }
  if (target?.directive_id && target?.task_id) return { sql: "directive_id = ? AND task_id = ?", args: [target.directive_id, target.task_id] };
  if (target?.directive_id) return { sql: "directive_id = ?", args: [target.directive_id] };
  return { sql: "1 = 1", args: [] };
};

const findAppliedChange = (db: Database, target: OwnerOutcomeTarget | undefined): EventRow | null => {
  const where = appliedChangeWhereClause(target);
  return db.query<EventRow, string[]>(
    `SELECT id, directive_id, task_id, payload, context_refs, residual
       FROM events
      WHERE kind = 'applied_change_committed' AND ${where.sql}
      ORDER BY ts DESC
      LIMIT 1`,
  ).get(...where.args) ?? null;
};

const findActionScored = (db: Database, applied: EventRow, target: OwnerOutcomeTarget | undefined): EventRow | null => {
  const appliedPayload = parsePayload(applied.payload);
  const actionScoredId = target?.action_scored_event_id ?? (typeof appliedPayload.action_scored_event_id === "string" ? appliedPayload.action_scored_event_id : undefined);
  const sourceActId = target?.source_act_id ?? (typeof appliedPayload.source_act_id === "string" ? appliedPayload.source_act_id : undefined);
  if (actionScoredId) {
    const row = db.query<EventRow, [string]>(
      `SELECT id, directive_id, task_id, payload, context_refs, residual FROM events WHERE kind = 'action_scored' AND id = ? LIMIT 1`,
    ).get(actionScoredId);
    if (row) return row;
  }
  if (!sourceActId) return null;
  return db.query<EventRow, [string, string]>(
    `SELECT id, directive_id, task_id, payload, context_refs, residual
       FROM events
      WHERE kind = 'action_scored'
        AND (json_extract(payload, '$.source_act_id') = ? OR EXISTS (SELECT 1 FROM json_each(context_refs) WHERE value = ?))
      ORDER BY ts DESC
      LIMIT 1`,
  ).get(sourceActId, sourceActId) ?? null;
};

export const recordOwnerObservedOutcome = (db: Database, input: OwnerOutcomeInput): EmittedEvent | null => {
  const applied = findAppliedChange(db, input.target);
  if (!applied) return null;
  const scored = findActionScored(db, applied, input.target);
  const appliedPayload = parsePayload(applied.payload);
  const scoredPayload = scored ? parsePayload(scored.payload) : {};
  const adjustment = ownerOutcomeResidualAdjustment(input.signal);
  const previousResidual = typeof scored?.residual === "number"
    ? scored.residual
    : typeof scoredPayload.residual === "number"
      ? scoredPayload.residual as number
      : typeof applied.residual === "number"
        ? applied.residual
        : null;
  const sourceActId = input.target?.source_act_id
    ?? (typeof appliedPayload.source_act_id === "string" ? appliedPayload.source_act_id : undefined)
    ?? (typeof scoredPayload.source_act_id === "string" ? scoredPayload.source_act_id : undefined);
  const sourceActEventId = typeof appliedPayload.source_act_event_id === "string"
    ? appliedPayload.source_act_event_id
    : typeof scoredPayload.source_act_event_id === "string"
      ? scoredPayload.source_act_event_id
      : undefined;
  const context_refs = uniqueRefs([
    input.owner_input_event_id,
    applied.id,
    scored?.id,
    sourceActId,
    sourceActEventId,
    ...parseRefs(applied.context_refs),
    ...(scored ? parseRefs(scored.context_refs) : []),
  ]);

  return emitEvent(db, {
    kind: "owner_observed_outcome_recorded",
    substrate_origin: "claude_root",
    directive_id: applied.directive_id ?? input.target?.directive_id,
    task_id: applied.task_id ?? input.target?.task_id,
    context_refs,
    residual: adjustment.observed_residual,
    outcome: adjustment.outcome,
    payload: {
      text: input.text ?? null,
      signal: input.signal,
      signal_class: adjustment.signal_class,
      verdict: adjustment.verdict,
      observed_residual: adjustment.observed_residual,
      previous_residual: previousResidual,
      residual_delta: previousResidual === null ? null : adjustment.observed_residual - previousResidual,
      residual_adjustment: {
        from: previousResidual,
        to: adjustment.observed_residual,
        delta: previousResidual === null ? null : adjustment.observed_residual - previousResidual,
        basis: "owner_observed_outcome_signal",
      },
      source_applied_change_event_id: applied.id,
      source_act_id: sourceActId ?? null,
      source_act_event_id: sourceActEventId ?? null,
      action_scored_event_id: scored?.id ?? null,
      owner_input_event_id: input.owner_input_event_id ?? null,
      observed_outcome: {
        verdict: adjustment.verdict,
        signal: input.signal,
        text: input.text ?? null,
      },
    } as JsonValue,
  });
};

const findMcpEvent = (events: EventRow[], target: OwnerOutcomeTarget | undefined): EventRow | null => {
  const applied = events.filter((e) => parsePayload(e.payload).status === "applied");
  if (target?.source_applied_change_event_id) return applied.find((e) => e.id === target.source_applied_change_event_id) ?? null;
  if (target?.source_act_id) return applied.find((e) => parsePayload(e.payload).source_act_id === target.source_act_id || parseRefs(e.context_refs).includes(target.source_act_id!)) ?? null;
  if (target?.directive_id && target?.task_id) return applied.find((e) => e.directive_id === target.directive_id && e.task_id === target.task_id) ?? null;
  if (target?.directive_id) return applied.find((e) => e.directive_id === target.directive_id) ?? null;
  return applied[0] ?? null;
};

export const recordOwnerObservedOutcomeViaMcp = async (mcpCall: McpCall, input: OwnerOutcomeInput): Promise<EmittedEvent | null> => {
  const recent = await mcpCall("runtime.recent_events", { k: 100, kinds: ["applied_change_committed", "action_scored"] });
  if (!recent.ok) return null;
  const events = ((recent.result?.events as EventRow[] | undefined) ?? []).slice().reverse();
  const applied = findMcpEvent(events.filter((e) => (e as { kind?: string }).kind === "applied_change_committed" || parsePayload(e.payload).status === "applied"), input.target);
  if (!applied) return null;
  const appliedPayload = parsePayload(applied.payload);
  const sourceActId = input.target?.source_act_id ?? (typeof appliedPayload.source_act_id === "string" ? appliedPayload.source_act_id : undefined);
  const actionScoredId = input.target?.action_scored_event_id ?? (typeof appliedPayload.action_scored_event_id === "string" ? appliedPayload.action_scored_event_id : undefined);
  const scored = events.find((e) => e.id === actionScoredId)
    ?? (sourceActId ? events.find((e) => parsePayload(e.payload).source_act_id === sourceActId || parseRefs(e.context_refs).includes(sourceActId)) : undefined);
  const scoredPayload = scored ? parsePayload(scored.payload) : {};
  const adjustment = ownerOutcomeResidualAdjustment(input.signal);
  const previousResidual = typeof scored?.residual === "number"
    ? scored.residual
    : typeof scoredPayload.residual === "number"
      ? scoredPayload.residual as number
      : typeof applied.residual === "number"
        ? applied.residual
        : null;
  const sourceActEventId = typeof appliedPayload.source_act_event_id === "string" ? appliedPayload.source_act_event_id : undefined;
  const env = await mcpCall("substrate.emit", {
    kind: "owner_observed_outcome_recorded",
    substrate_origin: "claude_root",
    directive_id: applied.directive_id ?? input.target?.directive_id,
    task_id: applied.task_id ?? input.target?.task_id,
    context_refs: uniqueRefs([input.owner_input_event_id, applied.id, scored?.id, sourceActId, sourceActEventId, ...parseRefs(applied.context_refs), ...(scored ? parseRefs(scored.context_refs) : [])]),
    residual: adjustment.observed_residual,
    outcome: adjustment.outcome,
    payload: {
      text: input.text ?? null,
      signal: input.signal,
      signal_class: adjustment.signal_class,
      verdict: adjustment.verdict,
      observed_residual: adjustment.observed_residual,
      previous_residual: previousResidual,
      residual_delta: previousResidual === null ? null : adjustment.observed_residual - previousResidual,
      residual_adjustment: { from: previousResidual, to: adjustment.observed_residual, delta: previousResidual === null ? null : adjustment.observed_residual - previousResidual, basis: "owner_observed_outcome_signal" },
      source_applied_change_event_id: applied.id,
      source_act_id: sourceActId ?? null,
      source_act_event_id: sourceActEventId ?? null,
      action_scored_event_id: scored?.id ?? null,
      owner_input_event_id: input.owner_input_event_id ?? null,
      observed_outcome: { verdict: adjustment.verdict, signal: input.signal, text: input.text ?? null },
    },
  });
  if (!env.ok) return null;
  const result = env.result as { id?: string; ts?: string } | undefined;
  return result?.id ? { id: result.id, ts: result.ts ?? "" } : null;
};
