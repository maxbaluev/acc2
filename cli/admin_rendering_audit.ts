// `acc admin rendering-audit` — operator report on the owner-rendering loop.
//
// Joins owner_rendering_effectiveness_view × owner_rendering_policy_view
// so the operator can answer at a glance:
//   - which surfaces (tui, chat, export) are leaking most?
//   - which renderers (brain_opencode, claude_orchestrator, claude_inline)
//     score worst on which axes?
//   - is policy_health rising or falling — is the loop CONVERGING?
//
// Surfaces three formats:
//   default → grouped summary (per renderer + audience)
//   --json  → structured rows
//   --raw   → full effectiveness rows (one per render)
//
// Cite: brain contract Q471RAN88X0H513V8BC3BTW0AW (the loop this reports
// on); knowledge_candidate 88ESCTN8XN6J (operators need a consumer surface
// for the flywheel — auto_verifier feedback is in the ledger but invisible
// without a report).

import { openDb } from "../substrate/db";
import {
  ownerRenderingEffectiveness,
  ownerRenderingPolicy,
  type OwnerRenderingEffectivenessRow,
} from "../substrate/views";
import { resolveDbPath } from "../runtime/state_paths";

export type AdminRenderingAuditEnv = {
  out: (line: string) => void;
  err: (line: string) => void;
  openSubstrate?: (path?: string) => ReturnType<typeof openDb>;
  stateDbPath?: string;
};

const defaultEnv: AdminRenderingAuditEnv = {
  out: (line) => process.stdout.write(line + "\n"),
  err: (line) => process.stderr.write(line + "\n"),
  openSubstrate: (path?: string) => openDb(path ?? resolveDbPath()),
};

type Group = {
  key: string;
  renderer: string;
  audience: string;
  surface: string;
  positive: number;
  negative: number;
  mixed: number;
  pending: number;
  other: number;
  total: number;
};

const groupRows = (rows: OwnerRenderingEffectivenessRow[]): Group[] => {
  const m = new Map<string, Group>();
  for (const r of rows) {
    const key = `${r.renderer ?? "?"}|${r.audience ?? "?"}|${r.surface ?? "?"}`;
    let g = m.get(key);
    if (!g) {
      g = {
        key,
        renderer: r.renderer ?? "?",
        audience: r.audience ?? "?",
        surface: r.surface ?? "?",
        positive: 0, negative: 0, mixed: 0, pending: 0, other: 0, total: 0,
      };
      m.set(key, g);
    }
    g[r.effectiveness_band] += 1;
    g.total += 1;
  }
  return Array.from(m.values()).sort((a, b) => b.total - a.total);
};

const renderSummary = (env: AdminRenderingAuditEnv, rows: OwnerRenderingEffectivenessRow[]): void => {
  if (rows.length === 0) {
    env.out("acc admin rendering-audit: no rendered_owner_message_recorded rows in the substrate yet.");
    env.out("  → render something (acc emit rendered_owner_message_recorded ... or run `acc task`) to populate.");
    return;
  }
  const groups = groupRows(rows);
  env.out(`acc admin rendering-audit — ${rows.length} render(s) across ${groups.length} (renderer, audience, surface) group(s)`);
  env.out("");
  const header = "  renderer / audience / surface              positive  negative  mixed  pending  other  total";
  env.out(header);
  env.out(`  ${"".padEnd(header.length - 2, "─")}`);
  for (const g of groups) {
    const label = `${g.renderer} / ${g.audience} / ${g.surface}`.padEnd(42, " ");
    const ratioPos = g.total > 0 ? `${(g.positive / g.total * 100).toFixed(0)}%` : "—";
    const ratioNeg = g.total > 0 ? `${(g.negative / g.total * 100).toFixed(0)}%` : "—";
    env.out(
      `  ${label}` +
      `  ${String(g.positive).padStart(7, " ")} (${ratioPos.padStart(4, " ")})` +
      `  ${String(g.negative).padStart(7, " ")} (${ratioNeg.padStart(4, " ")})` +
      `  ${String(g.mixed).padStart(5, " ")}` +
      `  ${String(g.pending).padStart(7, " ")}` +
      `  ${String(g.other).padStart(5, " ")}` +
      `  ${String(g.total).padStart(5, " ")}`,
    );
  }
};

const renderPolicySnapshot = (env: AdminRenderingAuditEnv, policy: Awaited<ReturnType<typeof ownerRenderingPolicy>>): void => {
  env.out("");
  if (!policy) {
    env.out("owner_rendering_policy: (no owner_profile_recorded row yet — default invariants apply)");
    return;
  }
  env.out("owner_rendering_policy snapshot:");
  env.out(`  policy_health:           ${policy.policy_health.toFixed(2)} (1.0 clean; below 0.7 routes to careful-render)`);
  env.out(`  recent_corrections (14d): ${policy.recent_correction_count}`);
  env.out(`  recent_declines (14d):   ${policy.recent_decline_count}`);
  env.out(`  recent_ignored (14d):    ${policy.recent_ignored_count}`);
  env.out(`  recent_satisfaction (14d): ${policy.recent_satisfaction_count}`);
  env.out(`  recent_overrides (14d):  ${policy.recent_override_count}`);
  if (policy.preferred_terms.length > 0) env.out(`  preferred_terms:         ${policy.preferred_terms.slice(0, 8).join(", ")}`);
  if (policy.avoided_terms.length > 0) env.out(`  avoided_terms:           ${policy.avoided_terms.slice(0, 8).join(", ")}`);
  if (policy.things_to_never_do.length > 0) env.out(`  things_to_never_do:      ${policy.things_to_never_do.slice(0, 4).join("; ")}`);
};

const HELP = `acc admin rendering-audit — owner-rendering loop report

usage: acc admin rendering-audit [--json | --raw] [--surface S] [--audience A] [--limit N]

  Joins owner_rendering_effectiveness_view × owner_rendering_policy_view
  so the operator can see which renderer/audience/surface tuple is leaking
  the most policy violations (per axis) and whether the loop is converging.

  --json       structured JSON (groups + policy snapshot)
  --raw        one row per render (no grouping)
  --surface S  filter by surface (e.g. tui, chat, export)
  --audience A filter by audience (primary, detail_drawer)
  --limit N    max rows to read (default 200)

  The auto-verifier worker (runtime/rendering_audit_worker.ts) emits
  feedback_kind=auto_verifier on residuals ≥ 0.3 and auto_verifier_clean
  below — both visible in --raw view as the feedback_kind column.
`;

const parseArgs = (argv: string[]): {
  format: "summary" | "json" | "raw";
  surface?: string;
  audience?: string;
  limit?: number;
} => {
  let format: "summary" | "json" | "raw" = "summary";
  if (argv.includes("--json")) format = "json";
  if (argv.includes("--raw")) format = "raw";
  const surfaceIdx = argv.indexOf("--surface");
  const audienceIdx = argv.indexOf("--audience");
  const limitIdx = argv.indexOf("--limit");
  const surface = surfaceIdx >= 0 ? argv[surfaceIdx + 1] : undefined;
  const audience = audienceIdx >= 0 ? argv[audienceIdx + 1] : undefined;
  const limit = limitIdx >= 0 ? Number(argv[limitIdx + 1]) : undefined;
  return { format, surface, audience, limit: Number.isFinite(limit) ? limit : undefined };
};

export const runRenderingAudit = async (argv: string[], envOverride?: Partial<AdminRenderingAuditEnv>): Promise<number> => {
  const env: AdminRenderingAuditEnv = { ...defaultEnv, ...envOverride };
  if (argv.includes("--help") || argv.includes("-h")) {
    env.out(HELP);
    return 0;
  }
  const { format, surface, audience, limit } = parseArgs(argv);
  const open = env.openSubstrate ?? defaultEnv.openSubstrate!;
  let db: ReturnType<typeof openDb>;
  try {
    db = open(env.stateDbPath);
  } catch (e) {
    env.err(`acc admin rendering-audit: cannot open substrate: ${(e as Error).message}`);
    return 1;
  }
  let rows: OwnerRenderingEffectivenessRow[];
  let policy: Awaited<ReturnType<typeof ownerRenderingPolicy>>;
  try {
    rows = ownerRenderingEffectiveness(db, { audience, surface, limit });
    policy = ownerRenderingPolicy(db);
  } catch (e) {
    env.err(`acc admin rendering-audit: query failed: ${(e as Error).message}`);
    return 1;
  }

  if (format === "json") {
    env.out(JSON.stringify({ groups: groupRows(rows), rows_total: rows.length, policy }, null, 2));
    return 0;
  }
  if (format === "raw") {
    if (rows.length === 0) {
      env.out("(no rendered_owner_message_recorded rows)");
      return 0;
    }
    env.out("ts                    band      renderer / audience / surface              residual  feedback_kind");
    for (const r of rows) {
      const ts = r.rendered_ts.slice(0, 19);
      const label = `${r.renderer ?? "?"} / ${r.audience ?? "?"} / ${r.surface ?? "?"}`.slice(0, 42).padEnd(42, " ");
      const residual = r.feedback_residual == null ? "  —  " : r.feedback_residual.toFixed(2).padStart(5, " ");
      const fk = (r.feedback_kind ?? "—").padEnd(22, " ");
      env.out(`${ts}  ${r.effectiveness_band.padEnd(8, " ")}  ${label}  ${residual}  ${fk}`);
    }
    return 0;
  }
  renderSummary(env, rows);
  renderPolicySnapshot(env, policy);
  return 0;
};

if (import.meta.main) {
  void runRenderingAudit(process.argv.slice(2)).then((c) => process.exit(c));
}
