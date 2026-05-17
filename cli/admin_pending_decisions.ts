// `acc admin pending-decisions` — owner-decision inbox.
//
// Defaults to the ranked, de-duplicated projection from
// pending_owner_decision_queue_view (substrate/views.ts). Per the brain's
// design (lesson KHA109RW5972D2BZMYQ63HX0F4) the orchestrator should never
// dump 92 rows when 4 grouped ranked rows tell the same story; nor should
// it silently miss decisions because the raw queue counts approves but not
// declines. This surface fixes both:
//
//   - Default mode: top N groups by decision_rank, with duplicate_count
//     and group_decline_reason exposed so the operator can bulk-decline
//     malformed shapes in one stroke.
//   - --all: ungrouped legacy projection (lesson_implementer_queue_view).
//   - --target <substr>: filter rows whose normalized_target contains substr.
//   - --limit N: cap the ranked output (default 10).
//   - --json: machine-readable for orchestrator polling.
//   - --auto-decline-malformed [--yes]: bulk-emit owner_decision_recorded
//     decline=true for every group whose decline_candidate_reason is set
//     (anchor_missing, diff_missing, empty_after, empty_before). The
//     operator running this command IS the owner; the gate enforces an
//     explicit --yes so a typo doesn't drain real decisions.
//
// Usage:
//   acc admin pending-decisions                       # ranked top 10
//   acc admin pending-decisions --limit 20            # top 20 groups
//   acc admin pending-decisions --target rules        # filter by substring
//   acc admin pending-decisions --all                 # raw ungrouped view
//   acc admin pending-decisions --json                # JSON (ranked by default)
//   acc admin pending-decisions --all --json          # JSON ungrouped
//   acc admin pending-decisions --auto-decline-malformed --yes
//                                                     # bulk-decline malformed shapes

import type { Database } from "bun:sqlite";
import { openDb } from "../substrate/db";
import { emitEvent } from "../runtime/events";
import {
  lessonImplementerQueue,
  pendingOwnerDecisionQueue,
  runViews,
  type LessonImplementerQueueRow,
  type PendingOwnerDecisionRow,
} from "../substrate/views";
import { resolveDbPath } from "../runtime/state_paths";

type PendingDecisionsEnv = {
  out: (s: string) => void;
  err: (s: string) => void;
  stateDbPath?: string;
  openSubstrate?: (path?: string) => Database;
};

const defaultEnv = (): PendingDecisionsEnv => ({
  out: (s) => console.log(s),
  err: (s) => console.error(s),
});

const defaultStateDbPath = (): string => resolveDbPath();

export const selectPendingDecisions = (
  rows: LessonImplementerQueueRow[],
): LessonImplementerQueueRow[] =>
  rows.filter(
    (r) =>
      r.owner_gate_verdict === "owner_consent_required" &&
      r.apply_status !== "applied" &&
      r.apply_status !== "committed",
  );

const ageMs = (tsIso: string): number => Date.now() - Date.parse(tsIso);

const formatAge = (ms: number): string => {
  if (!Number.isFinite(ms) || ms < 0) return "?";
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem === 0 ? `${h}h` : `${h}h${rem}m`;
};

const pad = (s: string | null, n: number): string =>
  (s ?? "").slice(0, n).padEnd(n);

const renderRanked = (
  rows: PendingOwnerDecisionRow[],
  out: (s: string) => void,
): void => {
  if (rows.length === 0) {
    out("pending owner decisions: none (pending_owner_decision_queue_view is empty)");
    return;
  }
  out("acc admin pending-decisions — ranked groups from pending_owner_decision_queue_view");
  out("");
  out("  rank  age    dup risk shape target                                          anchor                                  representative");
  out("  ──── ────── ─── ──── ───── ─────────────────────────────────────────────── ─────────────────────────────────────── ──────────────────────────");
  for (const r of rows) {
    const rank = r.decision_rank.toFixed(2).padStart(4);
    const age = formatAge(ageMs(r.newest_ts)).padEnd(6);
    const dup = String(r.duplicate_count).padStart(3);
    const risk = r.target_risk_score.toFixed(2).padStart(4);
    const shape = r.shape_quality_score.toFixed(2).padStart(5);
    const target = pad(r.target, 47);
    const anchor = pad(r.anchor, 39);
    const rep = (r.representative_event_id ?? "").slice(0, 26);
    const declineMark = r.group_decline_reason ? ` [decline:${r.group_decline_reason}]` : "";
    out(`  ${rank} ${age} ${dup} ${risk} ${shape} ${target} ${anchor} ${rep}${declineMark}`);
  }
  out("");
  const declineCount = rows.filter((r) => r.group_decline_reason).length;
  out(
    `${rows.length} pending group${rows.length === 1 ? "" : "s"}` +
      (declineCount > 0
        ? ` (${declineCount} are auto-decline candidates — anchor missing, empty after-text, or malformed diff).`
        : "."),
  );
};

const renderAll = (
  rows: LessonImplementerQueueRow[],
  out: (s: string) => void,
): void => {
  if (rows.length === 0) {
    out("pending owner decisions: none (substrate has no owner-gated, unapplied proposals)");
    return;
  }
  out("acc admin pending-decisions --all — raw ungrouped lesson_implementer_queue_view rows");
  out("");
  out("  age   source                          target                                                anchor");
  out("  ───── ─────────────────────────────── ───────────────────────────────────────────────────── ───────────────────────────────");
  for (const r of rows) {
    const age = formatAge(ageMs(r.ts)).padEnd(5);
    const src = pad(r.source_event_id, 31);
    const target = pad(r.target, 53);
    const anchor = pad(r.anchor, 31);
    out(`  ${age} ${src} ${target} ${anchor}`);
  }
  out("");
  out(`${rows.length} pending owner decision${rows.length === 1 ? "" : "s"}.`);
};

const parseLimitArg = (argv: string[]): number => {
  const idx = argv.indexOf("--limit");
  if (idx === -1) return 10;
  const v = parseInt(argv[idx + 1] ?? "10", 10);
  return Number.isFinite(v) && v > 0 ? v : 10;
};

const parseTargetArg = (argv: string[]): string | null => {
  const idx = argv.indexOf("--target");
  if (idx === -1) return null;
  return argv[idx + 1] ?? null;
};

export const runPendingDecisions = async (
  argv: string[],
  envOverride?: PendingDecisionsEnv,
): Promise<number> => {
  const env: PendingDecisionsEnv = { ...defaultEnv(), ...(envOverride ?? {}) };
  const wantJson = argv.includes("--json");
  const wantAll = argv.includes("--all");
  const limit = parseLimitArg(argv);
  const targetFilter = parseTargetArg(argv);

  let db: Database;
  const path = env.stateDbPath ?? defaultStateDbPath();
  try {
    db = (env.openSubstrate ?? ((p?: string) => openDb(p ?? defaultStateDbPath())))(path);
  } catch (err) {
    env.err(`acc admin pending-decisions: failed to open substrate: ${(err as Error).message}`);
    return 1;
  }

  runViews(db);

  if (wantAll) {
    const all = selectPendingDecisions(lessonImplementerQueue(db));
    const filtered = targetFilter
      ? all.filter((r) => (r.target ?? "").includes(targetFilter))
      : all;
    if (wantJson) {
      env.out(JSON.stringify(filtered, null, 2));
    } else {
      renderAll(filtered, env.out);
    }
    return 0;
  }

  const ranked = pendingOwnerDecisionQueue(db);

  // Auto-decline-malformed mode: drain every group whose
  // decline_candidate_reason is set. Operator types --auto-decline-malformed
  // --yes once; the substrate gets owner_decision_recorded decline=true
  // for every group representative + ungrouped member. Each emission
  // cites the group_key + reason so a future audit knows why.
  const wantAutoDecline = argv.includes("--auto-decline-malformed");
  if (wantAutoDecline) {
    const wantYes = argv.includes("--yes") || argv.includes("-y");
    const declinables = ranked.filter((r) => r.group_decline_reason !== null);
    if (declinables.length === 0) {
      env.out("acc admin pending-decisions --auto-decline-malformed: no malformed groups to decline (group_decline_reason was null for every ranked row).");
      return 0;
    }
    if (!wantYes) {
      env.err(
        `acc admin pending-decisions --auto-decline-malformed: ${declinables.length} groups match (` +
          `${declinables.reduce((a, r) => a + r.duplicate_count, 0)} total proposals would be declined). Pass --yes to apply.`,
      );
      for (const r of declinables.slice(0, 5)) {
        env.err(`  • ${r.target ?? "?"}  ×${r.duplicate_count}  decline:${r.group_decline_reason}`);
      }
      if (declinables.length > 5) env.err(`  • …and ${declinables.length - 5} more.`);
      return 1;
    }
    let declined = 0;
    let groups = 0;
    for (const r of declinables) {
      // Find every member of this group (same group_key) and decline each.
      type Mem = { id: string; ts: string };
      const members = db
        .query(
          `WITH base AS (
             SELECT q.source_event_id AS id, q.ts,
                    CASE WHEN q.target LIKE 'repo:%' THEN substr(q.target, 6) ELSE q.target END AS normalized_target,
                    q.anchor
             FROM lesson_implementer_queue_view q
             WHERE (q.owner_gate_required = 1 OR q.apply_gate_status = 'manual_review')
               AND q.apply_status IS NULL
               AND (q.candidate_diff IS NULL OR json_valid(q.candidate_diff) = 1)
           )
           SELECT id, ts FROM base
           WHERE (COALESCE(normalized_target, '?') || '|' || COALESCE(anchor, '')) = ?`,
        )
        .all(r.group_key) as Mem[];
      for (const m of members) {
        try {
          emitEvent(db, {
            kind: "owner_decision_recorded",
            substrate_origin: "owner",
            payload: {
              source_event_id: m.id,
              decision: "decline",
              reason: `auto_decline_malformed:${r.group_decline_reason}`,
              group_key: r.group_key,
              triggered_by: "acc admin pending-decisions --auto-decline-malformed",
            },
            context_refs: [m.id],
          });
          declined++;
        } catch (err) {
          env.err(`  ! failed to decline ${m.id}: ${(err as Error).message}`);
        }
      }
      groups++;
    }
    env.out(`acc admin pending-decisions --auto-decline-malformed: declined ${declined} proposals across ${groups} groups.`);
    return 0;
  }

  const filtered = targetFilter
    ? ranked.filter((r) => (r.target ?? "").includes(targetFilter))
    : ranked;
  const limited = filtered.slice(0, limit);

  if (wantJson) {
    env.out(JSON.stringify(limited, null, 2));
  } else {
    renderRanked(limited, env.out);
    if (filtered.length > limit) {
      env.out("");
      env.out(`(${filtered.length - limit} more rows hidden; pass --limit ${filtered.length} to show all.)`);
    }
  }
  return 0;
};

if (import.meta.main) {
  void runPendingDecisions(process.argv.slice(2)).then((code) => process.exit(code));
}
