// acc2 universal resource governor — fair, bounded, multi-actor resource
// arbitration so N terminals × M brains share ONE daemon without melting it.
//
// THE PROBLEM (spec Y3J27P483D0ANEYEAZTP2C486G "current"): the scheduler's
// dispatch/brain slots, the bridge handshake permits, the SQL worker queue,
// and the pathology budget are SEPARATE process-local mechanisms. They share
// no first-class actor key, so a single terminal or brain can saturate SQL
// jobs / handshakes / dispatch slots while every other actor starves.
//
// THE DESIGN (corrected actor key — substrate-native, NOT the spec's literal
// "(terminal_id, brain_id)"): the substrate has no persistent brain_id and MCP
// calls carry no per-terminal identity. The governor keys on the substrate's
// REAL identity surface:
//   - origin    : the SubstrateOrigin / MCP invoker (claude_root | opencode |
//                 claude_agent | substrate_auto | …). Always present.
//   - dispatch_id / directive_id : a "brain" is a short-lived per-dispatch
//                 opencode subprocess keyed by dispatch_id (task_dispatcher
//                 mints it, the bridge stamps brain_dispatched with it). This
//                 is the closest thing to a per-brain key the substrate owns.
//   - peer_id   : when the caller self-identifies through peer_registry
//                 (registerPeer/peerActivity) the governor keys on that.
// A deterministic fallback bucket ('unknown') always holds for callers with no
// id, and is debited conservatively (it never gets MORE than one actor's fair
// share, so an anonymous flood cannot starve identified actors).
//
// THE GUARANTEES:
//   1. GLOBAL CAP (meltdown-stopper): total concurrent leases across ALL
//      resource dimensions and ALL actors cannot exceed a bounded budget.
//      New work at cap QUEUES (admitted:false, queued_reason) or is refused
//      gracefully — NEVER crash, NEVER unbounded growth (OOM defence).
//   2. PER-ACTOR FAIRNESS: each actor gets a bounded per-actor quota per
//      resource. One actor cannot consume the global budget and starve the
//      others — even under the global cap, an actor at its per-actor quota is
//      refused while a different actor with headroom is admitted.
//   3. DETERMINISTIC FALLBACK: when no scored policy applies, fixed default
//      budgets hold. The governor is correct with zero configuration.
//
// This module owns ONLY admission accounting. It does NOT change posterior /
// credit math, does NOT own the event spine, and does NOT spawn anything. The
// scheduler / bridge / SQL pool call requestLease before acquiring a real slot
// and releaseLease when the slot frees; the governor is a pure in-memory
// arbiter plus an optional additive accounting row written through the caller's
// db handle (governor_lease_ledger table, additive migration only).

import type { Database } from "bun:sqlite";
import type { JsonValue } from "../substrate/types";

// ── Actor identity (substrate-native) ──────────────────────────────────

/** Substrate-native actor identity for resource accounting. NOT the spec's
 *  fictional (terminal_id, brain_id) — those don't exist as persistent keys.
 *  Reuses peer_registry's vocabulary (origin/peer_id) rather than inventing a
 *  parallel identity surface. */
export type ActorId = {
  /** SubstrateOrigin / MCP invoker. Always present (defaults to 'unknown'). */
  origin: string;
  /** Per-dispatch brain correlation key (a "brain" = one opencode subprocess
   *  keyed by dispatch_id). Present for brain-lane leases. */
  dispatch_id?: string | null;
  /** Directive correlation when dispatch_id is absent. */
  directive_id?: string | null;
  /** peer_registry peer_id when the caller self-identified. */
  peer_id?: string | null;
};

/** The deterministic fallback bucket for callers with no id. Debited
 *  conservatively so an anonymous flood cannot starve identified actors. */
export const UNKNOWN_ACTOR_KEY = "unknown";

/** Collapse an ActorId to a stable string key for quota accounting. Prefers the
 *  most specific identity available: peer_id > dispatch_id > directive_id, all
 *  namespaced by origin. Callers with nothing collapse to UNKNOWN_ACTOR_KEY so
 *  every anonymous caller shares ONE bucket (the conservative-debit guarantee).
 *  Deterministic: same identity → same key, always. */
export const actorKey = (actor: ActorId | null | undefined): string => {
  if (!actor) return UNKNOWN_ACTOR_KEY;
  const origin = typeof actor.origin === "string" && actor.origin.length > 0 ? actor.origin : UNKNOWN_ACTOR_KEY;
  if (typeof actor.peer_id === "string" && actor.peer_id.length > 0) return `${origin}:peer:${actor.peer_id}`;
  if (typeof actor.dispatch_id === "string" && actor.dispatch_id.length > 0) return `${origin}:dispatch:${actor.dispatch_id}`;
  if (typeof actor.directive_id === "string" && actor.directive_id.length > 0) return `${origin}:directive:${actor.directive_id}`;
  if (origin === UNKNOWN_ACTOR_KEY) return UNKNOWN_ACTOR_KEY;
  return `${origin}:origin`;
};

// ── Resource dimensions ─────────────────────────────────────────────────

/** The canonical resource dimensions the governor arbitrates. Open-ended by
 *  construction (Record<string, number>) — callers MAY declare richer cost
 *  vectors; the governor enforces budgets only for dimensions it has a budget
 *  for and ignores unknown axes (deterministic, no surprise refusals). */
export type ResourceCost = Record<string, number>;

/** Default GLOBAL budgets — the bounded total across ALL actors. These are the
 *  meltdown-stopping ceilings for SHARED, non-peer-keyed resource dimensions.
 *  Conservative-by-construction: the daemon runs a SINGLE event loop.
 *  Deterministic; apply when no scored policy overrides them.
 *
 *  NOTE (amendment 34JT5W47): `brain_slots` is deliberately NOT a global
 *  dimension. Brain-dispatch admission is keyed PER PEER (see PER_PEER_BRAIN_*
 *  + requestBrainSlot) so one peer's refinement chain at capacity cannot block
 *  another peer's brain dispatch. The OOM/reactivity ceiling that USED to be
 *  encoded as the global brain_slots cap now lives in the scheduler's
 *  host-RAM-derived computeBrainDispatchCap heap gate, which is a host-level
 *  resource fact, not a cross-peer admission counter. Dispatch/handshake/SQL
 *  dimensions remain global because they are genuinely shared substrate
 *  resources, not per-peer cost. */
export const DEFAULT_GLOBAL_BUDGET: Readonly<ResourceCost> = Object.freeze({
  // Total concurrent dispatch slots (all lanes — replay/inline/brain).
  dispatch_slots: 8,
  // Total concurrent MCP handshake permits in flight.
  brain_handshake_slots: 8,
  // Total concurrent admitted SQL jobs.
  sql_jobs: 256,
});

/** PER-PEER brain-dispatch budget (amendment 34JT5W47). Each peer gets its OWN
 *  brain-slot allowance keyed by peer_id; a peer at its cap is refused while a
 *  different peer with headroom is admitted. There is NO global brain_slots
 *  cap shared across peers — that shared counter was the live failure: one
 *  directive's refinement chain (peer A) tripped admission/storm because every
 *  peer's dispatches counted against ONE global brain_slots counter.
 *
 *  A genuinely runaway SINGLE peer is still bounded: it cannot exceed its own
 *  per-peer brain budget, so the meltdown protection is preserved PER PEER. */
export const DEFAULT_PER_PEER_BRAIN_BUDGET = 3;

/** Default PER-ACTOR quotas — the fair share. No single actor can take more
 *  than this of any dimension, so one terminal/brain cannot starve another even
 *  while global headroom exists. Set so a small number of actors can each get a
 *  meaningful slice without any one monopolising the global cap. */
export const DEFAULT_PER_ACTOR_QUOTA: Readonly<ResourceCost> = Object.freeze({
  // brain_slots intentionally absent — brain admission is keyed per peer_id via
  // requestBrainSlot/DEFAULT_PER_PEER_BRAIN_BUDGET (amendment 34JT5W47), NOT via
  // the actorKey-namespaced quota (which mixed origin/dispatch/directive).
  dispatch_slots: 4,
  brain_handshake_slots: 3,
  sql_jobs: 64,
});

/** Resolve the per-peer brain bucket key. A present, non-empty peer_id keys on
 *  itself; an absent/empty peer routes to the explicit unknown-peer fallback
 *  bucket — consistent with peer_registry's UNKNOWN_PEER_ID convention so an
 *  un-identified caller is one well-known bucket, never silently attributed to
 *  an identified peer. Deterministic: same peer_id → same bucket. */
export const PEER_UNKNOWN_BUCKET = "peer-unknown";
export const peerBrainBucket = (peerId: string | null | undefined): string =>
  typeof peerId === "string" && peerId.length > 0 ? peerId : PEER_UNKNOWN_BUCKET;

export type GovernorBudgets = {
  global: ResourceCost;
  perActor: ResourceCost;
};

export type LeaseResult = {
  admitted: boolean;
  lease_id: string | null;
  /** When admitted=false: which dimension blocked, and whether it was the
   *  global cap (meltdown-stopper) or the per-actor quota (fairness gate). */
  queued_reason?: string;
  exhausted_resource?: string;
  cap_kind?: "global" | "per_actor" | "per_peer";
  /** The actor key the lease was accounted under (for observability). */
  actor_key?: string;
  /** Suggested retry delay; the caller re-attempts next scheduler tick. */
  retry_after_ms?: number;
  /** Cited scored_decision_policy_v1 id, when a policy shaped the budget. */
  governing_policy_id?: string | null;
};

type LeaseRecord = {
  lease_id: string;
  actor_key: string;
  cost: ResourceCost;
  acquired_at_ms: number;
};

// ── The governor (one per daemon process) ───────────────────────────────

/** ONE governor arbitrates ALL resource dimensions for ALL actors. Pure
 *  in-memory accounting; deterministic; thread-confined to the daemon's single
 *  event loop (the same loop every MCP call, scheduler tick, and bridge spawn
 *  runs on — so there is no intra-process race). */
export class ResourceGovernor {
  private readonly budgets: GovernorBudgets;
  private readonly leases = new Map<string, LeaseRecord>();
  // dimension → total in-flight units across all actors.
  private readonly globalUsed: ResourceCost = {};
  // actorKey → (dimension → in-flight units).
  private readonly perActorUsed = new Map<string, ResourceCost>();
  private nextLeaseSeq = 1;
  private retryAfterMs: number;

  // ── PER-PEER brain admission (amendment 34JT5W47) ──────────────────────
  // Brain-dispatch slots are accounted PER peer_id, NOT against a global
  // brain_slots counter. peer bucket → in-flight brain-slot count; and
  // brainLeaseId → the bucket it debited (for release). One peer at its cap
  // never blocks another peer's admission.
  private readonly perPeerBrainBudget: number;
  private readonly perPeerBrainUsed = new Map<string, number>();
  private readonly brainLeaseBucket = new Map<string, string>();

  constructor(opts?: { budgets?: Partial<GovernorBudgets>; retryAfterMs?: number; perPeerBrainBudget?: number }) {
    this.budgets = {
      global: { ...DEFAULT_GLOBAL_BUDGET, ...(opts?.budgets?.global ?? {}) },
      perActor: { ...DEFAULT_PER_ACTOR_QUOTA, ...(opts?.budgets?.perActor ?? {}) },
    };
    this.retryAfterMs = opts?.retryAfterMs ?? 500;
    const b = opts?.perPeerBrainBudget;
    this.perPeerBrainBudget = typeof b === "number" && Number.isFinite(b) && b > 0
      ? Math.floor(b)
      : DEFAULT_PER_PEER_BRAIN_BUDGET;
  }

  /** Snapshot the effective budgets (deterministic fallback view). */
  budgetsSnapshot(): GovernorBudgets {
    return { global: { ...this.budgets.global }, perActor: { ...this.budgets.perActor } };
  }

  /** Try to acquire a lease for `actor` covering `cost`. ADMISSION CONTROL:
   *  - If the GLOBAL cap would be exceeded for any dimension → refuse with
   *    cap_kind='global' (the meltdown-stopper; caller QUEUES and retries).
   *  - Else if the PER-ACTOR quota would be exceeded → refuse with
   *    cap_kind='per_actor' (fairness; this actor waits, others proceed).
   *  - Else admit and record the lease.
   *  NEVER throws; NEVER mutates state on refusal. Bounded by construction. */
  requestLease(
    actor: ActorId | null | undefined,
    cost: ResourceCost,
    opts?: { governing_policy_id?: string | null },
  ): LeaseResult {
    const key = actorKey(actor);
    const sanitized = sanitizeCost(cost);
    const actorUsed = this.perActorUsed.get(key) ?? {};

    // 1. GLOBAL cap check FIRST (meltdown-stopper takes precedence over fairness).
    for (const [dim, amount] of Object.entries(sanitized)) {
      if (amount <= 0) continue;
      const cap = this.budgets.global[dim];
      if (cap === undefined) continue; // no global budget for this dim → unbounded by design
      const used = this.globalUsed[dim] ?? 0;
      if (used + amount > cap) {
        return {
          admitted: false,
          lease_id: null,
          queued_reason: "global_cap_exhausted",
          exhausted_resource: dim,
          cap_kind: "global",
          actor_key: key,
          retry_after_ms: this.retryAfterMs,
          governing_policy_id: opts?.governing_policy_id ?? null,
        };
      }
    }

    // 2. PER-ACTOR quota check (fairness — one actor cannot starve another).
    //    The 'unknown' bucket is debited like any other actor, so an anonymous
    //    flood is bounded to a single actor's fair share.
    for (const [dim, amount] of Object.entries(sanitized)) {
      if (amount <= 0) continue;
      const quota = this.budgets.perActor[dim];
      if (quota === undefined) continue;
      const used = actorUsed[dim] ?? 0;
      if (used + amount > quota) {
        return {
          admitted: false,
          lease_id: null,
          queued_reason: "per_actor_quota_exhausted",
          exhausted_resource: dim,
          cap_kind: "per_actor",
          actor_key: key,
          retry_after_ms: this.retryAfterMs,
          governing_policy_id: opts?.governing_policy_id ?? null,
        };
      }
    }

    // 3. Admit — record the lease and debit both ledgers.
    const leaseId = `gov-lease-${this.nextLeaseSeq++}`;
    this.leases.set(leaseId, { lease_id: leaseId, actor_key: key, cost: sanitized, acquired_at_ms: Date.now() });
    for (const [dim, amount] of Object.entries(sanitized)) {
      if (amount <= 0) continue;
      this.globalUsed[dim] = (this.globalUsed[dim] ?? 0) + amount;
      const a = this.perActorUsed.get(key) ?? {};
      a[dim] = (a[dim] ?? 0) + amount;
      this.perActorUsed.set(key, a);
    }
    return {
      admitted: true,
      lease_id: leaseId,
      actor_key: key,
      governing_policy_id: opts?.governing_policy_id ?? null,
    };
  }

  /** Release a previously-admitted lease. Idempotent: releasing an unknown or
   *  already-released lease is a harmless no-op (never underflows). */
  releaseLease(leaseId: string | null | undefined): void {
    if (!leaseId) return;
    const rec = this.leases.get(leaseId);
    if (!rec) return;
    this.leases.delete(leaseId);
    for (const [dim, amount] of Object.entries(rec.cost)) {
      if (amount <= 0) continue;
      this.globalUsed[dim] = Math.max(0, (this.globalUsed[dim] ?? 0) - amount);
      const a = this.perActorUsed.get(rec.actor_key);
      if (a) {
        a[dim] = Math.max(0, (a[dim] ?? 0) - amount);
        if (Object.values(a).every((v) => v <= 0)) this.perActorUsed.delete(rec.actor_key);
      }
    }
  }

  /** PER-PEER brain admission (amendment 34JT5W47). Admit ONE brain dispatch
   *  for `peerId` if that peer is below its per-peer brain budget. A peer at
   *  its cap is refused (cap_kind='per_peer') while a DIFFERENT peer with
   *  headroom is admitted — one peer can never block another. An absent/empty
   *  peerId routes to the explicit unknown-peer fallback bucket. There is NO
   *  global brain_slots counter consulted here, so no admission decision
   *  depends on a shared cross-peer cap. NEVER throws; NEVER mutates on refusal. */
  requestBrainSlot(
    peerId: string | null | undefined,
    opts?: { governing_policy_id?: string | null },
  ): LeaseResult {
    const bucket = peerBrainBucket(peerId);
    const used = this.perPeerBrainUsed.get(bucket) ?? 0;
    if (used + 1 > this.perPeerBrainBudget) {
      return {
        admitted: false,
        lease_id: null,
        queued_reason: "per_peer_brain_budget_exhausted",
        exhausted_resource: "brain_slots",
        cap_kind: "per_peer",
        actor_key: bucket,
        retry_after_ms: this.retryAfterMs,
        governing_policy_id: opts?.governing_policy_id ?? null,
      };
    }
    const leaseId = `gov-brain-${this.nextLeaseSeq++}`;
    this.perPeerBrainUsed.set(bucket, used + 1);
    this.brainLeaseBucket.set(leaseId, bucket);
    return {
      admitted: true,
      lease_id: leaseId,
      cap_kind: "per_peer",
      actor_key: bucket,
      governing_policy_id: opts?.governing_policy_id ?? null,
    };
  }

  /** Release a per-peer brain slot. Idempotent: releasing an unknown or
   *  already-released brain lease is a harmless no-op (never underflows). */
  releaseBrainSlot(leaseId: string | null | undefined): void {
    if (!leaseId) return;
    const bucket = this.brainLeaseBucket.get(leaseId);
    if (!bucket) return;
    this.brainLeaseBucket.delete(leaseId);
    const used = this.perPeerBrainUsed.get(bucket) ?? 0;
    const next = Math.max(0, used - 1);
    if (next === 0) this.perPeerBrainUsed.delete(bucket);
    else this.perPeerBrainUsed.set(bucket, next);
  }

  /** In-flight brain-slot count for one peer bucket (observability + audit). */
  peerBrainUsage(peerId: string | null | undefined): number {
    return this.perPeerBrainUsed.get(peerBrainBucket(peerId)) ?? 0;
  }

  /** Effective per-peer brain budget (deterministic fallback view). */
  perPeerBrainBudgetSnapshot(): number {
    return this.perPeerBrainBudget;
  }

  /** Global in-flight usage across all actors (observability). */
  globalUsage(): ResourceCost {
    return { ...this.globalUsed };
  }

  /** Per-actor in-flight usage for one actor (observability + fairness audit). */
  actorUsage(actor: ActorId | string | null | undefined): ResourceCost {
    const key = typeof actor === "string" ? actor : actorKey(actor);
    return { ...(this.perActorUsed.get(key) ?? {}) };
  }

  /** All actor keys with live leases (observability). */
  activeActorKeys(): string[] {
    return Array.from(this.perActorUsed.keys());
  }

  /** Count of live leases (observability + leak detection). */
  liveLeaseCount(): number {
    return this.leases.size;
  }

  /** Test/recovery seam: drop ALL leases and zero the ledgers. */
  reset(): void {
    this.leases.clear();
    this.perActorUsed.clear();
    this.perPeerBrainUsed.clear();
    this.brainLeaseBucket.clear();
    for (const k of Object.keys(this.globalUsed)) delete this.globalUsed[k];
    this.nextLeaseSeq = 1;
  }
}

const sanitizeCost = (cost: ResourceCost): ResourceCost => {
  const out: ResourceCost = {};
  if (!cost || typeof cost !== "object") return out;
  for (const [k, raw] of Object.entries(cost)) {
    const n = typeof raw === "number" ? raw : Number(raw);
    if (Number.isFinite(n) && n > 0) out[k] = n;
  }
  return out;
};

// ── Process-singleton governor ───────────────────────────────────────────
//
// The daemon owns ONE governor for the whole process (one event loop, one
// SQLite, one scheduler — so one governor). The scheduler, bridge, SQL pool,
// and MCP server all debit the SAME instance via this accessor. Tests can
// install a fresh instance to start from a clean ledger.

let SINGLETON: ResourceGovernor | null = null;

/** The process-wide governor. Lazily constructed with deterministic default
 *  budgets on first use, so callers never have to thread it through. */
export const getResourceGovernor = (): ResourceGovernor => {
  if (!SINGLETON) SINGLETON = new ResourceGovernor();
  return SINGLETON;
};

/** Test/recovery seam: install a fresh governor (pass null to reset to a
 *  default-budget instance on next access). */
export const _setResourceGovernorForTests = (gov: ResourceGovernor | null): void => {
  SINGLETON = gov;
};

// ── Additive accounting ledger (migration-safe, no event-spine change) ────
//
// The governor's admission decisions are observable through an ADDITIVE table
// the daemon writes directly (NOT through the event spine — admission is
// high-frequency and would flood the ledger; the spine still carries the
// constitutional_gate_decision { gate:'queued_at_cap' } rows the scheduler
// already emits when it defers). substrate/views.ts exposes
// governor_arbitration_view over this table. Pure additive: CREATE TABLE IF
// NOT EXISTS in schema.sql; ensureGovernorLedgerTable() backfills warm DBs.

export const ensureGovernorLedgerTable = (db: Database): void => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS governor_lease_ledger (
      lease_id          TEXT PRIMARY KEY,
      actor_key         TEXT NOT NULL,
      resource          TEXT NOT NULL,
      amount            REAL NOT NULL,
      admitted          INTEGER NOT NULL,
      cap_kind          TEXT,
      governing_policy_id TEXT,
      ts                TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_governor_ledger_actor ON governor_lease_ledger(actor_key);
    CREATE INDEX IF NOT EXISTS idx_governor_ledger_ts ON governor_lease_ledger(ts);
  `);
};

/** Record a governor admission/refusal into the additive ledger. Best-effort:
 *  never throws into the admission hot path (a logging failure must not crash a
 *  dispatch). Records one row per resource dimension touched. */
export const recordGovernorDecision = (
  db: Database,
  decision: {
    actor_key: string;
    cost: ResourceCost;
    admitted: boolean;
    cap_kind?: "global" | "per_actor" | "per_peer" | null;
    governing_policy_id?: string | null;
    lease_id?: string | null;
  },
): void => {
  try {
    ensureGovernorLedgerTable(db);
    const ts = new Date().toISOString();
    const stmt = db.query(
      `INSERT OR REPLACE INTO governor_lease_ledger
        (lease_id, actor_key, resource, amount, admitted, cap_kind, governing_policy_id, ts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const baseId = decision.lease_id ?? `gov-decision-${ts}-${Math.random().toString(36).slice(2, 8)}`;
    for (const [resource, amount] of Object.entries(decision.cost)) {
      if (!(Number.isFinite(amount) && amount > 0)) continue;
      stmt.run(
        `${baseId}:${resource}`,
        decision.actor_key,
        resource,
        amount,
        decision.admitted ? 1 : 0,
        decision.cap_kind ?? null,
        decision.governing_policy_id ?? null,
        ts,
      );
    }
  } catch {
    /* best-effort observability — never crash a dispatch on a log write */
  }
};

/** Build an ActorId from the substrate-native fields a caller has on hand.
 *  Centralised so every callsite produces the SAME deterministic key shape. */
export const actorFromContext = (fields: {
  origin?: string | null;
  dispatch_id?: string | null;
  directive_id?: string | null;
  peer_id?: string | null;
}): ActorId => ({
  origin: typeof fields.origin === "string" && fields.origin.length > 0 ? fields.origin : UNKNOWN_ACTOR_KEY,
  dispatch_id: fields.dispatch_id ?? null,
  directive_id: fields.directive_id ?? null,
  peer_id: fields.peer_id ?? null,
});

export type { JsonValue };
