// ReleaseManifestV1: content-addressed distribution manifest and trust helpers.
import { createHash, sign as cryptoSign, verify as cryptoVerify, type KeyLike } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, posix, relative, sep } from "node:path";

export const RELEASE_MANIFEST_V1_SCHEMA = "acc2.release_manifest.v1" as const;
export const RELEASE_SIGNATURE_V1_SCHEMA = "acc2.release_signature.v1" as const;
export const RELEASE_MANIFEST_DIGEST_ALGORITHM = "sha256-canonical-json-v1" as const;
export const RELEASE_SIGNATURE_ALGORITHM = "ed25519" as const;

export type ReleaseSourceTypeV1 = "git" | "ipfs-cid" | "manual" | "future-pubsub";

export type ReleaseManifestSourceV1 = {
  source_type: ReleaseSourceTypeV1;
  ref: string;
  created_at: string;
  commit?: string;
  builder?: string;
  repository?: string;
  notes?: string;
};

export type ReleaseManifestMigrationV1 = {
  version: string;
  filename?: string;
  sha256?: string;
  required?: boolean;
};

export type ReleaseManifestCanonicalDbV1 = {
  path: string;
  cid: string;
  sha256: string;
};

export type ReleaseManifestV1 = {
  schema_version: typeof RELEASE_MANIFEST_V1_SCHEMA;
  release_version: string;
  min_acc_version: string;
  content_addressing: {
    manifest_digest: typeof RELEASE_MANIFEST_DIGEST_ALGORITHM;
    file_hash: "sha256";
    cid: "ipfs-cid";
  };
  files: Record<string, string>;
  canonical_db: ReleaseManifestCanonicalDbV1;
  migrations: ReleaseManifestMigrationV1[];
  source: ReleaseManifestSourceV1;
};

export type ReleaseManifestSignatureV1 = {
  schema_version: typeof RELEASE_SIGNATURE_V1_SCHEMA;
  algorithm: typeof RELEASE_SIGNATURE_ALGORITHM;
  manifest_sha256: string;
  public_key: string;
  signature_base64: string;
};

export type ReleaseManifestVerification = {
  ok: boolean;
  manifest_sha256: string;
  errors: string[];
};

export type BuildReleaseManifestV1Input = {
  releaseVersion: string;
  minAccVersion: string;
  files: Record<string, string>;
  canonicalDbCid: string;
  canonicalDbPath?: string;
  migrations?: ReleaseManifestMigrationV1[];
  source: ReleaseManifestSourceV1;
};

const SHA256_HEX = /^[a-f0-9]{64}$/;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const sortForCanonicalJson = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sortForCanonicalJson);
  if (!isPlainObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const child = value[key];
    if (child !== undefined) out[key] = sortForCanonicalJson(child);
  }
  return out;
};

export const canonicalReleaseManifestJson = (manifest: ReleaseManifestV1): string =>
  JSON.stringify(sortForCanonicalJson(manifest));

export const sha256Bytes = (bytes: Buffer | Uint8Array | string): string =>
  createHash("sha256").update(bytes).digest("hex");

export const sha256File = (path: string): string => sha256Bytes(readFileSync(path));

export const releaseManifestSha256 = (manifest: ReleaseManifestV1): string =>
  sha256Bytes(canonicalReleaseManifestJson(manifest));

const normalizeManifestPath = (path: string): string => {
  const slashPath = path.split(sep).join("/");
  const normalized = slashPath.startsWith("./") ? slashPath.slice(2) : slashPath;
  if (!normalized || normalized.startsWith("/") || normalized.split("/").includes("..")) {
    throw new Error("release manifest paths must be relative bundle paths: " + path);
  }
  return posix.normalize(normalized);
};

const walkFiles = (root: string): string[] => {
  const out: string[] = [];
  const visit = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const stat = statSync(path);
      if (stat.isDirectory()) visit(path);
      else if (stat.isFile()) out.push(path);
    }
  };
  visit(root);
  return out;
};

export const buildFileSha256Map = (bundleRoot: string, includePaths?: string[]): Record<string, string> => {
  const absoluteFiles = includePaths?.map((p) => join(bundleRoot, normalizeManifestPath(p))) ?? walkFiles(bundleRoot);
  const entries = absoluteFiles.map((absolutePath) => {
    const rel = normalizeManifestPath(relative(bundleRoot, absolutePath));
    return [rel, sha256File(absolutePath)] as const;
  });
  return Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b)));
};

export const buildReleaseManifestV1 = (input: BuildReleaseManifestV1Input): ReleaseManifestV1 => {
  const canonicalDbPath = normalizeManifestPath(input.canonicalDbPath ?? "canonical.db");
  const canonicalDbSha256 = input.files[canonicalDbPath];
  if (!canonicalDbSha256) throw new Error("canonical db path missing from file map: " + canonicalDbPath);
  const manifest: ReleaseManifestV1 = {
    schema_version: RELEASE_MANIFEST_V1_SCHEMA,
    release_version: input.releaseVersion,
    min_acc_version: input.minAccVersion,
    content_addressing: {
      manifest_digest: RELEASE_MANIFEST_DIGEST_ALGORITHM,
      file_hash: "sha256",
      cid: "ipfs-cid",
    },
    files: Object.fromEntries(Object.entries(input.files).map(([k, v]) => [normalizeManifestPath(k), v]).sort(([a], [b]) => a.localeCompare(b))),
    canonical_db: {
      path: canonicalDbPath,
      cid: input.canonicalDbCid,
      sha256: canonicalDbSha256,
    },
    migrations: [...(input.migrations ?? [])].sort((a, b) => a.version.localeCompare(b.version)),
    source: input.source,
  };
  const validation = validateReleaseManifestV1(manifest);
  if (!validation.ok) throw new Error("invalid ReleaseManifestV1: " + validation.errors.join("; "));
  return manifest;
};

export const validateReleaseManifestV1 = (manifest: unknown): ReleaseManifestVerification => {
  const errors: string[] = [];
  const m = manifest as Partial<ReleaseManifestV1>;
  if (!isPlainObject(manifest)) errors.push("manifest must be an object");
  if (m.schema_version !== RELEASE_MANIFEST_V1_SCHEMA) errors.push("schema_version must be acc2.release_manifest.v1");
  if (!m.release_version) errors.push("release_version is required");
  if (!m.min_acc_version) errors.push("min_acc_version is required");
  if (m.content_addressing?.manifest_digest !== RELEASE_MANIFEST_DIGEST_ALGORITHM) errors.push("content_addressing.manifest_digest must be sha256-canonical-json-v1");
  if (m.content_addressing?.file_hash !== "sha256") errors.push("content_addressing.file_hash must be sha256");
  if (m.content_addressing?.cid !== "ipfs-cid") errors.push("content_addressing.cid must be ipfs-cid");
  if (!isPlainObject(m.files) || Object.keys(m.files).length === 0) errors.push("files sha256 map is required");
  for (const [path, hash] of Object.entries(m.files ?? {})) {
    try { normalizeManifestPath(path); } catch (err) { errors.push((err as Error).message); }
    if (typeof hash !== "string" || !SHA256_HEX.test(hash)) errors.push("files." + path + " must be a sha256 hex digest");
  }
  if (!m.canonical_db?.path) errors.push("canonical_db.path is required");
  if (!m.canonical_db?.cid) errors.push("canonical_db.cid is required");
  if (!m.canonical_db?.sha256 || !SHA256_HEX.test(m.canonical_db.sha256)) errors.push("canonical_db.sha256 must be a sha256 hex digest");
  if (m.canonical_db?.path && m.files?.[m.canonical_db.path] && m.files[m.canonical_db.path] !== m.canonical_db.sha256) {
    errors.push("canonical_db.sha256 must match files[canonical_db.path]");
  }
  if (!Array.isArray(m.migrations)) errors.push("migrations must be an array");
  for (const migration of m.migrations ?? []) {
    if (!migration.version) errors.push("migrations[].version is required");
    if (migration.sha256 && !SHA256_HEX.test(migration.sha256)) errors.push("migration " + migration.version + " sha256 must be a sha256 hex digest");
  }
  if (!m.source?.source_type) errors.push("source.source_type is required");
  if (!m.source?.ref) errors.push("source.ref is required");
  if (!m.source?.created_at) errors.push("source.created_at is required");
  return { ok: errors.length === 0, manifest_sha256: errors.length === 0 ? releaseManifestSha256(m as ReleaseManifestV1) : "", errors };
};

export const signReleaseManifestV1 = (manifest: ReleaseManifestV1, privateKey: KeyLike): ReleaseManifestSignatureV1 => {
  const canonical = canonicalReleaseManifestJson(manifest);
  return {
    schema_version: RELEASE_SIGNATURE_V1_SCHEMA,
    algorithm: RELEASE_SIGNATURE_ALGORITHM,
    manifest_sha256: sha256Bytes(canonical),
    public_key: "",
    signature_base64: cryptoSign(null, Buffer.from(canonical), privateKey).toString("base64"),
  };
};

export const verifyDetachedReleaseManifestSignatureV1 = (
  manifest: ReleaseManifestV1,
  signature: ReleaseManifestSignatureV1,
  publicKeyOverride?: KeyLike,
): ReleaseManifestVerification => {
  const errors = validateReleaseManifestV1(manifest).errors;
  const canonical = canonicalReleaseManifestJson(manifest);
  const manifestSha256 = sha256Bytes(canonical);
  if (signature.schema_version !== RELEASE_SIGNATURE_V1_SCHEMA) errors.push("signature schema_version must be acc2.release_signature.v1");
  if (signature.algorithm !== RELEASE_SIGNATURE_ALGORITHM) errors.push("signature algorithm must be ed25519");
  if (signature.manifest_sha256 !== manifestSha256) errors.push("signature manifest_sha256 does not match manifest");
  const publicKey = publicKeyOverride ?? signature.public_key;
  if (!publicKey) errors.push("signature public_key is required when no override is provided");
  try {
    const ok = cryptoVerify(null, Buffer.from(canonical), publicKey, Buffer.from(signature.signature_base64, "base64"));
    if (!ok) errors.push("signature verification failed");
  } catch (err) {
    errors.push("signature verification failed: " + (err as Error).message);
  }
  return { ok: errors.length === 0, manifest_sha256: manifestSha256, errors };
};
