// `acc admin pin-release <bundle-path> --version <version> --yes` — pin a release bundle to IPFS via Pinata.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import type { Database } from "bun:sqlite";
import { openDb } from "../substrate/db";
import { emitEvent } from "../runtime/events";
import type { JsonValue } from "../substrate/types";
import { createPinataClient, pinataConfigFromEnv, type PinataClient } from "../runtime/pinata_client";
import { resolveDbPath } from "../runtime/state_paths";

export type PinReleaseEnv = {
  out: (line: string) => void;
  err: (line: string) => void;
  yes: boolean;
  openSubstrate?: (path?: string) => Database;
  stateDbPath?: string;
  pinataClient?: PinataClient;
  nowIso?: () => string;
};

const HELP = `acc admin pin-release — pin a release bundle to IPFS via Pinata

usage: acc admin pin-release <bundle-path> --version <version> --yes [--channel stable] [--manifest manifest.json] [--name NAME]

Requires PINATA_JWT. Optional: PINATA_GATEWAY, PINATA_API_BASE, ACC2_PINATA_TIMEOUT_MS.
Pins only the release bundle and release metadata; no pubsub behavior is implemented.`;

const flagValue = (argv: string[], name: string): string | undefined => {
  const i = argv.indexOf(name);
  if (i < 0 || i + 1 >= argv.length) return undefined;
  const v = argv[i + 1]!;
  return v.startsWith("--") ? undefined : v;
};

const hasFlag = (argv: string[], name: string): boolean => argv.includes(name);

const sha256 = (data: Uint8Array | string): string => createHash("sha256").update(data).digest("hex");

const fileDigest = (path: string): string => sha256(readFileSync(path));

const walkFiles = (root: string): string[] => {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.isFile()) out.push(abs);
    }
  };
  walk(root);
  return out;
};

const bundleHash = (path: string): { kind: "file" | "directory"; sha256: string; files?: Array<{ path: string; sha256: string }> } => {
  const st = statSync(path);
  if (st.isFile()) return { kind: "file", sha256: fileDigest(path) };
  if (!st.isDirectory()) throw new Error("bundle_path_not_file_or_directory");
  const files = walkFiles(path).map((abs) => ({ path: relative(path, abs).replaceAll("\\", "/"), sha256: fileDigest(abs) }));
  if (files.length === 0) throw new Error("bundle_directory_empty");
  return { kind: "directory", sha256: sha256(JSON.stringify(files)), files };
};

const parseManifest = (path: string | undefined): { path?: string; sha256?: string; body?: unknown } => {
  if (!path) return {};
  const body = readFileSync(path, "utf8");
  return { path: resolve(path), sha256: sha256(body), body: JSON.parse(body) };
};

export const runPinReleaseCmd = async (argv: string[], env: PinReleaseEnv): Promise<number> => {
  if (argv.includes("--help") || argv.includes("-h")) {
    env.out(HELP);
    return 0;
  }
  const bundlePath = argv[0];
  if (!bundlePath || bundlePath.startsWith("--")) {
    env.err("acc admin pin-release: missing <bundle-path>");
    env.err("usage: acc admin pin-release <bundle-path> --version <version> --yes");
    return 1;
  }
  if (!env.yes && !hasFlag(argv, "--yes") && !hasFlag(argv, "-y")) {
    env.err("acc admin pin-release: missing --yes (external Pinata/IPFS publish approval gate)");
    return 1;
  }
  const version = flagValue(argv, "--version");
  if (!version) {
    env.err("acc admin pin-release: missing --version <version>");
    return 1;
  }
  const absBundle = resolve(bundlePath);
  if (!existsSync(absBundle)) {
    env.err(`acc admin pin-release: bundle path not found: ${absBundle}`);
    return 1;
  }

  let digest: ReturnType<typeof bundleHash>;
  let manifest: ReturnType<typeof parseManifest>;
  try {
    digest = bundleHash(absBundle);
    manifest = parseManifest(flagValue(argv, "--manifest"));
  } catch (err) {
    env.err(`acc admin pin-release: failed to inspect inputs: ${(err as Error).message}`);
    return 1;
  }

  const channel = flagValue(argv, "--channel") ?? "stable";
  const releaseName = flagValue(argv, "--name") ?? `acc2-${version}-${basename(absBundle)}`;
  const client = env.pinataClient ?? createPinataClient(pinataConfigFromEnv());
  const keyvalues = { acc2_release: "true", version, channel };

  const pinned = await client.pinFile(absBundle, { name: releaseName, keyvalues });
  if (!pinned.ok) {
    env.err(`acc admin pin-release: Pinata bundle pin failed: ${pinned.error}`);
    return 1;
  }

  const pinnedAt = env.nowIso?.() ?? new Date().toISOString();
  const metadata = {
    mode: "release_pin",
    release_version: version,
    channel,
    bundle_name: releaseName,
    bundle_path: absBundle,
    bundle_kind: digest.kind,
    bundle_sha256: digest.sha256,
    bundle_files: digest.files ?? [],
    bundle_cid: pinned.cid,
    bundle_bytes: pinned.bytes,
    manifest,
    pinned_at: pinnedAt,
    provider: "pinata",
    pubsub: { implemented: false },
  };

  const metaPinned = await client.pinJson(metadata, {
    name: `${releaseName}-metadata`,
    keyvalues: { ...keyvalues, bundle_cid: pinned.cid },
  });
  if (!metaPinned.ok) {
    env.err(`acc admin pin-release: Pinata metadata pin failed after bundle pin: ${metaPinned.error}`);
    return 1;
  }

  try {
    const db = (env.openSubstrate ?? openDb)(env.stateDbPath ?? resolveDbPath());
    emitEvent(db, {
      kind: "state_exported",
      substrate_origin: "claude_inline",
      payload: { ...metadata, metadata_cid: metaPinned.cid } as unknown as JsonValue,
    });
  } catch (err) {
    env.err(`acc admin pin-release: pinned but failed to record release metadata: ${(err as Error).message}`);
    return 1;
  }

  env.out(`pin-release complete: ${pinned.cid}`);
  env.out(`  metadata cid: ${metaPinned.cid}`);
  env.out(`  sha256:       ${digest.sha256}`);
  return 0;
};
