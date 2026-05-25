// Proactive owner notification worker.
//
// Converts internal progress/terminal/health trigger events into concise owner
// channel pushes. The primary text is deliberately plain: no event ids, task
// ids, directive ids, view names, residuals, or substrate vocabulary.

import type { Database } from "bun:sqlite";
import type { JsonValue } from "../substrate/types";
import { dispatchResolved, type DispatchResolvedRow } from "../substrate/views";
import { emitEvent } from "./events";

export type OwnerNotificationTrigger =
  | "directive_opened"
  | "decomposed"
  | "milestone"
  | "closure"
  | "failure"
  | "stall"
  | "bridge_health";

export type OwnerChannelPushInput = {
  text: string;
  notificationKey: string;
  sourceEventId: string;
  trigger: OwnerNotificationTrigger;
  directiveId: string;
  taskId?: string;
};

export type OwnerChannelPushResult = {
  channel?: string;
  destination?: string;
  provider_message_id?: string;
  status?: string;
};

export type OwnerChannelAdapter = {
  push(input: OwnerChannelPushInput): OwnerChannelPushResult | Promise<OwnerChannelPushResult>;
};

export type OwnerNotificationWorkerOptions = {
  now?: Date;
  maxRows?: number;
  dedupeWindowMs?: number;
  dryRun?: boolean;
  channel?: OwnerChannelAdapter;
};

export type OwnerNotificationWorkerSummary = {
  scanned: number;
  pushed_count: number;
  rendered_count: number;
  skipped_unscoped: number;
  skipped_duplicate: number;
  skipped_unrenderable: number;
  pushed_event_ids: string[];
  rendered_event_ids: string[];
};

type TriggerRow = {
  id: string;
  ts: string;
  kind: string;
  directive_id: string | null;
  task_id: string | null;
  parent_task_id: string | null;
  payload: string | null;
};

const DEFAULT_DEDUPE_WINDOW_MS = 60 * 60_000;

const TRIGGER_KINDS = [
  "directive_opened",
  "task_node_opened",
  "directive_milestone_recorded",
  "directive_closed",
  "task_committed",
  "task_failed",
  "task_abandoned",
  "dispatcher_violation",
  "constitutional_gate_decision",
  "bridge_failed",
  "bridge_health_degraded",
  "bridge_health_recovered",
] as const;

const parsePayload = (raw: string | null): Record<string, unknown> => {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
};

const classifyTrigger = (row: TriggerRow): OwnerNotificationTrigger | null => {
  if (row.kind === "directive_opened") return "directive_opened";
  if (row.kind === "task_node_opened") return row.parent_task_id ? "decomposed" : "directive_opened";
  if (row.kind === "directive_milestone_recorded") return "milestone";
  if (row.kind === "directive_closed" || row.kind === "task_committed") return "closure";
  if (["task_failed", "task_abandoned", "dispatcher_violation", "bridge_failed"].includes(row.kind)) return "failure";
  if (row.kind === "bridge_health_degraded" || row.kind === "bridge_health_recovered") return "bridge_health";
  if (row.kind === "constitutional_gate_decision") {
    const payload = parsePayload(row.payload);
    const gate = String(payload.gate ?? payload.reason ?? "");
    return gate.includes("cap") || gate.includes("deferred") || gate.includes("degraded") ? "stall" : null;
  }
  return null;
};

const plainStatus = (row: DispatchResolvedRow | null): string => {
  switch (row?.lifecycle_status ?? row?.status) {
    case "completed": return "complete";
    case "failed": return "failed";
    case "queued_at_cap": return "waiting";
    case "zombie": return "stalled";
    case "live_amended": return "continuing";
    case "orphan_node": return "waiting";
    case "abandoned": return "stopped";
    case "live": return "in progress";
    default: return "in progress";
  }
};

const renderOwnerText = (trigger: OwnerNotificationTrigger, status: string): string => {
  const suffix = ` Current status: ${status}.`;
  switch (trigger) {
    case "directive_opened": return `I started tracking the new work.${suffix}`;
    case "decomposed": return `I split the work into a smaller step.${suffix}`;
    case "milestone": return `Progress update: a milestone was reached.${suffix}`;
    case "closure": return `Work is complete.${suffix}`;
    case "failure": return `Work hit a problem.${suffix} No action is required unless you want to redirect it.`;
    case "stall": return `Work appears stalled.${suffix} No action is required unless you want to redirect it.`;
    case "bridge_health": return `Automation health changed.${suffix}`;
  }
};

const sanitizeOwnerText = (text: string): string => text
  .replace(/\b[A-Z0-9]{10,}\b/g, "")
  .replace(/\b(?:event|task|directive)_id\b/gi, "")
  .replace(/dispatch_resolved_view/gi, "status view")
  .replace(/\bresiduals?\b/gi, "score")
  .replace(/\bsubstrate\b/gi, "system")
  .replace(/\s+/g, " ")
  .trim();

const defaultChannel: OwnerChannelAdapter = {
  push: () => ({ channel: "owner-channel:claude-code", status: "accepted" }),
};

const alreadyNotified = (
  db: Database,
  notificationKey: string,
  sourceEventId: string,
  cutoffIso: string,
): boolean => {
  const row = db
    .query<{ n: number }, [string, string, string]>(
      `SELECT COUNT(*) AS n
         FROM events
        WHERE kind = 'owner_notification_pushed'
          AND ts >= ?
          AND (json_extract(payload, '$.notification_key') = ?
            OR json_extract(payload, '$.source_event_id') = ?)`,
    )
    .get(cutoffIso, notificationKey, sourceEventId);
  return (row?.n ?? 0) > 0;
};

const dispatchForTrigger = (db: Database, row: TriggerRow): DispatchResolvedRow | null => {
  if (!row.directive_id) return null;
  if (row.task_id) {
    const scoped = dispatchResolved(db, { directiveId: row.directive_id, rootTaskId: row.task_id });
    if (scoped.length > 0) return scoped[0]!;
  }
  return dispatchResolved(db, { directiveId: row.directive_id, limit: 1 })[0] ?? null;
};

const notificationKeyFor = (row: TriggerRow, trigger: OwnerNotificationTrigger): string =>
  `owner-notification:${trigger}:${row.directive_id ?? "unknown"}:${row.task_id ?? "directive"}`;

export const runOwnerNotificationWorker = async (
  db: Database,
  options: OwnerNotificationWorkerOptions = {},
): Promise<OwnerNotificationWorkerSummary> => {
  const now = options.now ?? new Date();
  const maxRows = Math.max(1, options.maxRows ?? 100);
  const cutoffIso = new Date(now.getTime() - Math.max(0, options.dedupeWindowMs ?? DEFAULT_DEDUPE_WINDOW_MS)).toISOString();
  const channel = options.channel ?? defaultChannel;
  const summary: OwnerNotificationWorkerSummary = {
    scanned: 0,
    pushed_count: 0,
    rendered_count: 0,
    skipped_unscoped: 0,
    skipped_duplicate: 0,
    skipped_unrenderable: 0,
    pushed_event_ids: [],
    rendered_event_ids: [],
  };

  const placeholders = TRIGGER_KINDS.map(() => "?").join(", ");
  const rows = db
    .query<TriggerRow, [...string[], number]>(
      `SELECT id, ts, kind, directive_id, task_id, parent_task_id, payload
         FROM events
        WHERE kind IN (${placeholders})
        ORDER BY ts ASC, id ASC
        LIMIT ?`,
    )
    .all(...TRIGGER_KINDS, maxRows);

  for (const row of rows) {
    summary.scanned++;
    if (!row.directive_id) {
      summary.skipped_unscoped++;
      continue;
    }
    const trigger = classifyTrigger(row);
    if (!trigger) {
      summary.skipped_unrenderable++;
      continue;
    }
    const notificationKey = notificationKeyFor(row, trigger);
    if (alreadyNotified(db, notificationKey, row.id, cutoffIso)) {
      summary.skipped_duplicate++;
      continue;
    }
    const statusRow = dispatchForTrigger(db, row);
    const primaryText = sanitizeOwnerText(renderOwnerText(trigger, plainStatus(statusRow)));
    if (primaryText.length === 0) {
      summary.skipped_unrenderable++;
      continue;
    }
    if (options.dryRun) continue;

    const rendered = emitEvent(db, {
      kind: "rendered_owner_message_recorded",
      substrate_origin: "substrate_auto",
      directive_id: row.directive_id,
      task_id: row.task_id ?? undefined,
      context_refs: [row.id],
      payload: {
        audience: "owner",
        medium: "owner_channel",
        primary_text: primaryText,
        source_event_id: row.id,
        notification_key: notificationKey,
        trigger,
      } as JsonValue,
    });
    summary.rendered_count++;
    summary.rendered_event_ids.push(rendered.id);

    const pushed = await channel.push({
      text: primaryText,
      notificationKey,
      sourceEventId: row.id,
      trigger,
      directiveId: row.directive_id,
      taskId: row.task_id ?? undefined,
    });
    const pushedEvent = emitEvent(db, {
      kind: "owner_notification_pushed",
      substrate_origin: "substrate_auto",
      directive_id: row.directive_id,
      task_id: row.task_id ?? undefined,
      context_refs: [row.id, rendered.id],
      payload: {
        channel: pushed.channel ?? "owner-channel:claude-code",
        destination: pushed.destination ?? "owner-private-surface",
        push_status: pushed.status ?? "accepted",
        provider_message_id: pushed.provider_message_id,
        source_event_id: row.id,
        rendered_owner_message_event_id: rendered.id,
        notification_key: notificationKey,
        trigger,
        status_snapshot: { status: plainStatus(statusRow) },
      } as JsonValue,
    });
    summary.pushed_count++;
    summary.pushed_event_ids.push(pushedEvent.id);
  }

  return summary;
};
