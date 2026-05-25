// acc2 owner-autonomy worker.
//
// This is the internal idle-autonomy surface: it wakes only when the owner is
// inactive and no owner-direct directive is still live, reads the owner profile,
// and asks the normal brain-invocation worker to choose the next owner-aligned
// maintenance move. It does not expose an MCP method and does not call an LLM.

import type { Database } from "bun:sqlite";
import type { JsonValue } from "../substrate/types";
import { emitEvent } from "./events";

export type OwnerAutonomyWorkerOptions = {
  now?: Date;
  ownerActiveWindowMs?: number;
  cooldownMs?: number;
  dryRun?: boolean;
};

export type OwnerAutonomyWorkerSummary = {
  owner_active: boolean;
  owner_directives_in_flight: number;
  prior_recent_request: boolean;
  profile_event_id: string | null;
  emitted_count: number;
  emitted_event_ids: string[];
};

const DEFAULT_OWNER_ACTIVE_WINDOW_MS = 5 * 60_000;
const DEFAULT_COOLDOWN_MS = 60 * 60_000;

const parsePayload = (raw: string | null): Record<string, unknown> => {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
};

const ownerIsActive = (db: Database, now: Date, windowMs: number): boolean => {
  const cutoff = new Date(now.getTime() - Math.max(0, windowMs)).toISOString();
  const row = db
    .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM events WHERE kind = 'owner_input_received' AND ts >= ?")
    .get(cutoff);
  return (row?.n ?? 0) > 0;
};

const ownerDirectivesInFlight = (db: Database): number => {
  const row = db
    .query<{ n: number }, []>(
      `WITH active AS (
         SELECT directive_id FROM active_objectives_view
       ), opened AS (
         SELECT e.directive_id, e.substrate_origin, e.payload
         FROM events e
         JOIN active a ON a.directive_id = e.directive_id
         WHERE e.kind = 'directive_opened'
           AND e.ts = (SELECT MAX(e2.ts) FROM events e2 WHERE e2.kind = 'directive_opened' AND e2.directive_id = e.directive_id)
       )
       SELECT COUNT(*) AS n
       FROM opened
       WHERE substrate_origin IN ('owner', 'claude_root')`,
    )
    .get();
  return row?.n ?? 0;
};

const recentRequestExists = (db: Database, now: Date, cooldownMs: number): boolean => {
  const cutoff = new Date(now.getTime() - Math.max(0, cooldownMs)).toISOString();
  const row = db
    .query<{ n: number }, [string]>(
      `SELECT COUNT(*) AS n
         FROM events
        WHERE kind = 'brain_invocation_request'
          AND ts >= ?
          AND json_extract(payload, '$.reason') = 'owner_autonomy_idle'`,
    )
    .get(cutoff);
  return (row?.n ?? 0) > 0;
};

const latestOwnerProfile = (db: Database): { event_id: string | null; payload: Record<string, unknown> } => {
  const row = db
    .query<{ event_id: string; payload: string | null }, []>("SELECT event_id, payload FROM owner_profile_view LIMIT 1")
    .get();
  if (!row) return { event_id: null, payload: {} };
  return { event_id: row.event_id, payload: parsePayload(row.payload) };
};

export const ownerAutonomyWorkerTick = (db: Database, options: OwnerAutonomyWorkerOptions = {}): OwnerAutonomyWorkerSummary => {
  const now = options.now ?? new Date();
  const ownerActive = ownerIsActive(db, now, options.ownerActiveWindowMs ?? DEFAULT_OWNER_ACTIVE_WINDOW_MS);
  const inFlight = ownerDirectivesInFlight(db);
  const priorRecent = recentRequestExists(db, now, options.cooldownMs ?? DEFAULT_COOLDOWN_MS);
  const profile = latestOwnerProfile(db);
  const summary: OwnerAutonomyWorkerSummary = {
    owner_active: ownerActive,
    owner_directives_in_flight: inFlight,
    prior_recent_request: priorRecent,
    profile_event_id: profile.event_id,
    emitted_count: 0,
    emitted_event_ids: [],
  };

  if (ownerActive || inFlight > 0 || priorRecent || options.dryRun) return summary;

  const payload = {
    reason: "owner_autonomy_idle",
    summary: "Owner is inactive and no owner-direct directive is in flight; select one owner-aligned autonomous maintenance move.",
    owner_profile_event_id: profile.event_id,
    owner_profile_snapshot: profile.payload as JsonValue,
    requested_action: "Read active objectives, owner profile, and recent failures; open or dispatch exactly one low-risk owner-benefiting maintenance directive if evidence supports it.",
  } as JsonValue;

  const emitted = emitEvent(db, {
    kind: "brain_invocation_request",
    substrate_origin: "substrate_auto",
    context_refs: profile.event_id ? [profile.event_id] : [],
    payload,
  });
  summary.emitted_count = 1;
  summary.emitted_event_ids.push(emitted.id);
  return summary;
};
