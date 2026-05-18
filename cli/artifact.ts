// `acc artifact provenance <artifact_id>` — graph-walk a code_artifact
// supersedes chain and render the result as a tree.
//
// Contract C5 (HJJS1665H961B2SRYHC5J85D14, directive
// QHTRBV6PFX2JVBMHDNDA4B03GC, 2026-05-18). Surfaces the same chain that
// the substrate maintains via the `supersedes` / `superseded_by` columns
// on code_artifact, including lost_version_count annotations on
// backfill placeholders.
//
// Surface:
//   acc artifact provenance <id>            pretty tree (ANSI badges)
//   acc artifact provenance <id> --json     structured JSON
//
// Prefix resolution: artifact_id may be passed as a prefix as short as 6
// chars. Ambiguous prefix → list candidates + exit 1. Missing → exit 1.

import type { Database } from "bun:sqlite";
import { openDb } from "../substrate/db";
import { resolveDbPath } from "../runtime/state_paths";
import {
  getProvenanceChain,
  type ProvenanceChain,
  type ProvenanceNode,
} from "../runtime/artifact_provenance";

type ArtifactEnv = {
  out: (s: string) => void;
  err: (s: string) => void;
  stateDbPath?: string;
  openSubstrate?: (path?: string) => Database;
  color?: boolean;
};

const defaultEnv = (): ArtifactEnv => ({
  out: (s) => console.log(s),
  err: (s) => console.error(s),
  color: !!process.stdout.isTTY,
});

const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
};

const shortId = (id: string | null | undefined, n = 10): string =>
  id ? (id.length > n ? id.slice(0, n) + "…" : id) : "-";

export class AmbiguousArtifactPrefixError extends Error {
  readonly candidates: string[];
  constructor(prefix: string, candidates: string[]) {
    super(`acc artifact: ambiguous artifact prefix '${prefix}' matches ${candidates.length} artifacts`);
    this.name = "AmbiguousArtifactPrefixError";
    this.candidates = candidates;
  }
}

export class ArtifactNotFoundError extends Error {
  constructor(public readonly prefix: string) {
    super(`acc artifact: no artifact found matching '${prefix}'`);
    this.name = "ArtifactNotFoundError";
  }
}

/** Resolve an artifact prefix (>= 6 chars, or full id) to one canonical
 *  artifact_id. Mirrors resolveDirectivePrefix from dispatch_inspect. */
export const resolveArtifactPrefix = (db: Database, prefix: string): string => {
  if (!prefix) throw new ArtifactNotFoundError(prefix);
  const exact = db.query("SELECT id FROM code_artifact WHERE id = ? LIMIT 1").get(prefix) as { id: string } | null;
  if (exact) return exact.id;
  if (prefix.length < 6) throw new ArtifactNotFoundError(prefix);
  const rows = db
    .query("SELECT id FROM code_artifact WHERE id LIKE ? ORDER BY id LIMIT 10")
    .all(`${prefix}%`) as Array<{ id: string }>;
  if (rows.length === 0) throw new ArtifactNotFoundError(prefix);
  if (rows.length > 1) throw new AmbiguousArtifactPrefixError(prefix, rows.map((r) => r.id));
  return rows[0]!.id;
};

const renderNodeLine = (
  n: ProvenanceNode,
  indent: number,
  marker: string,
  color: boolean,
): string => {
  const pad = "  " + "  ".repeat(indent);
  const idShort = shortId(n.artifact_id, 12);
  const name = n.name ?? "(unnamed)";
  const trashed = n.lost_version_count > 0 ? " [TRASHED]" : "";
  const drive = n.target_resources?.find((u) => u.startsWith("drive:"));
  const driveDocId = drive ? drive.replace(/^drive:\/\/document\//, "") : null;
  const driveTag = driveDocId ? ` drive=${shortId(driveDocId, 14)}` : "";
  const headBadge = marker === "*" ? (color ? `${ANSI.bold}${ANSI.cyan}* HEAD${ANSI.reset}` : "* HEAD") : "  ";
  const trashedColored = trashed && color ? `${ANSI.red}${trashed}${ANSI.reset}` : trashed;
  return `${pad}${headBadge} ${idShort} ${name} kind=${n.kind}${driveTag}${trashedColored}`;
};

const renderPretty = (
  chain: ProvenanceChain,
  out: (s: string) => void,
  color: boolean,
): void => {
  const bold = (s: string) => (color ? `${ANSI.bold}${s}${ANSI.reset}` : s);
  const dim = (s: string) => (color ? `${ANSI.dim}${s}${ANSI.reset}` : s);

  out(bold(`acc artifact provenance — supersedes chain`));
  out(`head_artifact_id   : ${chain.head.artifact_id}`);
  out(`head_name          : ${chain.head.name ?? "(unnamed)"}`);
  out(`head_kind          : ${chain.head.kind}`);
  out(`ancestors          : ${chain.ancestors.length}`);
  out(`descendants        : ${chain.descendants.length}`);
  out(`lost_version_count : ${chain.lost_version_count}`);
  out("");
  out(bold(`chain (oldest → newest):`));
  // Render ancestors (already oldest → most-recent), then head, then descendants.
  let depthIdx = 0;
  for (const a of chain.ancestors) {
    out(renderNodeLine(a, depthIdx, " ", color));
    depthIdx++;
  }
  out(renderNodeLine(chain.head, depthIdx, "*", color));
  depthIdx++;
  for (const d of chain.descendants) {
    out(renderNodeLine(d, depthIdx, " ", color));
    depthIdx++;
  }
  if (chain.lost_version_count > 0) {
    out("");
    out(dim(`(${chain.lost_version_count} lost version${chain.lost_version_count === 1 ? "" : "s"} in chain — external resource trashed before substrate recorded supersede)`));
  }
};

const usage = (): string => [
  "acc artifact — inspect a code_artifact's provenance / supersedes chain",
  "",
  "Usage:",
  "  acc artifact provenance <artifact_id_or_prefix> [--json] [--no-color]",
  "",
  "Walks the artifact's supersedes (ancestors) and superseded_by",
  "(descendants) chain and renders the full lineage. Designed for the",
  "C5 published_drive_doc surface: every Drive doc admission records",
  "the prior version's supersede pointer non-destructively (the prior",
  "external doc is NOT trashed — trashing is an explicit owner action).",
  "",
  "Prefix resolution: accepts the full 26-char artifact_id or any prefix",
  ">= 6 chars. Ambiguous prefixes are rejected with the candidate list.",
].join("\n");

export const runArtifact = async (
  argv: string[],
  envOverride?: Partial<ArtifactEnv>,
): Promise<number> => {
  const env: ArtifactEnv = { ...defaultEnv(), ...(envOverride ?? {}) };
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h" || argv[0] === "help") {
    env.out(usage());
    return argv.length === 0 ? 1 : 0;
  }
  const sub = argv[0];
  if (sub !== "provenance") {
    env.err(`acc artifact: unknown subcommand '${sub}'. expected: provenance`);
    env.out(usage());
    return 1;
  }
  const rest = argv.slice(1);
  const wantJson = rest.includes("--json");
  const noColor = rest.includes("--no-color");
  const positional = rest.filter((a) => !a.startsWith("--"));
  const artifactArg = positional[0];
  if (!artifactArg) {
    env.err("acc artifact provenance: missing <artifact_id_or_prefix>");
    env.out(usage());
    return 1;
  }

  const path = env.stateDbPath ?? resolveDbPath();
  let db: Database;
  try {
    db = (env.openSubstrate ?? ((p?: string) => openDb(p ?? resolveDbPath())))(path);
  } catch (err) {
    env.err(`acc artifact: failed to open substrate: ${(err as Error).message}`);
    return 1;
  }

  let resolvedId: string;
  try {
    resolvedId = resolveArtifactPrefix(db, artifactArg);
  } catch (err) {
    if (err instanceof AmbiguousArtifactPrefixError) {
      env.err(`acc artifact: prefix '${artifactArg}' is ambiguous (${err.candidates.length} matches):`);
      for (const c of err.candidates) env.err(`  ${c}`);
      return 1;
    }
    if (err instanceof ArtifactNotFoundError) {
      env.err(`acc artifact: artifact not found for '${artifactArg}'`);
      return 1;
    }
    env.err(`acc artifact: ${(err as Error).message}`);
    return 1;
  }

  const chain = getProvenanceChain(db, resolvedId);
  if (!chain) {
    env.err(`acc artifact: artifact row gone after resolve: ${resolvedId}`);
    return 1;
  }
  if (wantJson) {
    env.out(JSON.stringify(chain, null, 2));
  } else {
    const color = env.color !== false && !noColor;
    renderPretty(chain, env.out, color);
  }
  return 0;
};

if (import.meta.main) {
  void runArtifact(process.argv.slice(2)).then((code) => process.exit(code));
}
