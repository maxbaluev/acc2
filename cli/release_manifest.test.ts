import { afterEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildFileSha256Map,
  buildReleaseManifestV1,
  canonicalReleaseManifestJson,
  releaseManifestSha256,
  signReleaseManifestV1,
  validateReleaseManifestV1,
  verifyDetachedReleaseManifestSignatureV1,
} from "./release_manifest";

let tmpRoots: string[] = [];
afterEach(() => {
  for (const dir of tmpRoots) rmSync(dir, { recursive: true, force: true });
  tmpRoots = [];
});

const makeBundle = () => {
  const root = mkdtempSync(join(tmpdir(), "acc2-release-manifest-"));
  tmpRoots.push(root);
  writeFileSync(join(root, "canonical.db"), "portable wisdom db bytes");
  writeFileSync(join(root, "README.md"), "release notes");
  return root;
};

describe("ReleaseManifestV1", () => {
  test("builds a content-addressed manifest with canonical.db CID and sha256", () => {
    const root = makeBundle();
    const files = buildFileSha256Map(root);
    const manifest = buildReleaseManifestV1({
      releaseVersion: "2026.05.25.1",
      minAccVersion: "0.1.0",
      files,
      canonicalDbCid: "bafybeicanonicaldbcid",
      migrations: [{ version: "v001", filename: "v001_init.sql", sha256: files["README.md"] }],
      source: { source_type: "git", ref: "refs/tags/v2026.05.25.1", commit: "abc123", created_at: "2026-05-25T00:00:00.000Z" },
    });

    expect(manifest.schema_version).toBe("acc2.release_manifest.v1");
    expect(manifest.canonical_db.cid).toBe("bafybeicanonicaldbcid");
    expect(manifest.canonical_db.sha256).toBe(files["canonical.db"]);
    expect(manifest.files["README.md"]).toMatch(/^[a-f0-9]{64}$/);
    expect(validateReleaseManifestV1(manifest).ok).toBe(true);
  });

  test("canonical manifest JSON is stable regardless of object insertion order", () => {
    const root = makeBundle();
    const files = buildFileSha256Map(root);
    const a = buildReleaseManifestV1({
      releaseVersion: "1.0.0",
      minAccVersion: "0.1.0",
      files,
      canonicalDbCid: "bafybeicanonicaldbcid",
      source: { source_type: "manual", ref: "local", created_at: "2026-05-25T00:00:00.000Z" },
    });
    const b = { ...a, files: { "README.md": files["README.md"]!, "canonical.db": files["canonical.db"]! } };

    expect(canonicalReleaseManifestJson(a)).toBe(canonicalReleaseManifestJson(b));
    expect(releaseManifestSha256(a)).toBe(releaseManifestSha256(b));
  });

  test("verifies detached ed25519 signatures and detects tampering", () => {
    const root = makeBundle();
    const files = buildFileSha256Map(root);
    const manifest = buildReleaseManifestV1({
      releaseVersion: "1.0.0",
      minAccVersion: "0.1.0",
      files,
      canonicalDbCid: "bafybeicanonicaldbcid",
      source: { source_type: "ipfs-cid", ref: "bafybeireleasecid", created_at: "2026-05-25T00:00:00.000Z" },
    });
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const signature = signReleaseManifestV1(manifest, privateKey);

    expect(verifyDetachedReleaseManifestSignatureV1(manifest, signature, publicKey).ok).toBe(true);
    const tampered = { ...manifest, min_acc_version: "999.0.0" };
    const verdict = verifyDetachedReleaseManifestSignatureV1(tampered, signature, publicKey);
    expect(verdict.ok).toBe(false);
    expect(verdict.errors.some((e) => e.includes("manifest_sha256"))).toBe(true);
  });

  test("rejects mismatched canonical.db checksum", () => {
    const root = makeBundle();
    const files = buildFileSha256Map(root);
    const manifest = buildReleaseManifestV1({
      releaseVersion: "1.0.0",
      minAccVersion: "0.1.0",
      files,
      canonicalDbCid: "bafybeicanonicaldbcid",
      source: { source_type: "manual", ref: "local", created_at: "2026-05-25T00:00:00.000Z" },
    });
    const broken = { ...manifest, canonical_db: { ...manifest.canonical_db, sha256: "0".repeat(64) } };
    const verdict = validateReleaseManifestV1(broken);
    expect(verdict.ok).toBe(false);
    expect(verdict.errors).toContain("canonical_db.sha256 must match files[canonical_db.path]");
  });
});
