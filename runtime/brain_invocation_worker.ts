// acc2 brain_invocation_worker — substrate-side brain dispatch primitive.
//
// Per brain dispatch HCWM88JN0H6NDB8V amendment GMZ08ASMTD7W (which cites
// prior meta-verdict MYMQZFM2XX7732AQ conf=0.86 on subagent-spawning being
// an unledgered execution lane). Without this primitive, brain invocation
// is CLI-only (`acc task`) — the substrate's own workers + views cannot
// recognize when their work needs brain design.
//
// Any substrate component emits brain_invocation_request {request_reason,
// topic_keywords, triggering_event_ids, cited_artifact_ids,
// cited_knowledge_ids, emitter_identity, urgency}. This worker (30s tick)
// reads the queue, applies COSMIC SSA loop prevention (3 requests / 5min
// per emitter_identity → throttle), dedups by (topic_keywords,
// triggering_event_ids) in a 1h window, composes a directive, and
// dispatches through the existing acc task entry point.

import type { Database } from "bun:sqlite";
import type { JsonValue } from "../substrate/types";
import { emitEvent } from "./events";

export type BrainInvocationOptions = {
  now?: Date;
  maxRows?: number;
  throttleWindowMs?: number;
  throttleLimit?: number;
  dedupWindowMs?: number;
  dispatchFn?: (directive: string, evidenceEventIds: string[]) => Promise<{ task_id: string } | null>;
  dryRun?: boolean;
};

export type BrainInvocationSummary = {
  scanned: number;
  dispatched: number;
  throttled: number;
  deduped: number;
  failed: number;
  emitted_event_ids: string[];
};

type RequestRow = {
  id: string;
  ts: string;
  payload: string | null;
};

const DEFAULT_THROTTLE_WINDOW_MS = 5 * 60 * 1000;
const DEFAULT_THROTTLE_LIMIT = 3;
const DEFAULT_DEDUP_WINDOW_MS = 60 * 60 * 1000;
const DEFAULT_MAX_ROWS = 20;

const parsePayload = (raw: string | null): Record<string, unknown> => {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
};

const recentDispatchCountByEmitter = (
  db: Database,
  emitterIdentity: string,
  sinceIso: string,
): number => {
  try {
    const row = db
      .query<{ c: number }, [string, string]>(
        `SELECT COUNT(*) AS c FROM events
          WHERE kind = 'brain_invocation_dispatched'
            AND json_extract(payload, '$.emitter_identity') = ?
            AND ts > ?`,
      )
      .get(emitterIdentity, sinceIso);
    return row?.c ?? 0;
  } catch {
    return 0;
  }
};

const dedupKeyExists = (
  db: Database,
  dedupKey: string,
  sinceIso: string,
): boolean => {
  try {
    const row = db
      .query<{ c: number }, [string, string]>(
        `SELECT COUNT(*) AS c FROM events
          WHERE kind = 'brain_invocation_dispatched'
            AND json_extract(payload, '$.dedup_key') = ?
            AND ts > ?`,
      )
      .get(dedupKey, sinceIso);
    return (row?.c ?? 0) > 0;
  } catch {
    return false;
  }
};

const computeDedupKey = (topicKeywords: string[], triggeringEventIds: string[]): string => {
  const topics = [...topicKeywords].sort().join("|");
  const triggers = [...triggeringEventIds].sort().join(",");
  return `${topics}::${triggers}`;
};

const composeDirective = (req: Record<string, unknown>): string => {
  const reason = String(req.request_reason ?? "unspecified");
  const topics = Array.isArray(req.topic_keywords) ? (req.topic_keywords as string[]).join(", ") : "";
  const emitter = String(req.emitter_identity ?? "unknown");
  const urgency = String(req.urgency ?? "normal");
  const triggers = Array.isArray(req.triggering_event_ids) ? (req.triggering_event_ids as string[]) : [];
  const citedArts = Array.isArray(req.cited_artifact_ids) ? (req.cited_artifact_ids as string[]) : [];
  const citedKnow = Array.isArray(req.cited_knowledge_ids) ? (req.cited_knowledge_ids as string[]) : [];

  return [
    `Substrate-side brain invocation (emitter: ${emitter}, reason: ${reason}, urgency: ${urgency}).`,
    "",
    `Topic keywords: ${topics}`,
    "",
    triggers.length > 0 ? `Triggering events (causal chain): ${triggers.join(", ")}` : "",
    citedArts.length > 0 ? `Cited artifacts: ${citedArts.join(", ")}` : "",
    citedKnow.length > 0 ? `Cited knowledge: ${citedKnow.join(", ")}` : "",
    "",
    "Synthesize ONE position. Emit ≤1 contract_amendment_proposed + ≤2 knowledge_candidates.",
    "Closure_residual < 0.3. Cycle-1-only.",
  ]
    .filter((l) => l.length > 0)
    .join("\n");
};

/** Default dispatch: invokes `bun cli/dispatch.ts task <directive>` as a
 *  detached subprocess. Returns null on spawn error; task_id resolution
 *  happens via the substrate's own directive_opened emission, NOT this
 *  worker's return value. */
const defaultDispatch = async (
  directive: string,
  _evidenceEventIds: string[],
): Promise<{ task_id: string } | null> => {
  try {
    Bun.spawn(["bun", "cli/dispatch.ts", "task", directive], {
      stdio: ["ignore", "ignore", "ignore"],
      cwd: process.cwd(),
    });
    return { task_id: "spawned" };
  } catch {
    return null;
  }
};

export const runBrainInvocationTick = async (
  db: Database,
  opts: BrainInvocationOptions = {},
): Promise<BrainInvocationSummary> => {
  const now = opts.now ?? new Date();
  const maxRows = opts.maxRows ?? DEFAULT_MAX_ROWS;
  const throttleWindowMs = opts.throttleWindowMs ?? DEFAULT_THROTTLE_WINDOW_MS;
  const throttleLimit = opts.throttleLimit ?? DEFAULT_THROTTLE_LIMIT;
  const dedupWindowMs = opts.dedupWindowMs ?? DEFAULT_DEDUP_WINDOW_MS;
  const dispatchFn = opts.dispatchFn ?? defaultDispatch;
  const dryRun = opts.dryRun ?? false;

  const summary: BrainInvocationSummary = {
    scanned: 0,
    dispatched: 0,
    throttled: 0,
    deduped: 0,
    failed: 0,
    emitted_event_ids: [],
  };

  let rows: RequestRow[] = [];
  try {
    rows = db
      .query<RequestRow, [string, number]>(
        `SELECT id, ts, payload FROM events
          WHERE kind = 'brain_invocation_request'
            AND NOT EXISTS (
              SELECT 1 FROM events d
              WHERE d.kind = 'brain_invocation_dispatched'
                AND json_extract(d.payload, '$.request_event_id') = events.id
            )
            AND NOT EXISTS (
              SELECT 1 FROM events t
              WHERE t.kind = 'brain_invocation_throttled'
                AND json_extract(t.payload, '$.request_event_id') = events.id
            )
            AND ts > ?
          ORDER BY ts ASC
          LIMIT ?`,
      )
      .all(new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString(), maxRows);
  } catch (err) {
    return summary;
  }

  summary.scanned = rows.length;
  if (rows.length === 0 || dryRun) return summary;

  const throttleSinceIso = new Date(now.getTime() - throttleWindowMs).toISOString();
  const dedupSinceIso = new Date(now.getTime() - dedupWindowMs).toISOString();

  for (const row of rows) {
    const req = parsePayload(row.payload);
    const emitterIdentity = String(req.emitter_identity ?? "unknown");
    const topicKeywords = Array.isArray(req.topic_keywords) ? (req.topic_keywords as string[]) : [];
    const triggeringEventIds = Array.isArray(req.triggering_event_ids)
      ? (req.triggering_event_ids as string[])
      : [];

    // 1. Loop prevention (COSMIC SSA): count recent DISPATCHED events
    // for this emitter (not raw requests). When dispatches reach
    // throttle_limit, subsequent requests in the same window get throttled.
    const recentCount = recentDispatchCountByEmitter(db, emitterIdentity, throttleSinceIso);
    if (recentCount >= throttleLimit) {
      try {
        const ev = emitEvent(db, {
          kind: "brain_invocation_throttled",
          substrate_origin: "substrate_auto",
          payload: {
            request_event_id: row.id,
            emitter_identity: emitterIdentity,
            recent_count: recentCount,
            throttle_limit: throttleLimit,
            throttle_window_ms: throttleWindowMs,
            reason: "emitter_exceeded_throttle_limit",
          } satisfies Record<string, JsonValue>,
        });
        summary.throttled++;
        summary.emitted_event_ids.push(ev.id);
      } catch {
        summary.failed++;
      }
      continue;
    }

    // 2. Dedup: skip if same (topic, triggering_event_ids) already dispatched recently.
    const dedupKey = computeDedupKey(topicKeywords, triggeringEventIds);
    if (dedupKeyExists(db, dedupKey, dedupSinceIso)) {
      summary.deduped++;
      continue;
    }

    // 3. Compose directive and dispatch.
    const directive = composeDirective(req);
    const evidenceEventIds = [...triggeringEventIds, ...((req.cited_artifact_ids as string[]) ?? []), ...((req.cited_knowledge_ids as string[]) ?? [])];

    try {
      const result = await dispatchFn(directive, evidenceEventIds);
      if (result === null) {
        const ev = emitEvent(db, {
          kind: "brain_invocation_failed",
          substrate_origin: "substrate_auto",
          payload: {
            request_event_id: row.id,
            reason: "dispatch_returned_null",
            directive_preview: directive.slice(0, 200),
          } satisfies Record<string, JsonValue>,
        });
        summary.failed++;
        summary.emitted_event_ids.push(ev.id);
        continue;
      }
      const ev = emitEvent(db, {
        kind: "brain_invocation_dispatched",
        substrate_origin: "substrate_auto",
        payload: {
          request_event_id: row.id,
          dispatched_task_id: result.task_id,
          emitter_identity: emitterIdentity,
          dedup_key: dedupKey,
          topic_keywords: topicKeywords,
          triggering_event_ids: triggeringEventIds,
        } satisfies Record<string, JsonValue>,
      });
      summary.dispatched++;
      summary.emitted_event_ids.push(ev.id);
    } catch (err) {
      try {
        const ev = emitEvent(db, {
          kind: "brain_invocation_failed",
          substrate_origin: "substrate_auto",
          payload: {
            request_event_id: row.id,
            reason: `dispatch_threw:${(err as Error).message}`,
          } satisfies Record<string, JsonValue>,
        });
        summary.emitted_event_ids.push(ev.id);
      } catch {}
      summary.failed++;
    }
  }

  return summary;
};

const TICK_INTERVAL_MS = 30 * 1000;

export const startBrainInvocationWorker = (
  db: Database,
  opts: { now?: () => Date } = {},
): (() => void) => {
  let stopped = false;
  let inFlight = false;
  const nowFn = opts.now ?? (() => new Date());

  const tick = async (): Promise<void> => {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      await runBrainInvocationTick(db, { now: nowFn() });
    } catch {
      // fail-soft per worker contract
    } finally {
      inFlight = false;
    }
  };

  // First tick after 30s, then every 30s
  const handle = setInterval(() => {
    void tick();
  }, TICK_INTERVAL_MS);

  return () => {
    stopped = true;
    clearInterval(handle);
  };
};
