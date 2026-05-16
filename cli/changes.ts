#!/usr/bin/env bun
// acc changes - chronological feed of actual world/source changes.
//
// This is intentionally narrower than acc events: it shows change-bearing
// ledger facts only, with directive/task context attached so the owner can
// answer "what actually changed?" without reading raw logs.

import type { Database } from "bun:sqlite";
import { openDb } from "../substrate/db";
import { resolveDbPath } from "../runtime/state_paths";
import type { EventKind } from "../substrate/event_kinds";

const HELP = `acc changes [7d|24h|1h] [--json]

  Chronological feed of actual world/source changes.

  Sources:
    applied_change_committed     source apply attempts and commits
    irreversible_effect_recorded physical/world effects
    directive_closed             finite directive completion
    task_closure_audited         closure verifier residuals
    irreversible_effects_view    per-directive effect counts

  Default window: 24h.
`;

const CHANGE_KINDS = [
  "applied_change_committed",
  "irreversible_effect_recorded",
  "directive_closed",
  "task_closure_audited",
] as const satisfies readonly EventKind[];

type ChangeKind = typeof CHANGE_KINDS[number];

type RawRow = {
  id: string;
  ts: string;
  kind: ChangeKind;
  directive_id: string;
  task_id: string;
  payload: string;
  context_refs: string;
  residual: number | null;
  source_event_id: string | null;
  source_kind: string | null;
  source_payload: string | null;
  directive_payload: string | null;
  task_payload: string | null;
};

export type ChangeFeedItem = {
  event_id: string;
  ts: string;
  kind: ChangeKind;
  category: "source_change" | "world_effect" | "directive_closed" | "closure_audit";
  directive_id: string;
  task_id: string;
  directive_text: string | null;
  task_goal: string | null;
  source_event_id: string | null;
  source_kind: string | null;
  status: string | null;
  target: string | null;
  commit_sha: string | null;
  residual: number | null;
  closure_residual: number | null;
  irreversible_effect_count: number | null;
  summary: string;
  context_refs: string[];
};

export type ChangesFeed = {
  window: string;
  since: string;
  generated_at: string;
  count: number;
  changes: ChangeFeedItem[];
};

const parseJson = (raw: unknown): Record<string, unknown> => {
  if (!raw) return {};
  if (typeof raw !== "string") return raw as Record<string, unknown>;
  try { return JSON.parse(raw) as Record<string, unknown>; } catch { return {}; }
};

const parseArray = (raw: unknown): string[] => {
  try {
    const v = JSON.parse(String(raw ?? "[]"));
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
};

const stringField = (p: Record<string, unknown>, keys: readonly string[]): string | null => {
  for (const key of keys) {
    const v = p[key];
    if (typeof v === "string" && v.trim().length > 0) return v.trim();
  }
  return null;
};

const numField = (p: Record<string, unknown>, keys: readonly string[]): number | null => {
  for (const key of keys) {
    const v = p[key];
    const n = typeof v === "number" ? v : Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
};

const trunc = (s: string | null | undefined, n = 96): string => {
  const flat = String(s ?? "").replace(/\s+/g, " ").trim();
  return flat.length > n ? `${flat.slice(0, n - 1)}...` : flat;
};

const shortId = (id: string | null | undefined, n = 12): string => {
  if (!id) return "-";
  return id.length > n ? id.slice(0, n) : id;
};

const durationToMs = (window: string): number | null => {
  const m = window.match(/^(\d+)([hd])$/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  return m[2] === "d" ? n * 24 * 60 * 60 * 1000 : n * 60 * 60 * 1000;
};

const categoryFor = (kind: ChangeKind): ChangeFeedItem["category"] => {
  if (kind === "applied_change_committed") return "source_change";
  if (kind === "irreversible_effect_recorded") return "world_effect";
  if (kind === "directive_closed") return "directive_closed";
  return "closure_audit";
};

const summarize = (kind: ChangeKind, payload: Record<string, unknown>, sourceKind: string | null, effectCount: number | null): string => {
  if (kind === "applied_change_committed") {
    const status = stringField(payload, ["status"]) ?? "applied";
    const target = stringField(payload, ["target", "target_resource", "resource_uri"]);
    const commit = stringField(payload, ["commit_sha"]);
    const residual = numField(payload, ["residual"]);
    const summary = stringField(payload, ["summary", "reason"]);
    return [
      `status=${status}`,
      sourceKind ? `source=${sourceKind}` : "",
      target ? `target=${target}` : "",
      commit ? `commit=${commit.slice(0, 10)}` : "",
      residual !== null ? `residual=${residual}` : "",
      summary ? `summary=${JSON.stringify(trunc(summary, 80))}` : "",
    ].filter(Boolean).join(" ");
  }
  if (kind === "irreversible_effect_recorded") {
    const effect = stringField(payload, ["description", "summary", "effect", "kind", "reason"]);
    return [
      effect ? `effect=${JSON.stringify(trunc(effect, 90))}` : "effect=(recorded)",
      effectCount !== null ? `directive_effects=${effectCount}` : "",
    ].filter(Boolean).join(" ");
  }
  if (kind === "directive_closed") {
    const reason = stringField(payload, ["reason", "summary"]);
    return reason ? `reason=${JSON.stringify(trunc(reason, 90))}` : "directive closed";
  }
  const closureResidual = numField(payload, ["closure_residual"]);
  const summary = stringField(payload, ["summary", "owner_summary", "verdict"]);
  return [
    closureResidual !== null ? `closure_residual=${closureResidual}` : "closure_residual=?",
    summary ? `summary=${JSON.stringify(trunc(summary, 90))}` : "",
  ].filter(Boolean).join(" ");
};

export const buildChangesFeed = (db: Database, opts: { window?: string; now?: Date } = {}): ChangesFeed | null => {
  const window = opts.window ?? "24h";
  const ms = durationToMs(window);
  if (ms === null) return null;
  const now = opts.now ?? new Date();
  const since = new Date(now.getTime() - ms).toISOString();
  const placeholders = CHANGE_KINDS.map(() => "?").join(",");
  const rows = db.query(
    `SELECT
       e.id, e.ts, e.kind, e.directive_id, e.task_id, e.payload, e.context_refs, e.residual,
       COALESCE(json_extract(e.payload, '$.source_event_id'), json_extract(e.context_refs, '$[0]')) AS source_event_id,
       s.kind AS source_kind,
       s.payload AS source_payload,
       (SELECT d.payload FROM events d
          WHERE d.directive_id = e.directive_id AND d.kind = 'directive_opened'
          ORDER BY d.ts ASC LIMIT 1) AS directive_payload,
       (SELECT n.payload FROM events n
          WHERE n.task_id = e.task_id AND n.kind = 'task_node_opened'
          ORDER BY n.ts ASC LIMIT 1) AS task_payload
     FROM events e
     LEFT JOIN events s ON s.id = COALESCE(json_extract(e.payload, '$.source_event_id'), json_extract(e.context_refs, '$[0]'))
     WHERE e.kind IN (${placeholders})
       AND e.ts >= ?
     ORDER BY e.ts ASC, e.id ASC`,
  ).all(...CHANGE_KINDS, since) as RawRow[];

  const effectRows = db.query("SELECT directive_id, effect_count FROM irreversible_effects_view").all() as Array<{ directive_id: string; effect_count: number }>;
  const effectsByDirective = new Map(effectRows.map((r) => [r.directive_id, Number(r.effect_count)]));

  const changes = rows.map((row): ChangeFeedItem => {
    const payload = parseJson(row.payload);
    const directivePayload = parseJson(row.directive_payload);
    const taskPayload = parseJson(row.task_payload);
    const sourcePayload = parseJson(row.source_payload);
    const sourceKind = row.source_kind ?? stringField(payload, ["source_kind"]);
    const residual = row.residual ?? numField(payload, ["residual"]);
    const closureResidual = row.kind === "task_closure_audited" ? numField(payload, ["closure_residual"]) ?? residual : null;
    const effectCount = row.kind === "irreversible_effect_recorded" ? effectsByDirective.get(row.directive_id) ?? null : null;
    return {
      event_id: row.id,
      ts: row.ts,
      kind: row.kind,
      category: categoryFor(row.kind),
      directive_id: row.directive_id,
      task_id: row.task_id,
      directive_text: stringField(directivePayload, ["directive_text", "text", "goal", "intent"]),
      task_goal: stringField(taskPayload, ["goal", "intent", "summary"]),
      source_event_id: row.source_event_id ?? stringField(payload, ["source_event_id"]),
      source_kind: sourceKind,
      status: stringField(payload, ["status"]),
      target: stringField(payload, ["target", "target_resource", "resource_uri", "file_path"]) ?? stringField(sourcePayload, ["target", "target_resource", "resource_uri", "file_path"]),
      commit_sha: stringField(payload, ["commit_sha"]),
      residual,
      closure_residual: closureResidual,
      irreversible_effect_count: effectCount,
      summary: summarize(row.kind, payload, sourceKind, effectCount),
      context_refs: parseArray(row.context_refs),
    };
  });

  return { window, since, generated_at: now.toISOString(), count: changes.length, changes };
};

export const renderChangesFeed = (feed: ChangesFeed): string => {
  const lines = [`changes since ${feed.window} (${feed.count})`, `since=${feed.since}`];
  if (feed.changes.length === 0) {
    lines.push("(none)");
    return lines.join("\n");
  }
  for (const item of feed.changes) {
    lines.push(`${item.ts} ${item.category.padEnd(13)} ${item.kind.padEnd(28)} dir=${shortId(item.directive_id)} task=${shortId(item.task_id)} ${item.summary}`.trimEnd());
    const context = [
      item.directive_text ? `directive=${JSON.stringify(trunc(item.directive_text, 90))}` : "",
      item.task_goal && item.task_goal !== item.directive_text ? `task=${JSON.stringify(trunc(item.task_goal, 90))}` : "",
      item.source_event_id ? `source_event=${shortId(item.source_event_id)}` : "",
    ].filter(Boolean).join(" ");
    if (context) lines.push(`  ${context}`);
  }
  return lines.join("\n");
};

const parseArgs = (argv: string[]): { json: boolean; help: boolean; window: string } => {
  let json = false;
  let help = false;
  let window = "24h";
  for (const arg of argv) {
    if (arg === "--json") json = true;
    else if (arg === "--help" || arg === "-h" || arg === "help") help = true;
    else if (!arg.startsWith("--")) window = arg;
  }
  return { json, help, window };
};

export const runChanges = async (argv: string[]): Promise<number> => {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(HELP + "\n");
    return 0;
  }
  const db = openDb(resolveDbPath());
  const feed = buildChangesFeed(db, { window: args.window });
  if (!feed) {
    process.stderr.write(`acc changes: invalid window '${args.window}' (expected e.g. 7d, 24h, 1h)\n`);
    return 1;
  }
  process.stdout.write((args.json ? JSON.stringify(feed, null, 2) : renderChangesFeed(feed)) + "\n");
  return 0;
};

if (import.meta.main) {
  void runChanges(process.argv.slice(2)).then((code) => process.exit(code));
}
