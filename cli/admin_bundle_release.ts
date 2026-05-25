// `acc admin bundle-release <bundle-dir> --version <version> --yes` — build a release bundle.
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { Database } from "bun:sqlite";
import { openDb } from "../substrate/db";
import { emitEvent } from "../runtime/events";
import { runExportCanonical } from "./admin_export_canonical";
import {
  buildFileSha256Map,
  buildReleaseManifestV1,
  canonicalReleaseManifestJson,
  releaseManifestSha256,
  validateReleaseManifestV1,
  type ReleaseManifestMigrationV1,
  type ReleaseSourceTypeV1,
} from "./release_manifest";

export type BundleReleaseResult = {
  ok: boolean;
  bundleDir: string;
  canonicalDbPath: string;
  manifestPath: string;
  manifestSha256: string;
  canonicalDbSha256: string;
  errors: string[];
};

export type BundleReleaseOptions = {
  bundleDir: string;
  releaseVersion: string;
  minAccVersion: string;
  sourceDb?: Database;
  sourceDbPath?: string;
  canonicalDbCid?: string;
  force?: boolean;
  migrations?: ReleaseManifestMigrationV1[];
  sourceType?: ReleaseSourceTypeV1;
  sourceRef?: string;
  nowIso?: () => string;
};

export type BundleReleaseEnv = {
  out: (line: string) => void;
  err: (line: string) => void;
  openSubstrate?: () => Database;
  sourceDbPath?: string;
  yes?: boolean;
  nowIso?: () => string;
};

const HELP = `acc admin bundle-release — build a portable release bundle

usage: acc admin bundle-release <bundle-dir> --version <version> --yes [--force] [--min-acc-version VERSION] [--canonical-db-cid CID]

  Creates/overwrites <bundle-dir>, writes canonical.db, computes bundle file
  sha256s, writes manifest.json, and records release-bundle metadata in the
  event ledger. Pinning remains a separate 'acc admin pin-release' step.
`;

const flagValue = (argv: string[], name: string): string | undefined => {
  const i = argv.indexOf(name);
  if (i < 0 || i + 1 >= argv.length) return undefined;
  const value = argv[i + 1]!;
  return value.startsWith("--") ? undefined : value;
};

const hasFlag = (argv: string[], name: string): boolean => argv.includes(name);

export const runBundleRelease = async (opts: BundleReleaseOptions): Promise<BundleReleaseResult> => {
  const bundleDir = resolve(opts.bundleDir);
  const canonicalDbPath = join(bundleDir, "canonical.db");
  const manifestPath = join(bundleDir, "manifest.json");
  const errors: string[] = [];

  if (existsSync(bundleDir)) {
    if (!opts.force) {
      return { ok: false, bundleDir, canonicalDbPath, manifestPath, manifestSha256: "", canonicalDbSha256: "", errors: ["bundle_dir_exists"] };
    }
    rmSync(bundleDir, { recursive: true, force: true });
  }
  mkdirSync(bundleDir, { recursive: true });

  const sourceDb = opts.sourceDb ?? openDb(opts.sourceDbPath ?? "");
  const exported = await runExportCanonical({ outputPath: canonicalDbPath, sourceDb, sourceDbPath: opts.sourceDbPath });
  if (!exported.ok) {
    return { ok: false, bundleDir, canonicalDbPath, manifestPath, manifestSha256: "", canonicalDbSha256: "", errors: exported.errors };
  }

  const files = buildFileSha256Map(bundleDir, ["canonical.db"]);
  const manifest = buildReleaseManifestV1({
    releaseVersion: opts.releaseVersion,
    minAccVersion: opts.minAccVersion,
    files,
    canonicalDbCid: opts.canonicalDbCid ?? "pending-ipfs-cid",
    canonicalDbPath: "canonical.db",
    migrations: opts.migrations ?? [],
    source: {
      source_type: opts.sourceType ?? "manual",
      ref: opts.sourceRef ?? opts.releaseVersion,
      created_at: (opts.nowIso ?? (() => new Date().toISOString()))(),
    },
  });
  const validation = validateReleaseManifestV1(manifest);
  if (!validation.ok) errors.push(...validation.errors);
  if (errors.length > 0) {
    return { ok: false, bundleDir, canonicalDbPath, manifestPath, manifestSha256: "", canonicalDbSha256: exported.sha256, errors };
  }
  writeFileSync(manifestPath, canonicalReleaseManifestJson(manifest) + "\n");
  const manifestSha256 = releaseManifestSha256(manifest);

  emitEvent(sourceDb, {
    kind: "state_exported",
    substrate_origin: "owner",
    payload: {
      mode: "release_bundle",
      bundle_dir: bundleDir,
      release_version: opts.releaseVersion,
      min_acc_version: opts.minAccVersion,
      canonical_db_path: canonicalDbPath,
      canonical_db_sha256: exported.sha256,
      canonical_db_cid: manifest.canonical_db.cid,
      manifest_path: manifestPath,
      manifest_sha256: manifestSha256,
      files: manifest.files,
      p2p_ready: { release_source: manifest.source.source_type, pubsub_implemented: false },
    },
  });

  return { ok: true, bundleDir, canonicalDbPath, manifestPath, manifestSha256, canonicalDbSha256: exported.sha256, errors: [] };
};

export const runBundleReleaseCmd = async (argv: string[], env: BundleReleaseEnv): Promise<number> => {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    env.out(HELP);
    return argv.length === 0 ? 1 : 0;
  }
  const bundleDir = argv.find((arg) => !arg.startsWith("--"));
  if (!bundleDir) {
    env.err("acc admin bundle-release: missing <bundle-dir>");
    env.err("usage: acc admin bundle-release <bundle-dir> --version <version> --yes");
    return 1;
  }
  const yes = env.yes ?? (hasFlag(argv, "--yes") || hasFlag(argv, "-y"));
  if (!yes) {
    env.err("acc admin bundle-release: missing --yes (release bundle approval gate)");
    return 1;
  }
  const releaseVersion = flagValue(argv, "--version");
  if (!releaseVersion) {
    env.err("acc admin bundle-release: missing --version <version>");
    return 1;
  }
  const sourceDb = env.openSubstrate ? env.openSubstrate() : openDb(env.sourceDbPath ?? "");
  const result = await runBundleRelease({
    bundleDir,
    releaseVersion,
    minAccVersion: flagValue(argv, "--min-acc-version") ?? "0.0.0",
    canonicalDbCid: flagValue(argv, "--canonical-db-cid"),
    force: hasFlag(argv, "--force"),
    sourceDb,
    sourceDbPath: env.sourceDbPath,
    nowIso: env.nowIso,
  });
  if (!result.ok) {
    env.err(`acc admin bundle-release: failed: ${result.errors.join(", ")}`);
    return 1;
  }
  env.out(`acc admin bundle-release: wrote ${result.bundleDir}`);
  env.out(`  canonical.db sha256: ${result.canonicalDbSha256}`);
  env.out(`  manifest sha256:     ${result.manifestSha256}`);
  env.out(`  next: acc admin pin-release ${result.bundleDir} --version ${releaseVersion} --yes`);
  return 0;
};
