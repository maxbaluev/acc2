// `acc admin top-laws` — print the substrate's auto-compiled Top Laws.
//
// Brain dispatch 3NWCD7PW315W (CLAUDE.md auto-compiled piece, Phase I3,
// 2026-05-18): the legacy system/CLAUDE.md has 'Top Laws (auto-compiled
// from scored knowledge)' as a section header but acc2's contract
// hard-codes nothing. This CLI surfaces the live Top Laws list — the
// orchestrator can splice the output into CLAUDE.md at session start,
// OR query substrate.read{view_name:'top_laws_view'} via MCP at any
// point to refresh its understanding without restarting.
//
// Formats:
//   default → markdown (the splice-into-CLAUDE.md format)
//   --json  → structured rows
//   --raw   → one row per law, terse

import { openDb } from "../substrate/db";
import { topLaws, type TopLawRow } from "../substrate/views";
import { resolveDbPath } from "../runtime/state_paths";

export type AdminTopLawsEnv = {
  out: (line: string) => void;
  err: (line: string) => void;
  openSubstrate?: (path?: string) => ReturnType<typeof openDb>;
  stateDbPath?: string;
};

const defaultEnv: AdminTopLawsEnv = {
  out: (line) => process.stdout.write(line + "\n"),
  err: (line) => process.stderr.write(line + "\n"),
  openSubstrate: (path?: string) => openDb(path ?? resolveDbPath()),
};

const HELP = `acc admin top-laws — auto-compiled Top Laws from scored knowledge

usage: acc admin top-laws [--json | --raw] [--min-score N] [--limit N]

  Prints the substrate's highest-scoring promoted_knowledge rows ranked
  by Beta posterior. Default floor is score >= 0.75 (same bar as the
  legacy system/CLAUDE.md auto-compiled Top Laws section). Output is
  markdown by default — splice into CLAUDE.md or into a prompt.

  --json        structured JSON rows
  --raw         one row per line (rank | score | text)
  --min-score N lower or raise the floor (default 0.75)
  --limit N     max rows to print (default 25)
`;

const parseArgs = (argv: string[]): { format: "markdown" | "json" | "raw"; min_score?: number; limit?: number } => {
  let format: "markdown" | "json" | "raw" = "markdown";
  if (argv.includes("--json")) format = "json";
  if (argv.includes("--raw")) format = "raw";
  const minIdx = argv.indexOf("--min-score");
  const limitIdx = argv.indexOf("--limit");
  const min_score = minIdx >= 0 ? Number(argv[minIdx + 1]) : undefined;
  const limit = limitIdx >= 0 ? Number(argv[limitIdx + 1]) : undefined;
  return {
    format,
    min_score: Number.isFinite(min_score) ? min_score : undefined,
    limit: Number.isFinite(limit) ? limit : undefined,
  };
};

const renderMarkdown = (env: AdminTopLawsEnv, laws: TopLawRow[]): void => {
  if (laws.length === 0) {
    env.out("## Top Laws (auto-compiled from scored knowledge)");
    env.out("");
    env.out("_no promoted_knowledge rows above the score floor yet — run brain cycles + let the merger promote candidates_");
    return;
  }
  env.out("## Top Laws (auto-compiled from scored knowledge)");
  env.out("");
  env.out("These are the organism's highest-scored promoted knowledge entries. They govern all decisions:");
  env.out("");
  for (const law of laws) {
    const shortId = law.event_id.slice(0, 10);
    const conf = law.confidence != null ? ` conf=${law.confidence.toFixed(2)}` : "";
    env.out(`${law.law_rank}. **${shortId}** (score=${law.score.toFixed(2)}${conf}): ${law.text.replace(/\s+/g, " ").trim()}`);
  }
};

const renderRaw = (env: AdminTopLawsEnv, laws: TopLawRow[]): void => {
  if (laws.length === 0) {
    env.out("(no top laws yet)");
    return;
  }
  for (const law of laws) {
    env.out(`${String(law.law_rank).padStart(3, " ")}  ${law.score.toFixed(3)}  ${law.text.replace(/\s+/g, " ").slice(0, 120)}`);
  }
};

export const runTopLaws = async (argv: string[], envOverride?: Partial<AdminTopLawsEnv>): Promise<number> => {
  const env: AdminTopLawsEnv = { ...defaultEnv, ...envOverride };
  if (argv.includes("--help") || argv.includes("-h")) {
    env.out(HELP);
    return 0;
  }
  const { format, min_score, limit } = parseArgs(argv);
  const open = env.openSubstrate ?? defaultEnv.openSubstrate!;
  let db: ReturnType<typeof openDb>;
  try {
    db = open(env.stateDbPath);
  } catch (e) {
    env.err(`acc admin top-laws: cannot open substrate: ${(e as Error).message}`);
    return 1;
  }
  let laws: TopLawRow[];
  try {
    laws = topLaws(db, { min_score, limit });
  } catch (e) {
    env.err(`acc admin top-laws: query failed: ${(e as Error).message}`);
    return 1;
  }
  if (format === "json") {
    env.out(JSON.stringify(laws, null, 2));
    return 0;
  }
  if (format === "raw") {
    renderRaw(env, laws);
    return 0;
  }
  renderMarkdown(env, laws);
  return 0;
};

if (import.meta.main) {
  void runTopLaws(process.argv.slice(2)).then((c) => process.exit(c));
}
