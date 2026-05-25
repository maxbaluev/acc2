// `acc update` self-update path: gate, happy path, and rollback-on-failed-health.
// runUpdate takes an injectable UpdateEnv so we drive git/daemon/health via mocks
// without touching the real source tree, daemon, or state.db.
import { test, expect, describe } from "bun:test";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, closeDb } from "../substrate/db";
import { compareSemver } from "../runtime/opencode_version";
import { runUpdate, type UpdateEnv } from "./update";

type Call = { cmd: string; args: string[] };

const makeEnv = (opts: {
  healthOk: boolean;
  calls: Call[];
  events: string[];
}): UpdateEnv => ({
  out: (line) => opts.events.push("OUT " + line),
  err: (line) => opts.events.push("ERR " + line),
  // Mock spawnSync: git rev-parse/pull/reset all succeed; record every call.
  spawnSync: ((cmd: string, args: string[]) => {
    opts.calls.push({ cmd, args });
    if (args[0] === "rev-parse") return { status: 0, stdout: "abc1234deadbeef\n", stderr: "" } as never;
    return { status: 0, stdout: "", stderr: "" } as never;
  }) as unknown as UpdateEnv["spawnSync"],
  startDaemon: async () => { opts.events.push("START"); },
  stopDaemon: async () => { opts.events.push("STOP"); return true; },
  healthOk: async () => opts.healthOk,
  // Injected so the test never runs the real doctor probe (which contends on
  // the live state.db/daemon under parallel test load — the cause of the
  // earlier parallel-only failure).
  snapshot: async () => ["mock pre-update snapshot: ok"],
  // Nonexistent db path → migration block is skipped (existsSync false).
  dbPath: "/nonexistent/acc2-update-test/state.db",
  settleMs: 0,
});

describe("acc update", () => {
  test("refuses to mutate without --yes", async () => {
    const events: string[] = [];
    const code = await runUpdate([], makeEnv({ healthOk: true, calls: [], events }));
    expect(code).toBe(1);
    expect(events.some((e) => e.includes("rerun with --yes"))).toBe(true);
    // No daemon mutation happened.
    expect(events).not.toContain("STOP");
  });

  test("--help returns 0 without mutating", async () => {
    const events: string[] = [];
    const calls: Call[] = [];
    const code = await runUpdate(["--help"], makeEnv({ healthOk: true, calls, events }));
    expect(code).toBe(0);
    expect(calls.length).toBe(0);
  });

  test("happy path: post-update health ok returns 0 and restarts the daemon", async () => {
    const events: string[] = [];
    const calls: Call[] = [];
    const code = await runUpdate(["--yes", "--no-pull"], makeEnv({ healthOk: true, calls, events }));
    expect(code).toBe(0);
    expect(events).toContain("STOP");
    expect(events).toContain("START");
    expect(events.some((e) => e.includes("post-update health: ok"))).toBe(true);
    // --no-pull means no `git pull`; only rev-parse before/after.
    expect(calls.every((c) => c.args[0] !== "pull")).toBe(true);
    // No rollback reset on the happy path.
    expect(calls.every((c) => !(c.args[0] === "reset"))).toBe(true);
  });

  test("rollback: failed post-update health resets --hard to the pre-update HEAD and returns 1", async () => {
    const events: string[] = [];
    const calls: Call[] = [];
    const code = await runUpdate(["--yes", "--no-pull"], makeEnv({ healthOk: false, calls, events }));
    expect(code).toBe(1);
    // Rolled back to the HEAD captured before the update (abc1234deadbeef).
    const reset = calls.find((c) => c.cmd === "git" && c.args[0] === "reset");
    expect(reset).toBeDefined();
    expect(reset!.args).toEqual(["reset", "--hard", "abc1234deadbeef"]);
    expect(events.some((e) => e.includes("rolling source back"))).toBe(true);
  });
});


describe("acc update release sources", () => {
  const canonicalJson = (value: unknown): string => { if (value === null || typeof value !== "object") return JSON.stringify(value); if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]"; const obj = value as Record<string, unknown>; return "{" + Object.keys(obj).sort().map((k) => JSON.stringify(k) + ":" + canonicalJson(obj[k])).join(",") + "}"; };
  const signedManifest = (files: Array<{ path: string; body: string }>) => { const { publicKey, privateKey } = generateKeyPairSync("ed25519"); const manifestFiles = files.map((f) => ({ path: f.path, sha256: createHash("sha256").update(f.body).digest("hex") })); const unsigned = { schema_version: "acc2.release.v1", version: "1.2.3", canonical_db_cid: "bafycanonical", migrations: [], files: manifestFiles }; const payload = canonicalJson(unsigned); return { publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(), manifest: { ...unsigned, manifest_checksum_sha256: createHash("sha256").update(payload).digest("hex"), signature: { algorithm: "ed25519" as const, value: sign(null, Buffer.from(payload), privateKey).toString("base64") } } }; };
  test("ipfs-cid fetch verifies signed manifest and file hashes before deterministic core", async () => { const root = mkdtempSync(join(tmpdir(), "acc2-update-ipfs-")); try { const body = "export const updated = true;\n"; const signed = signedManifest([{ path: "tmp-release-file.ts", body }]); const events: string[] = []; const calls: Call[] = []; const env = makeEnv({ healthOk: true, calls, events }); const code = await runUpdate(["--yes", "--source", "ipfs-cid", "--cid", "bafytest"], { ...env, repoRoot: root, releasePublicKeyPem: signed.publicKeyPem, fetch: (async (url: string) => { if (url.endsWith("/manifest.json")) return new Response(JSON.stringify(signed.manifest)); if (url.endsWith("/tmp-release-file.ts")) return new Response(body); return new Response("missing", { status: 404 }); }) as typeof fetch }); expect(code).toBe(0); expect(readFileSync(join(root, "tmp-release-file.ts"), "utf8")).toBe(body); expect(events.some((e) => e.includes("ipfs release bafytest applied (1 files)"))).toBe(true); expect(calls.every((c) => c.args[0] !== "pull")).toBe(true); expect(events.some((e) => e.includes("post-update health: ok"))).toBe(true); } finally { rmSync(root, { recursive: true, force: true }); } });
  test("ipfs-cid refuses a bundle file hash mismatch before restart", async () => { const root = mkdtempSync(join(tmpdir(), "acc2-update-ipfs-bad-")); try { const signed = signedManifest([{ path: "tmp-release-file.ts", body: "expected" }]); const events: string[] = []; const calls: Call[] = []; const env = makeEnv({ healthOk: true, calls, events }); const code = await runUpdate(["--yes", "--ipfs-cid", "bafybad"], { ...env, repoRoot: root, releasePublicKeyPem: signed.publicKeyPem, fetch: (async (url: string) => { if (url.endsWith("/manifest.json")) return new Response(JSON.stringify(signed.manifest)); if (url.endsWith("/tmp-release-file.ts")) return new Response("tampered"); return new Response("missing", { status: 404 }); }) as typeof fetch }); expect(code).toBe(1); expect(events.some((e) => e.includes("file_hash_mismatch:tmp-release-file.ts"))).toBe(true); expect(events).not.toContain("STOP"); expect(calls.every((c) => c.args[0] !== "pull")).toBe(true); } finally { rmSync(root, { recursive: true, force: true }); } });
});


describe("acc update min_acc_version compatibility gate", () => {
  const canonicalJson = (value: unknown): string => { if (value === null || typeof value !== "object") return JSON.stringify(value); if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]"; const obj = value as Record<string, unknown>; return "{" + Object.keys(obj).sort().map((k) => JSON.stringify(k) + ":" + canonicalJson(obj[k])).join(",") + "}"; };
  // Builds a SIGNED manifest carrying min_acc_version + release_version so the
  // gate has a real floor to compare the installed version against.
  const signedManifestWithMin = (minAccVersion: string, releaseVersion: string, files: Array<{ path: string; body: string }>) => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const manifestFiles = files.map((f) => ({ path: f.path, sha256: createHash("sha256").update(f.body).digest("hex") }));
    const unsigned = { schema_version: "acc2.release.v1", release_version: releaseVersion, min_acc_version: minAccVersion, canonical_db_cid: "bafycanonical", migrations: [], files: manifestFiles };
    const payload = canonicalJson(unsigned);
    return { publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(), manifest: { ...unsigned, manifest_checksum_sha256: createHash("sha256").update(payload).digest("hex"), signature: { algorithm: "ed25519" as const, value: sign(null, Buffer.from(payload), privateKey).toString("base64") } } };
  };

  test("semver compare is numeric, not string: 0.9.0 < 0.10.0", () => {
    expect(compareSemver("0.9.0", "0.10.0")).toBe(-1);
    expect(compareSemver("0.10.0", "0.9.0")).toBe(1);
    expect(compareSemver("1.2.3", "1.2.3")).toBe(0);
    // A naive string compare would say "0.9.0" > "0.10.0" — confirm we don't.
    expect("0.9.0" > "0.10.0").toBe(true); // string compare is WRONG
    expect(compareSemver("0.9.0", "0.10.0") < 0).toBe(true); // semver is RIGHT
  });

  test("ipfs: installed < min_acc_version → update REFUSES with an actionable message + ledger evidence, no partial-apply", async () => {
    const root = mkdtempSync(join(tmpdir(), "acc2-update-gate-"));
    const dbPath = join(root, "state.db");
    try {
      // Real DB so the update_refused ledger row can be written + asserted.
      const db = openDb(dbPath); closeDb(dbPath); void db;
      const body = "export const updated = true;\n";
      const signed = signedManifestWithMin("0.10.0", "0.10.0", [{ path: "tmp-gate-file.ts", body }]);
      const events: string[] = [];
      const calls: Call[] = [];
      const env = makeEnv({ healthOk: true, calls, events });
      const code = await runUpdate(["--yes", "--source", "ipfs-cid", "--cid", "bafygate"], {
        ...env, dbPath, repoRoot: root, installedVersion: "0.9.0", releasePublicKeyPem: signed.publicKeyPem,
        fetch: (async (url: string) => { if (url.endsWith("/manifest.json")) return new Response(JSON.stringify(signed.manifest)); if (url.endsWith("/tmp-gate-file.ts")) return new Response(body); return new Response("missing", { status: 404 }); }) as typeof fetch,
      });
      expect(code).toBe(1);
      // Actionable message names the required version, the installed version, and the remedy.
      expect(events.some((e) => e.includes("requires acc ≥ 0.10.0"))).toBe(true);
      expect(events.some((e) => e.includes("you are on 0.9.0"))).toBe(true);
      expect(events.some((e) => e.includes("apply an intermediate release first"))).toBe(true);
      // NO partial-apply: the bundle file was never written, daemon never bounced.
      expect(existsSync(join(root, "tmp-gate-file.ts"))).toBe(false);
      expect(events).not.toContain("STOP");
      expect(events).not.toContain("START");
      // Ledger evidence of the refusal.
      const verify = openDb(dbPath);
      try {
        const row = verify.query<{ c: number }, []>(
          `SELECT COUNT(*) AS c FROM events
            WHERE kind = 'update_refused'
              AND json_extract(payload, '$.reason') = 'min_acc_version_gate'
              AND json_extract(payload, '$.installed_version') = '0.9.0'
              AND json_extract(payload, '$.min_acc_version') = '0.10.0'`,
        ).get();
        expect(row?.c ?? 0).toBe(1);
      } finally { closeDb(dbPath); }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("ipfs: installed >= min_acc_version → gate passes and the release applies", async () => {
    const root = mkdtempSync(join(tmpdir(), "acc2-update-gate-ok-"));
    try {
      const body = "export const updated = true;\n";
      const signed = signedManifestWithMin("0.9.0", "1.0.0", [{ path: "tmp-gate-ok.ts", body }]);
      const events: string[] = [];
      const calls: Call[] = [];
      const env = makeEnv({ healthOk: true, calls, events });
      const code = await runUpdate(["--yes", "--source", "ipfs-cid", "--cid", "bafyok"], {
        ...env, repoRoot: root, installedVersion: "0.9.0", releasePublicKeyPem: signed.publicKeyPem,
        fetch: (async (url: string) => { if (url.endsWith("/manifest.json")) return new Response(JSON.stringify(signed.manifest)); if (url.endsWith("/tmp-gate-ok.ts")) return new Response(body); return new Response("missing", { status: 404 }); }) as typeof fetch,
      });
      expect(code).toBe(0);
      expect(readFileSync(join(root, "tmp-gate-ok.ts"), "utf8")).toBe(body);
      expect(events.some((e) => e.includes("post-update health: ok"))).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("git: a pulled tree manifest with min_acc_version > installed → refuses and rolls source back", async () => {
    const root = mkdtempSync(join(tmpdir(), "acc2-update-git-gate-"));
    try {
      // Simulate the pulled tree carrying a release manifest at repo root.
      writeFileSync(join(root, "release-manifest.json"), JSON.stringify({ schema_version: "acc2.release.v1", release_version: "2.0.0", min_acc_version: "1.5.0", files: {} }));
      const events: string[] = [];
      const calls: Call[] = [];
      const env = makeEnv({ healthOk: true, calls, events });
      const code = await runUpdate(["--yes", "--no-pull"], { ...env, repoRoot: root, installedVersion: "1.0.0" });
      expect(code).toBe(1);
      expect(events.some((e) => e.includes("requires acc ≥ 1.5.0"))).toBe(true);
      expect(events.some((e) => e.includes("you are on 1.0.0"))).toBe(true);
      // Rolled the source back to pre-update HEAD; never started migrations/daemon.
      const reset = calls.find((c) => c.cmd === "git" && c.args[0] === "reset");
      expect(reset).toBeDefined();
      expect(events).not.toContain("START");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
