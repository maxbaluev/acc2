// acc trust — operator growth/autonomy surface. Reads the ledger
// directly: autonomy_score, recipe activity, knowledge movement,
// artifact promotions, closure residuals, amendment outcomes.
import type { Database } from "bun:sqlite";
import { openDb } from "../substrate/db";
import { resolveDbPath } from "../runtime/state_paths";

const HELP = `acc trust — growth/autonomy snapshot.

  acc trust          Operator-readable report.
  acc trust --json   Same metrics as one JSON object.
  acc trust --help   This help.
`;

export type TrustMetrics = {
  autonomy_score: number;
  recipes_extracted: number;
  recipes_replayed_success: number;
  recipes_replayed_aborted: number;
  knowledge_promoted_7d: number;
  knowledge_demoted_7d: number;
  artifacts_promoted_recent: Array<{ artifact_id: string; ts: string; summary: string }>;
  closure_residual_7d: { avg: number; min: number; max: number; count: number };
  amendments_7d: { applied: number; failed: number; refused: number };
  recommendation: string;
};

const num = (v: unknown): number => { const n = typeof v === "number" ? v : Number(v ?? 0); return Number.isFinite(n) ? n : 0; };
const parsePayload = (s: unknown): Record<string, unknown> => {
  try { return JSON.parse(String(s ?? "{}")) as Record<string, unknown>; } catch { return {}; }
};
const countKind = (db: Database, kind: string, weekly = false): number => {
  const w = weekly ? "AND JULIANDAY('now') - JULIANDAY(ts) < 7" : "";
  return num((db.query(`SELECT COUNT(*) AS c FROM events WHERE kind = ? ${w}`).get(kind) as { c: number })?.c);
};

const recipeSuccess = (db: Database): number => {
  const committed = db.query(
    `SELECT COUNT(*) AS c FROM events
      WHERE kind = 'task_committed'
        AND (json_extract(payload,'$.recipe_replayed') = 1
          OR json_extract(payload,'$.recipe_replayed') = 'true')`,
  ).get() as { c: number };
  return num(committed?.c);
};

export const gatherTrustMetrics = (db: Database): TrustMetrics => {
  const profile = db.query(`SELECT payload FROM events WHERE kind='owner_profile_recorded' ORDER BY ts DESC, rowid DESC LIMIT 1`).get() as { payload: string } | null;
  const autonomy_score = profile ? num(parsePayload(profile.payload).autonomy_score) : 0;
  const artifactRows = db.query(`SELECT ts, payload FROM events WHERE kind='code_artifact_promoted' ORDER BY ts DESC, rowid DESC LIMIT 5`).all() as Array<{ ts: string; payload: string }>;
  const artifacts_promoted_recent = artifactRows.map((r) => {
    const p = parsePayload(r.payload);
    return { artifact_id: String(p.artifact_id ?? p.id ?? "?"), ts: r.ts, summary: String(p.summary ?? p.intent ?? "") };
  });
  const cw = db.query(
    `SELECT AVG(CAST(json_extract(payload,'$.closure_residual') AS REAL)) AS a,
            MIN(CAST(json_extract(payload,'$.closure_residual') AS REAL)) AS mn,
            MAX(CAST(json_extract(payload,'$.closure_residual') AS REAL)) AS mx,
            COUNT(*) AS c FROM events
      WHERE kind='task_closure_audited' AND JULIANDAY('now') - JULIANDAY(ts) < 7
        AND json_extract(payload,'$.closure_residual') IS NOT NULL`,
  ).get() as { a: number | null; mn: number | null; mx: number | null; c: number };
  const closure_residual_7d = { avg: num(cw?.a), min: num(cw?.mn), max: num(cw?.mx), count: num(cw?.c) };
  const amRows = db.query(
    `SELECT json_extract(payload,'$.status') AS status, COUNT(*) AS c FROM events
      WHERE kind='contract_amendment_applied' AND JULIANDAY('now') - JULIANDAY(ts) < 7 GROUP BY status`,
  ).all() as Array<{ status: string | null; c: number }>;
  const amendments_7d = { applied: 0, failed: 0, refused: 0 };
  for (const r of amRows) {
    if (r.status === "applied") amendments_7d.applied += num(r.c);
    else if (r.status === "failed") amendments_7d.failed += num(r.c);
    else if (r.status === "refused") amendments_7d.refused += num(r.c);
  }
  const base = {
    autonomy_score,
    recipes_extracted: countKind(db, "recipe_extracted"),
    recipes_replayed_success: recipeSuccess(db),
    recipes_replayed_aborted: countKind(db, "recipe_replay_aborted"),
    knowledge_promoted_7d: countKind(db, "knowledge_promoted", true),
    knowledge_demoted_7d: countKind(db, "knowledge_demoted", true),
    artifacts_promoted_recent, closure_residual_7d, amendments_7d,
  };
  const healthy = base.autonomy_score > 0.6 && base.closure_residual_7d.avg < 0.2 && base.amendments_7d.applied > base.amendments_7d.failed;
  const recommendation = healthy
    ? "trust looks healthy; consider raising father --max-cycles"
    : "trust mixed; review dispatcher_violation + irreversible_effect_recorded before extending autonomy";
  return { ...base, recommendation };
};

const renderText = (m: TrustMetrics): string => {
  const artifactLines = m.artifacts_promoted_recent.length === 0
    ? ["  (none)"]
    : m.artifacts_promoted_recent.map((a) => {
        const sum = a.summary.length > 60 ? a.summary.slice(0, 60) + "..." : a.summary;
        return `  ${a.ts.slice(0, 19)}  ${a.artifact_id.slice(0, 24).padEnd(24)}  ${sum}`;
      });
  return [
    `autonomy_score: ${m.autonomy_score.toFixed(2)}`,
    "",
    "recipes:",
    `  extracted:        ${m.recipes_extracted}`,
    `  replayed_success: ${m.recipes_replayed_success}`,
    `  replayed_aborted: ${m.recipes_replayed_aborted}`,
    "",
    "learning (last 7d):",
    `  I promoted ${m.knowledge_promoted_7d} knowledge entries from recent outcomes.`,
    `  I demoted ${m.knowledge_demoted_7d} entries when evidence disagreed.`,
    "  If this sounds wrong, say what to correct; the correction becomes owner_insight_candidate evidence.",
    "",
    "recent artifact promotions:",
    ...artifactLines,
    "",
    "closure_residual (last 7d):",
    `  avg: ${m.closure_residual_7d.avg.toFixed(3)}  min: ${m.closure_residual_7d.min.toFixed(3)}  max: ${m.closure_residual_7d.max.toFixed(3)}  n=${m.closure_residual_7d.count}`,
    "",
    "amendments (last 7d):",
    `  applied: ${m.amendments_7d.applied}  failed: ${m.amendments_7d.failed}  refused: ${m.amendments_7d.refused}`,
    "",
    `recommendation: ${m.recommendation}`,
    "",
  ].join("\n");
};

export const runTrust = async (argv: string[]): Promise<number> => {
  if (argv.includes("--help") || argv.includes("-h")) { process.stdout.write(HELP); return 0; }
  const db = openDb(resolveDbPath());
  const metrics = gatherTrustMetrics(db);
  process.stdout.write(argv.includes("--json") ? JSON.stringify(metrics) + "\n" : renderText(metrics));
  return 0;
};
