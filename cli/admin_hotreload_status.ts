// `acc admin hotreload-status [--since <iso>] [--json] [--limit N]`
//
// Operator surface for the hot-reload deep-improvement work (commit
// 884fe5a, 2026-05-17). Pre-fix the only window into the worker's
// activity was the daemon's /health endpoint — which is per-process and
// goes away as soon as the daemon stops. This surface reads the
// canonical truth from the events ledger (which survives daemon
// restarts) and gives operators a tight snapshot of:
//
//   - per-outcome totals (swapped / no_op / rejected / unmapped / rate_limited / failed)
//   - recent reload outcomes (most-recent-first) with module + reason
//   - reloadable_slot coverage hint — if no_op is dominant, the
//     manifest needs reloadable_slot wiring to make those swaps real
//
// Source of truth: substrate events table, kinds daemon_hotreload_*.
// Renderer is the same one cli/observe.ts uses for the tail, so the
// CLI and tail stay in lock-step.

import { openDb } from "../substrate/db";
import { resolveDbPath } from "../runtime/state_paths";

type Args = {
  sinceIso?: string;
  limit: number;
  json: boolean;
};

const TRACKED_KINDS = [
  "daemon_hotreload_triggered",
  "daemon_hotreload_swapped",
  "daemon_hotreload_no_op",
  "daemon_hotreload_rejected",
  "daemon_hotreload_unmapped",
  "daemon_hotreload_rate_limited",
  "daemon_hotreload_restart_pending",
  "daemon_hotreload_failed",
  "daemon_hotreload_completed",
] as const;

type Counts = Record<(typeof TRACKED_KINDS)[number], number>;

const parseArgs = (argv: string[]): Args | { error: string } => {
  let sinceIso: string | undefined;
  let limit = 20;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--json") { json = true; continue; }
    if (arg === "--since") {
      const v = argv[++i];
      if (!v || v.startsWith("--")) return { error: "--since requires an ISO timestamp" };
      const d = new Date(v);
      if (Number.isNaN(d.getTime())) return { error: `--since not a valid ISO timestamp: ${v}` };
      sinceIso = d.toISOString();
      continue;
    }
    if (arg === "--limit") {
      const v = argv[++i];
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 0) return { error: "--limit requires a positive integer" };
      limit = Math.min(200, Math.floor(n));
      continue;
    }
    if (arg === "--help" || arg === "-h") return { error: "help" };
    return { error: `unknown flag: ${arg}` };
  }
  return { sinceIso, limit, json };
};

const usage = (): string => `acc admin hotreload-status — last N hot-reload outcomes from the substrate

  Reads daemon_hotreload_* events from the ledger (so it works whether
  the daemon is running or not — the ring buffer is process-local and
  goes away on restart, but the events persist).

  Outcomes (truth-in-audit, 2026-05-17):
    swapped       — reloadable registry accepted the new module; live
                    consumers now see the new code on their next call.
    no_op         — import succeeded BUT the manifest entry has no
                    reloadable_slot, so no consumer reads through an
                    indirection. Live daemon behavior did not change.
                    High no_op count → manifest needs reloadable_slot
                    wiring + a registerReloadable() call in the target
                    module to make swaps real.
    rejected      — new module failed validation (expected_exports
                    missing) or the slot's smoke probe refused it.
                    Previous reference stays active in the registry.
    unmapped      — file changed under a watched directory but no
                    manifest entry matched. Extend HOTRELOAD_MANIFEST.
    rate_limited  — too many reloads of the same file inside its
                    rate_limit.window_ms. Save-loop storm protection
                    kicked in; reloads will resume when the window
                    slides.
    restart_pending — strategy=full_restart entry was edited. Operator
                    runs \`acc daemon restart\` when convenient. NORMAL
                    state, NOT a failure (truth-in-audit, 2026-05-17:
                    pre-fix this signal was mis-emitted as
                    daemon_hotreload_failed and bloated health metrics).
    failed        — the dynamic import threw (syntax error, missing
                    file, etc). Previous reference stays active in the
                    registry; daemon keeps running.
    completed     — LEGACY signal emitted alongside swapped/no_op for
                    backwards-compatibility. Decorative; trust the
                    swapped/no_op pair for what actually happened.

  Flags:
    --since <iso>   restrict to events at or after this timestamp
    --limit N       cap recent outcome rows (default 20, max 200)
    --json          machine-readable output
`;

export const runHotreloadStatus = async (argv: string[]): Promise<number> => {
  const parsed = parseArgs(argv);
  if ("error" in parsed) {
    if (parsed.error === "help") {
      process.stdout.write(usage());
      return 0;
    }
    process.stderr.write(`acc admin hotreload-status: ${parsed.error}\n`);
    process.stderr.write(usage());
    return 1;
  }
  let db;
  try {
    db = openDb(resolveDbPath());
  } catch (err) {
    process.stderr.write(`acc admin hotreload-status: failed to open substrate: ${(err as Error).message}\n`);
    return 1;
  }

  // Counts per kind, optionally filtered by --since.
  const placeholders = TRACKED_KINDS.map(() => "?").join(",");
  const baseQ = `FROM events WHERE kind IN (${placeholders})${parsed.sinceIso ? " AND ts >= ?" : ""}`;
  const params: (string | number)[] = [...TRACKED_KINDS];
  if (parsed.sinceIso) params.push(parsed.sinceIso);
  const rows = db
    .query(`SELECT kind, COUNT(*) AS c ${baseQ} GROUP BY kind`)
    .all(...params) as Array<{ kind: string; c: number }>;
  const counts = TRACKED_KINDS.reduce((acc, k) => {
    acc[k] = 0;
    return acc;
  }, {} as Counts);
  for (const r of rows) {
    if ((TRACKED_KINDS as readonly string[]).includes(r.kind)) {
      counts[r.kind as keyof Counts] = r.c;
    }
  }

  // Recent outcomes (most-recent-first, capped at --limit).
  const recentParams: (string | number)[] = [...TRACKED_KINDS];
  if (parsed.sinceIso) recentParams.push(parsed.sinceIso);
  recentParams.push(parsed.limit);
  const recentRows = db
    .query(
      `SELECT id, ts, kind, payload ${baseQ}
       ORDER BY ts DESC
       LIMIT ?`,
    )
    .all(...recentParams) as Array<{ id: string; ts: string; kind: string; payload: string }>;
  const recent = recentRows.map((r) => {
    let payload: Record<string, unknown> = {};
    try { payload = JSON.parse(r.payload ?? "{}") as Record<string, unknown>; } catch { /* swallow */ }
    return {
      event_id: r.id,
      ts: r.ts,
      kind: r.kind,
      module: (payload.module as string | undefined) ?? null,
      file_path: (payload.file_path as string | undefined) ?? null,
      reason: (payload.reason as string | undefined) ?? null,
      registry_version: (payload.registry_version as number | undefined) ?? null,
      reloadable_slot: (payload.reloadable_slot as string | undefined) ?? null,
    };
  });

  if (parsed.json) {
    process.stdout.write(JSON.stringify({
      generated_at: new Date().toISOString(),
      since: parsed.sinceIso ?? null,
      counts,
      recent_outcomes: recent,
      coverage_hint: counts.daemon_hotreload_no_op > counts.daemon_hotreload_swapped
        ? "no_op > swapped — most reloads aren't reaching live consumers. Wire reloadable_slot on the dominant module(s) and call getReloadable(...).current() at the consumer."
        : null,
    }, null, 2) + "\n");
    return 0;
  }

  // Render plain text.
  process.stdout.write("acc admin hotreload-status — substrate ledger view\n");
  if (parsed.sinceIso) process.stdout.write(`  since: ${parsed.sinceIso}\n`);
  process.stdout.write("─".repeat(72) + "\n");
  process.stdout.write("counts:\n");
  const order: Array<[string, keyof Counts]> = [
    ["triggered      ", "daemon_hotreload_triggered"],
    ["swapped     (✓)", "daemon_hotreload_swapped"],
    ["no_op       (○)", "daemon_hotreload_no_op"],
    ["rejected    (⊘)", "daemon_hotreload_rejected"],
    ["unmapped    (?)", "daemon_hotreload_unmapped"],
    ["rate_limited   ", "daemon_hotreload_rate_limited"],
    ["restart_pnd (↻)", "daemon_hotreload_restart_pending"],
    ["failed      (✗)", "daemon_hotreload_failed"],
    ["completed*     ", "daemon_hotreload_completed"],
  ];
  for (const [label, key] of order) {
    process.stdout.write(`  ${label}  ${counts[key]}\n`);
  }
  process.stdout.write("  * completed = legacy signal; swapped/no_op are the load-bearing pair.\n");

  if (counts.daemon_hotreload_no_op > counts.daemon_hotreload_swapped) {
    process.stdout.write("\n");
    process.stdout.write("hint: no_op > swapped — most reloads aren't reaching live consumers.\n");
    process.stdout.write("      Wire reloadable_slot on the dominant module(s) (manifest) and\n");
    process.stdout.write("      add registerReloadable() in the module + getReloadable(...).current()\n");
    process.stdout.write("      at the consumer call site (see runtime/prompt_composer.ts +\n");
    process.stdout.write("      runtime/task_dispatcher.ts for the canonical pattern).\n");
  }

  process.stdout.write("\n");
  process.stdout.write(`recent outcomes (most-recent first, limit=${parsed.limit}):\n`);
  if (recent.length === 0) {
    process.stdout.write("  (no rows)\n");
    return 0;
  }
  for (const r of recent) {
    const tag = TAG_BY_KIND[r.kind] ?? "?";
    const ts = r.ts.slice(11, 19); // HH:MM:SS
    const mod = r.module ?? "(unmapped)";
    const extra = [
      r.reloadable_slot ? `slot=${r.reloadable_slot}` : "",
      r.registry_version !== null ? `v=${r.registry_version}` : "",
      r.reason ? `reason=${JSON.stringify(r.reason.slice(0, 80))}` : "",
      r.file_path ? `file=${r.file_path}` : "",
    ].filter(Boolean).join(" ");
    process.stdout.write(`  ${ts} ${tag} ${mod.padEnd(28)} ${extra}\n`);
  }
  return 0;
};

const TAG_BY_KIND: Record<string, string> = {
  daemon_hotreload_triggered: "↑",
  daemon_hotreload_swapped: "⇆",
  daemon_hotreload_no_op: "○",
  daemon_hotreload_rejected: "⊘",
  daemon_hotreload_unmapped: "?",
  daemon_hotreload_rate_limited: "⏸",
  daemon_hotreload_restart_pending: "↻",
  daemon_hotreload_failed: "✗",
  daemon_hotreload_completed: "✓",
};
