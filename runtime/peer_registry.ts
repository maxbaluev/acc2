import type { Database } from "bun:sqlite";
import type { JsonValue } from "../substrate/types";
import { emitEvent } from "./events";

export type PeerKind = "opencode" | "claude_terminal" | "claude_agent";
export type PeerSpawnability = "substrate_spawnable" | "externally_launched";

export type PeerRegistration = {
  peer_id: string;
  kind: PeerKind;
  spawnability: PeerSpawnability;
  directive_id?: string | null;
  task_id?: string | null;
  current_act_id?: string | null;
  scope?: JsonValue;
  git_head?: string | null;
  metadata?: JsonValue;
};

export type PeerActivity = {
  peer_id: string;
  kind?: PeerKind;
  spawnability?: PeerSpawnability;
  directive_id?: string | null;
  task_id?: string | null;
  current_act_id?: string | null;
  scope?: JsonValue;
  git_head?: string | null;
  metadata?: JsonValue;
};

const originForPeer = (kind?: PeerKind): string => {
  if (kind === "opencode") return "opencode";
  if (kind === "claude_agent") return "claude_agent";
  return "claude_root";
};

export const registerPeer = (db: Database, registration: PeerRegistration): { id: string; ts: string } => {
  const emitted = emitEvent(db, {
    kind: "peer_registered",
    substrate_origin: originForPeer(registration.kind),
    directive_id: registration.directive_id ?? undefined,
    task_id: registration.task_id ?? undefined,
    payload: {
      ...registration,
      id: registration.peer_id,
      scope: registration.scope ?? {},
    } as JsonValue,
    invoker: originForPeer(registration.kind),
  });
  return { id: emitted.id, ts: emitted.ts };
};

export const peerActivity = (db: Database, activity: PeerActivity): { id: string; ts: string } => {
  const emitted = emitEvent(db, {
    kind: "peer_liveness",
    substrate_origin: originForPeer(activity.kind),
    directive_id: activity.directive_id ?? undefined,
    task_id: activity.task_id ?? undefined,
    payload: {
      ...activity,
      id: activity.peer_id,
      scope: activity.scope ?? {},
    } as JsonValue,
    invoker: originForPeer(activity.kind),
  });
  return { id: emitted.id, ts: emitted.ts };
};

export type PeerInFlightAct = {
  event_id: string;
  kind: string;
  ts: string;
  directive_id: string | null;
  task_id: string | null;
  source_act_id: string | null;
};

export type PeerScoreReview = {
  event_id: string;
  ts: string;
  directive_id: string | null;
  task_id: string | null;
  verifier_kind: string | null;
  residual: number | null;
};

export type PeerActivityRow = {
  peer_id: string;
  kind: PeerKind;
  spawnability: PeerSpawnability;
  directive_id: string | null;
  task_id: string | null;
  current_act_id: string | null;
  scope: JsonValue;
  git_head: string | null;
  registered_ts: string;
  last_seen_ts: string;
  seconds_since_last_seen: number;
  liveness_verdict: "live" | "stale" | string;
  registration_event_id: string;
  latest_activity_event_id: string;
  in_flight_acts: PeerInFlightAct[];
  target_resources: string[];
  recent_peer_scores: PeerScoreReview[];
  review_event_ids: string[];
  last_activity_ts: string;
};

export type PeerActivityFilter = {
  current_peer_id?: string;
  target_resource?: string;
  limit?: number;
};

const parseJson = <T>(value: unknown, fallback: T): T => {
  if (typeof value !== "string" || value.length === 0) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
};

export const readPeerActivity = (db: Database, filter: PeerActivityFilter = {}): PeerActivityRow[] => {
  const wheres: string[] = [];
  const params: Array<string | number> = [];
  if (filter.current_peer_id) {
    wheres.push("peer_id != ?");
    params.push(filter.current_peer_id);
  }
  const whereClause = wheres.length > 0 ? `WHERE ${wheres.join(" AND ")}` : "";
  const limit = typeof filter.limit === "number" && filter.limit > 0 ? filter.limit : 50;
  params.push(limit);
  const rows = db
    .query(`SELECT * FROM peer_activity_view ${whereClause} ORDER BY last_activity_ts DESC LIMIT ?`)
    .all(...params) as Array<Record<string, unknown>>;
  const mapped = rows.map((row) => ({
    peer_id: row.peer_id as string,
    kind: row.kind as PeerKind,
    spawnability: row.spawnability as PeerSpawnability,
    directive_id: (row.directive_id as string | null) ?? null,
    task_id: (row.task_id as string | null) ?? null,
    current_act_id: (row.current_act_id as string | null) ?? null,
    scope: parseJson<JsonValue>(row.scope, {}),
    git_head: (row.git_head as string | null) ?? null,
    registered_ts: row.registered_ts as string,
    last_seen_ts: row.last_seen_ts as string,
    seconds_since_last_seen: Number(row.seconds_since_last_seen ?? 0),
    liveness_verdict: row.liveness_verdict as PeerActivityRow["liveness_verdict"],
    registration_event_id: row.registration_event_id as string,
    latest_activity_event_id: row.latest_activity_event_id as string,
    in_flight_acts: parseJson<PeerInFlightAct[]>(row.in_flight_acts, []),
    target_resources: parseJson<string[]>(row.target_resources, []),
    recent_peer_scores: parseJson<PeerScoreReview[]>(row.recent_peer_scores, []),
    review_event_ids: parseJson<string[]>(row.review_event_ids, []),
    last_activity_ts: row.last_activity_ts as string,
  }));
  return filter.target_resource
    ? mapped.filter((row) => row.target_resources.includes(filter.target_resource as string))
    : mapped;
};

export const isLivePeerActingOnTarget = (
  db: Database,
  targetResource: string,
  filter: { current_peer_id?: string } = {},
): boolean => readPeerActivity(db, { current_peer_id: filter.current_peer_id, target_resource: targetResource, limit: 100 })
  .some((row) => row.in_flight_acts.length > 0);
