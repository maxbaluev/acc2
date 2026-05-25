import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../substrate/db";
import { defaultVersionEnv } from "../runtime/opencode_version";
import { runAdmin } from "./admin";
import { runBundleRelease, runBundleReleaseCmd } from "./admin_bundle_release";
import { validateReleaseManifestV1 } from "./release_manifest";

const seedPortableRows = (db: ReturnType<typeof openDb>): void => {
  db.run(`INSERT INTO events (id, ts, directive_id, task_id, loop_id, substrate_origin, kind, payload, context_refs)
          VALUES ('KC_BUNDLE', '2026-05-25T00:00:00.000Z', 'd', 't', 'l', 'claude_root', 'knowledge_candidate', ?, '[]')`,
    [JSON.stringify({ claim: "portable bundle claim", portable: true })]);
  db.run(`INSERT INTO events (id, ts, directive_id, task_id, loop_id, substrate_origin, kind, payload, context_refs)
          VALUES ('KP_BUNDLE', '2026-05-25T00:00:00.000Z', 'd', 't', 'l', 'claude_root', 'knowledge_promoted', ?, '["KC_BUNDLE"]')`,
    [JSON.stringify({ candidate_id: "KC_BUNDLE", portable: true, score: 0.8, confidence: 0.7 })]);
};

describe("acc admin bundle-release", () => {
  test("requires approval before writing a bundle", async () => {
    const err: string[] = [];
    const code = await runBundleReleaseCmd(["/tmp/nope", "--version", "1.0.0"], { out: () => {}, err: (line) => err.push(line), yes: false });
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("missing --yes");
  });

  test("exports canonical.db, writes a valid manifest, and records release metadata", async () => {
    const root = mkdtempSync(join(tmpdir(), "acc2-bundle-release-"));
    try {
      const db = openDb(join(root, "state.db"));
      seedPortableRows(db);
      const bundleDir = join(root, "bundle");
      const result = await runBundleRelease({
        bundleDir,
        releaseVersion: "1.2.3",
        minAccVersion: "0.1.0",
        canonicalDbCid: "bafyCanonical",
        sourceDb: db,
        nowIso: () => "2026-05-25T00:00:00.000Z",
      });
      expect(result.ok).toBe(true);
      expect(existsSync(join(bundleDir, "canonical.db"))).toBe(true);
      expect(existsSync(join(bundleDir, "manifest.json"))).toBe(true);
      const manifest = JSON.parse(readFileSync(join(bundleDir, "manifest.json"), "utf8"));
      expect(validateReleaseManifestV1(manifest).ok).toBe(true);
      expect(manifest.release_version).toBe("1.2.3");
      expect(manifest.min_acc_version).toBe("0.1.0");
      expect(manifest.files["canonical.db"]).toMatch(/^[a-f0-9]{64}$/);
      expect(manifest.canonical_db.cid).toBe("bafyCanonical");
      const row = db.query("SELECT payload FROM events WHERE kind = 'state_exported' AND json_extract(payload, '$.mode') = 'release_bundle' ORDER BY ts DESC LIMIT 1").get() as { payload: string };
      const payload = JSON.parse(row.payload);
      expect(payload.release_version).toBe("1.2.3");
      expect(payload.p2p_ready.pubsub_implemented).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("admin dispatcher routes bundle-release", async () => {
    const root = mkdtempSync(join(tmpdir(), "acc2-bundle-release-route-"));
    try {
      const db = openDb(join(root, "route-state.db"));
      seedPortableRows(db);
      const out: string[] = [];
      const err: string[] = [];
      const code = await runAdmin(["bundle-release", join(root, "bundle"), "--version", "2.0.0", "--yes"], {
        version: { ...defaultVersionEnv(), spawn: () => ({ status: 0, stdout: "", stderr: "" }) },
        stopDaemon: async () => false,
        startDaemon: async () => undefined,
        prompt: async () => "y",
        out: (line) => out.push(line),
        err: (line) => err.push(line),
        yes: false,
        openSubstrate: () => db,
      });
      expect(code).toBe(0);
      expect(out.join("\n")).toContain("bundle-release: wrote");
      expect(err).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
