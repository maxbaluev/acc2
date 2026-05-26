import type { Database } from "bun:sqlite";
import type { JsonValue } from "../substrate/types";
import { emitEvent } from "./events";

// PeerKind is the substrate-native vocabulary for source-writing actors.
// "unknown" is the WELL-DEFINED default peer the ingress resolver assigns when
// a request arrives without a self-identified peer (FVW2E0YH): a request with
// no peer identity is never silently attributed to claude_root — it gets the
// explicit `unknown` envelope so the ledger records that the actor declined to
// identify, rather than impersonating the orchestrator root.
export type PeerKind = "opencode" | "claude_terminal" | "claude_agent" | "unknown";
export type PeerSpawnability = "substrate_spawnable" | "externally_launched";

/** The canonical default peer for un-identified ingress. Mirrors the resource
 *  governor's UNKNOWN_ACTOR_KEY convention so an anonymous caller is a single,
 *  explicit, well-known identity rather than a hardcoded orchestrator root. */
export const UNKNOWN_PEER_ID = "peer-unknown";
export const UNKNOWN_PEER_KIND: PeerKind = "unknown";

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
  if (kind === "unknown") return UNKNOWN_PEER_ID;
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

// ── Ingress invariant (FVW2E0YH) ────────────────────────────────────
//
// Peer identity is an INGRESS INVARIANT, not a dormant convenience. Every MCP
// request/dispatch path must carry a peer envelope (peer_id + kind) BEFORE it
// touches the ledger. Previously MCP calls landed in one shared context with
// `invoker` hardcoded to `claude_root` — no per-request actor existed, so two
// terminals writing the same checkout were indistinguishable in the ledger.
// These two functions make the dormant registry load-bearing on the live MCP
// path: resolve a peer from open-ended ingress hints, default to a WELL-DEFINED
// `unknown` peer when absent, and register/update it so the activity view sees
// the live caller.

/** A resolved ingress peer envelope. `origin` is the SubstrateOrigin the
 *  request's ledger writes are attributed to (derived from `kind`), so a
 *  caller's MCP emissions are no longer all collapsed to claude_root. */
export type PeerEnvelope = {
  peer_id: string;
  kind: PeerKind;
  /** SubstrateOrigin for ledger attribution, derived from kind. */
  origin: string;
};

/** Open-ended hints the ingress layer extracts from a request (HTTP headers,
 *  configured invoker, dispatch correlation). All optional — a request that
 *  declines to self-identify resolves to the well-defined unknown peer. */
export type PeerIngressHints = {
  peer_id?: string | null;
  kind?: string | null;
  directive_id?: string | null;
  task_id?: string | null;
  metadata?: JsonValue;
};

const KNOWN_PEER_KINDS: ReadonlySet<string> = new Set<PeerKind>([
  "opencode",
  "claude_terminal",
  "claude_agent",
  "unknown",
]);

/** Coerce an open-ended kind hint to a known PeerKind. Unrecognized values fall
 *  to `unknown` rather than throwing — ingress must never refuse a request on a
 *  malformed identity hint; it records the actor as explicitly unknown. */
const coercePeerKind = (kind?: string | null): PeerKind =>
  typeof kind === "string" && KNOWN_PEER_KINDS.has(kind) ? (kind as PeerKind) : UNKNOWN_PEER_KIND;

/** Resolve a peer envelope from ingress hints WITHOUT touching the ledger.
 *  Pure: same hints → same envelope. When `peer_id` is absent the request is
 *  attributed to the well-defined unknown peer (never silently to claude_root).
 *  When a `peer_id` is present but the kind is missing/unknown, the kind
 *  coerces to `unknown` while preserving the caller-supplied id. */
export const resolvePeerEnvelope = (hints: PeerIngressHints = {}): PeerEnvelope => {
  const hasId = typeof hints.peer_id === "string" && hints.peer_id.length > 0;
  if (!hasId) {
    return { peer_id: UNKNOWN_PEER_ID, kind: UNKNOWN_PEER_KIND, origin: originForPeer(UNKNOWN_PEER_KIND) };
  }
  const kind = coercePeerKind(hints.kind);
  return { peer_id: hints.peer_id as string, kind, origin: originForPeer(kind) };
};

/** INGRESS INVARIANT entry point: resolve the peer envelope AND register/update
 *  the peer in the live registry before the request reaches a handler. Returns
 *  the resolved envelope so the caller can attribute the request's ledger writes
 *  to it. Best-effort registration: a registry write must never crash a request
 *  (observability is not a gate), but the resolved envelope is ALWAYS returned
 *  so the ingress path can carry a peer identity unconditionally. */
export const resolveIngressPeer = (db: Database, hints: PeerIngressHints = {}): PeerEnvelope => {
  const envelope = resolvePeerEnvelope(hints);
  try {
    // Establish the durable identity row on first sight (peer_registry_view is
    // anchored on peer_registered) AND stamp a fresh liveness heartbeat. A peer
    // seen on every request stays live; the registration is idempotent enough
    // for the view (latest registration wins by ts DESC).
    registerPeer(db, {
      peer_id: envelope.peer_id,
      kind: envelope.kind,
      spawnability: "externally_launched",
      directive_id: hints.directive_id ?? null,
      task_id: hints.task_id ?? null,
      metadata: hints.metadata ?? ({ ingress: true } as JsonValue),
    });
    peerActivity(db, {
      peer_id: envelope.peer_id,
      kind: envelope.kind,
      spawnability: "externally_launched",
      directive_id: hints.directive_id ?? null,
      task_id: hints.task_id ?? null,
      metadata: hints.metadata ?? ({ ingress: true } as JsonValue),
    });
  } catch {
    /* swallow — peer registration is observability at ingress, not a gate */
  }
  return envelope;
};
