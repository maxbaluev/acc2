// acc status — one-screen operator dashboard. Aggregates daemon health,
// scheduler queue, in-flight dispatch, recent commits, recent failures,
// supervisor interventions, and quarantined directives into a single
// printable snapshot. Designed so an operator running ONE command sees the
// full picture without juggling acc daemon status + acc watch + acc events.

import { openDb } from "../substrate/db";
import { resolveDbPath } from "../runtime/state_paths";
import { readyTasks } from "../runtime/task_topology";
import { auxBaseUrl, rpcGet } from "./rpc";
import type { Database } from "bun:sqlite";

type FailureRow = { failure_kind: string; c: number };
type DirRow = { directive_id: string; payload: string; ts: string };

const formatBlock = (title: string, rows: string[]): string => {
  if (rows.length === 0) return `\x1b[1m${title}\x1b[0m\n  (none)\n`;
  return `\x1b[1m${title}\x1b[0m\n${rows.map((r) => "  " + r).join("\n")}\n`;
};

export const runStatus = async (_argv: string[]): Promise<number> => {
  const sections: string[] = [];

  // Daemon health
  const base = auxBaseUrl();
  if (base) {
    try {
      const health = await rpcGet<Record<string, unknown>>(`${base}/health`);
      const status = health.status ?? "?";
      const pid = health.pid ?? "?";
      const uptimeS = Math.round(Number(health.uptime_ms ?? 0) / 1000);
      const events = health.events_count ?? "?";
      const stuck = Array.isArray(health.stuck_workers) ? (health.stuck_workers as unknown[]).length : 0;
      sections.push(
        formatBlock("daemon", [
          `status=${status}  pid=${pid}  uptime=${uptimeS}s  events=${events}  stuck_workers=${stuck}`,
        ]),
      );
    } catch (err) {
      sections.push(formatBlock("daemon", [`unreachable: ${(err as Error).message}`]));
    }
  } else {
    sections.push(formatBlock("daemon", ["not running — run `acc daemon start`"]));
  }

  // Open the substrate DB read-only for the rest of the snapshot.
  const dbPath = process.env.ACC2_STATE_DB ?? resolveDbPath();
  let db: Database;
  try {
    db = openDb(dbPath);
  } catch (err) {
    sections.push(formatBlock("substrate", [`db open failed: ${(err as Error).message}`]));
    process.stdout.write(sections.join("\n"));
    return 1;
  }

  // Ready queue
  const ready = readyTasks(db);
  const queueRows: string[] = [];
  if (ready.length > 0) {
    const sample = ready.slice(0, 5);
    queueRows.push(`${ready.length} ready task(s); top ${Math.min(5, ready.length)}:`);
    for (const t of sample) {
      queueRows.push(`${t.id.slice(0, 12)} ${t.directive_id.slice(0, 12)} ${t.goal.slice(0, 60)}`);
    }
  } else {
    queueRows.push("0 ready tasks (queue drained)");
  }
  sections.push(formatBlock("scheduler", queueRows));

  // In-flight directives (brain_dispatched not yet closed)
  const inflight = db
    .query(
      `SELECT DISTINCT directive_id FROM events e
       WHERE kind = 'brain_dispatched'
         AND NOT EXISTS (
           SELECT 1 FROM events c WHERE c.task_id = e.task_id
             AND c.kind IN ('brain_dispatch_closed','task_failed','task_committed')
             AND c.ts >= e.ts
         )`,
    )
    .all() as Array<{ directive_id: string }>;
  sections.push(
    formatBlock(
      "in-flight",
      inflight.length > 0
        ? inflight.slice(0, 10).map((r) => r.directive_id.slice(0, 26))
        : ["none"],
    ),
  );

  // Recent successful commits (last hour)
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const commits = db
    .query(
      `SELECT COUNT(*) AS c FROM events WHERE kind = 'task_committed' AND ts >= ?`,
    )
    .get(oneHourAgo) as { c: number };
  const directivesClosed = db
    .query(
      `SELECT COUNT(*) AS c FROM events WHERE kind = 'directive_closed' AND ts >= ?`,
    )
    .get(oneHourAgo) as { c: number };
  sections.push(
    formatBlock("throughput (last 1h)", [
      `task_committed=${commits.c}  directive_closed=${directivesClosed.c}`,
    ]),
  );

  // Recent failures by kind (last 1h)
  const fails = db
    .query(
      `SELECT failure_kind, COUNT(*) AS c FROM events
       WHERE kind = 'task_failed' AND ts >= ? AND failure_kind IS NOT NULL
       GROUP BY failure_kind ORDER BY c DESC`,
    )
    .all(oneHourAgo) as FailureRow[];
  sections.push(
    formatBlock(
      "failures (last 1h)",
      fails.length > 0
        ? fails.map((f) => `${f.failure_kind.padEnd(28)} ${f.c}`)
        : ["none"],
    ),
  );

  // Supervisor interventions (last 24h)
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const interventions = db
    .query(
      `SELECT ts, payload FROM events
       WHERE kind = 'supervisor_intervention_recorded' AND ts >= ?
       ORDER BY ts DESC LIMIT 10`,
    )
    .all(dayAgo) as Array<{ ts: string; payload: string }>;
  const intRows: string[] = [];
  for (const r of interventions) {
    try {
      const p = JSON.parse(r.payload ?? "{}") as Record<string, unknown>;
      intRows.push(`${r.ts.slice(11, 19)}  ${String(p.pathology ?? "?").padEnd(24)}  →  ${String(p.corrective_event ?? "?")}`);
    } catch { /* skip */ }
  }
  sections.push(
    formatBlock("supervisor (last 24h)", intRows.length > 0 ? intRows : ["none — no auto-quarantines"]),
  );

  // Quarantined directives currently archived (resumable)
  const quarantined = db
    .query(
      `SELECT directive_id, payload, ts FROM events
       WHERE kind = 'directive_archived_by_operator'
         AND ts >= ?
         AND directive_id NOT IN (
           SELECT directive_id FROM events WHERE kind = 'directive_resumed' AND ts >= events.ts
         )
       ORDER BY ts DESC LIMIT 10`,
    )
    .all(dayAgo) as DirRow[];
  const qRows: string[] = [];
  for (const r of quarantined) {
    try {
      const p = JSON.parse(r.payload ?? "{}") as Record<string, unknown>;
      const reason = String(p.reason ?? "unknown");
      const ntasks = Array.isArray(p.quarantined_tasks) ? (p.quarantined_tasks as unknown[]).length : 0;
      qRows.push(`${r.directive_id.slice(0, 26)}  ${reason.padEnd(36)}  ${ntasks} task(s)  resume: acc directive resume ${r.directive_id.slice(0, 12)}…`);
    } catch { /* skip */ }
  }
  sections.push(
    formatBlock("quarantined (resumable, last 24h)", qRows.length > 0 ? qRows : ["none"]),
  );

  // Bridge health (current state)
  const bhRow = db
    .query(
      `SELECT kind, ts FROM events
       WHERE kind IN ('bridge_health_degraded', 'bridge_health_recovered')
       ORDER BY ts DESC, rowid DESC LIMIT 1`,
    )
    .get() as { kind: string; ts: string } | null;
  if (bhRow) {
    sections.push(
      formatBlock("bridge", [
        bhRow.kind === "bridge_health_degraded"
          ? `\x1b[31mDEGRADED\x1b[0m since ${bhRow.ts.slice(11, 19)}  (opencode_brain dispatches paused; substrate_replay + claude_inline still active)`
          : `recovered at ${bhRow.ts.slice(11, 19)}`,
      ]),
    );
  } else {
    sections.push(formatBlock("bridge", ["healthy (no degradation events)"]));
  }

  process.stdout.write(sections.join("\n"));
  return 0;
};
