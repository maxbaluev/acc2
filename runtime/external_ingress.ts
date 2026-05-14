// acc2 external-push webhook — POST /external/push per v2-design.md §5.2.
//
// Behaviour:
//   1. Authorization: Bearer <token>. Accepted token comes from either the
//      meta-table key `external_source_tokens` (JSON map of {source: token})
//      or the env var ACC2_EXTERNAL_PUSH_TOKEN as the owner-default for B3.
//   2. Body shape: { source, kind, payload, sensitivity_classification_hint? }.
//      `kind` MUST be 'external_event_received' (the only kind v2 admits via
//      this endpoint; other kinds flow through MCP).
//   3. Per-source token bucket — default 60 req/min. Three consecutive
//      breaches → emit `external_source_quarantined` and refuse subsequent
//      calls until manual reinstatement.

import type { Database } from "bun:sqlite";
import type { JsonValue } from "../substrate/types";
import { emitEvent } from "./events";

const DEFAULT_RATE_LIMIT = 60; // requests per minute per source

type Bucket = {
  windowStartMs: number;
  count: number;
  consecutiveBreaches: number;
  quarantined: boolean;
};

export type ExternalIngressState = {
  buckets: Map<string, Bucket>;
  /** Per-source token allowlist. The owner-default env token applies to ALL
   *  sources; per-source overrides live in the meta table. */
  tokens: { ownerDefault: string | null; perSource: Record<string, string> };
  /** Allowed source names — buckets are created lazily, but the source MUST
   *  already be on the registered list. Phase B3 keeps this small + explicit. */
  registeredSources: Set<string>;
  rateLimitPerMin: number;
};

const REGISTERED_SOURCES_DEFAULT = [
  "calendar.google.com",
  "email",
  "github_webhook",
  "slack_webhook",
  "bank",
  "iot:home",
  "health",
  "fs_watch",
  "test_source", // tests use this — never appears in production paths
];

export const createExternalIngressState = (opts: {
  ownerDefaultToken?: string | null;
  rateLimitPerMin?: number;
  extraSources?: string[];
} = {}): ExternalIngressState => ({
  buckets: new Map(),
  tokens: {
    ownerDefault: opts.ownerDefaultToken ?? process.env.ACC2_EXTERNAL_PUSH_TOKEN ?? null,
    perSource: {},
  },
  registeredSources: new Set([...REGISTERED_SOURCES_DEFAULT, ...(opts.extraSources ?? [])]),
  rateLimitPerMin: opts.rateLimitPerMin ?? DEFAULT_RATE_LIMIT,
});

const getBucket = (state: ExternalIngressState, source: string): Bucket => {
  let b = state.buckets.get(source);
  if (!b) {
    b = { windowStartMs: Date.now(), count: 0, consecutiveBreaches: 0, quarantined: false };
    state.buckets.set(source, b);
  }
  return b;
};

/** Charge one request against the bucket; returns whether the call is allowed.
 *  When the bucket overflows we increment `consecutiveBreaches`; a successful
 *  (within-limit) call resets the counter. */
const charge = (state: ExternalIngressState, source: string): { allowed: boolean; breachStreak: number } => {
  const bucket = getBucket(state, source);
  const now = Date.now();
  if (now - bucket.windowStartMs >= 60_000) {
    bucket.windowStartMs = now;
    bucket.count = 0;
  }
  bucket.count += 1;
  if (bucket.count > state.rateLimitPerMin) {
    bucket.consecutiveBreaches += 1;
    return { allowed: false, breachStreak: bucket.consecutiveBreaches };
  }
  bucket.consecutiveBreaches = 0;
  return { allowed: true, breachStreak: 0 };
};

const tokenMatches = (state: ExternalIngressState, source: string, presented: string): boolean => {
  if (state.tokens.perSource[source] && state.tokens.perSource[source] === presented) return true;
  if (state.tokens.ownerDefault && state.tokens.ownerDefault === presented) return true;
  return false;
};

const extractBearer = (req: Request): string | null => {
  const auth = req.headers.get("authorization");
  if (!auth) return null;
  const m = auth.match(/^Bearer\s+(.+)$/i);
  return m ? m[1]!.trim() : null;
};

export const handleExternalPush = async (
  db: Database,
  state: ExternalIngressState,
  req: Request,
): Promise<Response> => {
  if (req.method !== "POST") {
    return Response.json({ ok: false, error: "method_not_allowed" }, { status: 405 });
  }

  let body: Record<string, JsonValue>;
  try {
    const text = await req.text();
    body = text ? (JSON.parse(text) as Record<string, JsonValue>) : {};
  } catch (err) {
    return Response.json(
      { ok: false, error: `bad_json:${(err as Error).message}` },
      { status: 400 },
    );
  }

  const source = body.source as string | undefined;
  const kind = body.kind as string | undefined;
  const payload = (body.payload ?? {}) as JsonValue;
  const sensitivity = (body.sensitivity_classification_hint as string | undefined) ?? "internal";

  if (!source || typeof source !== "string") {
    return Response.json({ ok: false, error: "missing 'source'" }, { status: 400 });
  }
  if (!state.registeredSources.has(source)) {
    return Response.json({ ok: false, error: `unregistered_source:${source}` }, { status: 400 });
  }
  if (kind !== "external_event_received") {
    return Response.json(
      { ok: false, error: "kind_must_be_external_event_received" },
      { status: 400 },
    );
  }

  // Auth check (after source-name check so misconfigured callers get a clearer
  // 400 before the 401; both checks are mandatory).
  const presented = extractBearer(req);
  if (!presented || !tokenMatches(state, source, presented)) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  // Quarantine short-circuit BEFORE charging.
  const bucket = getBucket(state, source);
  if (bucket.quarantined) {
    return Response.json({ ok: false, error: "source_quarantined" }, { status: 429 });
  }

  // Rate-limit charge.
  const { allowed, breachStreak } = charge(state, source);
  if (!allowed) {
    if (breachStreak >= 3) {
      bucket.quarantined = true;
      emitEvent(db, {
        kind: "external_source_quarantined",
        substrate_origin: "substrate_auto",
        payload: { source, reason: "rate_limit_breached_3x", breach_streak: breachStreak },
      });
    }
    return Response.json(
      { ok: false, error: "rate_limit_exceeded", breach_streak: breachStreak },
      { status: 429 },
    );
  }

  const emitted = emitEvent(db, {
    kind: "external_event_received",
    substrate_origin: "substrate_auto",
    payload: {
      source,
      sensitivity_classification_hint: sensitivity,
      data: payload,
    },
  });

  return Response.json({ ok: true, event_id: emitted.id, ts: emitted.ts }, { status: 200 });
};
