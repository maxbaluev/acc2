// acc2 proposal grounding validator — structural gate for the
// contract_amendment_proposed shape the brain composes in WORKFLOW_TEXT
// step 6 (runtime/prompt_composer.ts). The brain expressed this as prose;
// this module makes it a function the task_dispatcher.ts task_committed
// admission path can call. Returns `{ok, failed_checks}`; the caller
// decides whether to refuse the commit or refine.
//
// Scope is the task subtree rooted at `taskId`: the task itself plus
// every transitively-refining sub-task discovered via
// `task_edge_recorded { kind: "refines" }`. Four checks run against
// every `contract_amendment_proposed` in the subtree:
//
//   1. event_kind grounding   — every kind-shaped quoted token in the
//      amendment's prose/diff exists in substrate/event_kinds.ts.
//   2. anchor freshness       — when payload.file_path / payload.target_resource
//      names a repo file AND payload.anchor is set, the anchor string
//      must appear literally in that file on disk.
//   3. CLI command grounding  — every `acc <subcommand>` reference exists
//      in cli/dispatch.ts (hard-coded handlers) OR is introduced as a
//      task_node in the same subtree.
//   4. deliverable check      — every deliverable-shaped task_node_opened
//      under the subtree has emitted at least one code_artifact_candidate,
//      contract_amendment_proposed, or lesson_extracted{proposed_action}.

import type { Database } from "bun:sqlite";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { JsonValue } from "../substrate/types";
import { EVENT_KINDS } from "../substrate/event_kinds";

export interface ProposalGroundingResult {
  ok: boolean;
  failed_checks: string[];
}

const REPO_ROOT = join(import.meta.dir, "..");
const DELIVERABLE_VERBS = ["expose", "add", "wire", "implement", "build", "create", "propose", "emit"];

const parsePayload = (raw: string): Record<string, JsonValue> => {
  try { return JSON.parse(raw ?? "{}") as Record<string, JsonValue>; } catch { return {}; }
};

const collectSubtreeTaskIds = (db: Database, rootTaskId: string): Set<string> => {
  const subtree = new Set<string>([rootTaskId]);
  const edges = db
    .query("SELECT payload FROM events WHERE kind = 'task_edge_recorded'")
    .all() as Array<{ payload: string }>;
  const refinesByParent = new Map<string, string[]>();
  for (const e of edges) {
    const p = parsePayload(e.payload);
    if ((p.kind as string) !== "refines") continue;
    const from = p.from_task as string | undefined;
    const to = p.to_task as string | undefined;
    if (!from || !to) continue;
    const list = refinesByParent.get(from) ?? [];
    list.push(to);
    refinesByParent.set(from, list);
  }
  const queue = [rootTaskId];
  while (queue.length > 0) {
    const next = queue.shift()!;
    for (const child of refinesByParent.get(next) ?? []) {
      if (subtree.has(child)) continue;
      subtree.add(child);
      queue.push(child);
    }
  }
  return subtree;
};

const eventsForTasks = (db: Database, taskIds: Set<string>, kind: string): Array<{ task_id: string; payload: Record<string, JsonValue> }> => {
  if (taskIds.size === 0) return [];
  const placeholders = Array.from(taskIds).map(() => "?").join(",");
  const rows = db
    .query(`SELECT task_id, payload FROM events WHERE kind = ? AND task_id IN (${placeholders})`)
    .all(kind, ...Array.from(taskIds)) as Array<{ task_id: string; payload: string }>;
  return rows.map((r) => ({ task_id: r.task_id, payload: parsePayload(r.payload) }));
};

const stringifyAmendmentForScan = (p: Record<string, JsonValue>): string => {
  // Concatenate the prose values only (NOT the wrapping JSON keys) so the
  // kind-name regex below catches quoted tokens authored by the brain
  // inside the prose, not the field names themselves.
  const parts: string[] = [];
  const collect = (v: JsonValue): void => {
    if (typeof v === "string") parts.push(v);
    else if (Array.isArray(v)) v.forEach(collect);
    else if (v !== null && typeof v === "object") Object.values(v).forEach(collect);
  };
  collect(p.proposed_behavior ?? "");
  collect(p.current_behavior ?? "");
  collect(p.kind ?? "");
  collect(p.diff ?? "");
  return parts.join("\n");
};

const checkEventKinds = (text: string): string[] => {
  const failed: string[] = [];
  const matches = text.matchAll(/"([a-z][a-z0-9_]+)"/g);
  const seen = new Set<string>();
  for (const m of matches) {
    const candidate = m[1]!;
    if (candidate.length < 8 || candidate.includes(".")) continue;
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    // Heuristic: only count snake_case tokens with at least one underscore
    // as event-kind candidates. Single-word tokens like "directive" or
    // "anchor" would otherwise be flagged unfairly.
    if (!candidate.includes("_")) continue;
    if (!(candidate in EVENT_KINDS)) failed.push(`unknown_event_kind:${candidate}`);
  }
  return failed;
};

const checkAnchor = (p: Record<string, JsonValue>): string[] => {
  const filePath = (p.file_path as string | undefined) ??
    (typeof p.target_resource === "string" && p.target_resource.startsWith("repo:")
      ? p.target_resource.slice("repo:".length)
      : undefined);
  const anchor = p.anchor as string | undefined;
  if (!filePath || !anchor) return [];
  const absPath = filePath.startsWith("/") ? filePath : join(REPO_ROOT, filePath);
  if (!existsSync(absPath)) return [`anchor_file_not_found:${filePath}`];
  try {
    const body = readFileSync(absPath, "utf-8");
    if (!body.includes(anchor)) return [`anchor_not_in_source:${filePath}`];
  } catch { return [`anchor_file_not_found:${filePath}`]; }
  return [];
};

let dispatchCliCacheLines: string | null = null;
const loadDispatchSubcommands = (): Set<string> => {
  if (dispatchCliCacheLines === null) {
    try { dispatchCliCacheLines = readFileSync(join(REPO_ROOT, "cli", "dispatch.ts"), "utf-8"); }
    catch { dispatchCliCacheLines = ""; }
  }
  const subs = new Set<string>();
  const re = /cmd === "([a-z]+)"/g;
  for (const m of dispatchCliCacheLines!.matchAll(re)) subs.add(m[1]!);
  return subs;
};

const checkCliCommands = (text: string, subtreeGoals: string[]): string[] => {
  const failed: string[] = [];
  const known = loadDispatchSubcommands();
  const seen = new Set<string>();
  for (const m of text.matchAll(/\bacc\s+([a-z]+)/g)) {
    const root = m[1]!;
    if (seen.has(root)) continue;
    seen.add(root);
    if (known.has(root)) continue;
    const introducedInDag = subtreeGoals.some((g) => {
      const lower = g.toLowerCase();
      return lower.includes(root) && (lower.includes("subcommand") || lower.includes("cli"));
    });
    if (!introducedInDag) failed.push(`vapor_cli_command:acc ${root}`);
  }
  return failed;
};

const isDeliverableGoal = (goal: string): boolean => {
  const lower = goal.toLowerCase();
  return DELIVERABLE_VERBS.some((v) => new RegExp(`\\b${v}\\b`).test(lower));
};

export const validateProposalGrounding = (db: Database, taskId: string): ProposalGroundingResult => {
  const subtree = collectSubtreeTaskIds(db, taskId);
  const failed: string[] = [];

  const amendments = eventsForTasks(db, subtree, "contract_amendment_proposed");
  const nodes = eventsForTasks(db, subtree, "task_node_opened");
  const artifacts = eventsForTasks(db, subtree, "code_artifact_candidate");
  const lessons = eventsForTasks(db, subtree, "lesson_extracted");
  const subtreeGoals = nodes.map((n) => (n.payload.goal as string) ?? "");

  for (const a of amendments) {
    const text = stringifyAmendmentForScan(a.payload);
    failed.push(...checkEventKinds(text));
    failed.push(...checkAnchor(a.payload));
    failed.push(...checkCliCommands(text, subtreeGoals));
  }

  for (const n of nodes) {
    const goal = (n.payload.goal as string) ?? "";
    if (!isDeliverableGoal(goal)) continue;
    const has = amendments.some((a) => a.task_id === n.task_id) ||
      artifacts.some((c) => c.task_id === n.task_id) ||
      lessons.some((l) => l.task_id === n.task_id && Boolean(l.payload.proposed_action));
    if (!has) failed.push(`deliverable_missing:${n.task_id}`);
  }

  return { ok: failed.length === 0, failed_checks: failed };
};
