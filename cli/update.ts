// `acc update` — safe self-update path: source, schema, daemon, health, rollback.
import { spawn, spawnSync } from "node:child_process";
import { createHash, verify as verifySignature } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, normalize, resolve } from "node:path";
import { openDb, closeDb } from "../substrate/db";
import { inspectPendingMigrations, runVersionedMigrations } from "../substrate/migration_runner";
import { resolveDbPath } from "../runtime/state_paths";
import { compareSemver } from "../runtime/opencode_version";
import { emitEvent } from "../runtime/events";
import { auxBaseUrl, readAdminToken, rpcGet, rpcPostAuth } from "./rpc";
import { collectChecks, computeReadiness, defaultDoctorEnv, renderReport } from "./doctor";
export type ReleaseSource = { kind: "git"; noPull: boolean } | { kind: "ipfs-cid"; cid: string; gateway?: string };
type ReleaseFile = { path: string; sha256: string; executable?: boolean };
// Manifest fields accepted by the update path. `min_acc_version` is the
// canonical field name (cli/release_manifest.ts ReleaseManifestV1);
// `min_version` is accepted as a legacy alias so older signed bundles still
// gate. `release_version` is canonical; `version` is the legacy alias. Both
// are read tolerantly by manifestMinAccVersion / manifestReleaseVersion.
type ReleaseManifestV1 = { schema_version?: string; version?: string; release_version?: string; min_version?: string; min_acc_version?: string; canonical_db_cid?: string; migrations?: unknown[]; files: ReleaseFile[]; manifest_checksum_sha256: string; signature: { algorithm: "ed25519"; value: string; public_key_id?: string } };
export type UpdateEnv = { out:(line:string)=>void; err:(line:string)=>void; spawnSync:typeof spawnSync; startDaemon:()=>Promise<void>; stopDaemon:()=>Promise<boolean>; healthOk:()=>Promise<boolean>; snapshot:()=>Promise<string[]>; dbPath:string; fetch?: typeof fetch; repoRoot?: string; tmpRoot?: string; ipfsGateway?: string; releasePublicKeyPem?: string; settleMs?: number; installedVersion?: string; };
const run = (env: UpdateEnv, cmd: string, args: string[]) => { const r = env.spawnSync(cmd, args, { encoding: "utf8" }); return { ok: r.status === 0, text: String((r.stdout ?? "") + (r.stderr ?? "")).trim() }; };
const gitHead = (env: UpdateEnv): string | null => { const r = run(env, "git", ["rev-parse", "HEAD"]); return r.ok ? r.text.split(/\r?\n/)[0]!.trim() : null; };
const realStopDaemon = async (): Promise<boolean> => { const base = auxBaseUrl(); const token = readAdminToken(); if (!base || !token) return false; try { const reply = await rpcPostAuth<{ ok?: boolean }>(base + "/shutdown", token, {}); await new Promise((r) => setTimeout(r, 500)); return Boolean(reply.ok); } catch { return false; } };
const realStartDaemon = async (): Promise<void> => { if (auxBaseUrl()) return; const entry = resolve(import.meta.dirname ?? ".", "..", "runtime", "daemon.ts"); const child = spawn("bun", [entry], { detached: true, stdio: "ignore", env: { ...process.env } }); child.unref(); };
const realHealthOk = async (): Promise<boolean> => { const base = auxBaseUrl(); if (!base) return false; try { const health = await rpcGet<{ status?: string }>(base + "/health"); return health.status === "ok"; } catch { return false; } };
const realSnapshot = async (): Promise<string[]> => { const pre = await collectChecks(defaultDoctorEnv()); return renderReport(pre, computeReadiness(pre), false); };
// Installed-version source (documented authority choice): the running
// package.json `version`, read at runtime from the repo root. This is the
// most authoritative installed-version marker because it is bumped in
// lock-step with every shipped release (canonical.db rows are read-only
// baseline and do NOT track the locally-installed acc version). state.db
// carries no separate "installed acc version" row, so package.json is the
// single source of truth. Resolved relative to the update module dir so it
// survives both dev and packaged-install layouts; env.installedVersion
// overrides for tests.
const readInstalledVersion = (env: UpdateEnv): string | null => {
  if (env.installedVersion) return env.installedVersion;
  const candidates = [
    env.repoRoot ? join(env.repoRoot, "package.json") : null,
    resolve(import.meta.dirname ?? ".", "..", "package.json"),
  ].filter((p): p is string => !!p);
  for (const path of candidates) {
    try {
      if (!existsSync(path)) continue;
      const pkg = JSON.parse(readFileSync(path, "utf8")) as { version?: string };
      if (typeof pkg.version === "string" && pkg.version.length > 0) return pkg.version;
    } catch { /* try next candidate */ }
  }
  return null;
};

// Read a release manifest shipped in the git tree at repo root, if present.
// The git update path has no out-of-band manifest fetch (unlike ipfs), so
// the only manifest available is whatever the pulled tree carries. Returns
// null when no manifest file exists (the common case) — the gate is then a
// no-op for the git path. Parse failures also yield null (the deterministic
// core proceeds; an unparseable manifest is not a hard floor signal).
const GIT_RELEASE_MANIFEST_NAMES = ["release-manifest.json", "manifest.json"] as const;
const readGitTreeManifest = (env: UpdateEnv): ReleaseManifestV1 | null => {
  const repoRoot = env.repoRoot ?? process.cwd();
  for (const name of GIT_RELEASE_MANIFEST_NAMES) {
    const path = join(repoRoot, name);
    try {
      if (!existsSync(path)) continue;
      const parsed = JSON.parse(readFileSync(path, "utf8")) as ReleaseManifestV1;
      // Only treat it as a gate-bearing manifest if it actually declares a floor.
      if (parsed && (parsed.min_acc_version || parsed.min_version)) return parsed;
    } catch { /* not a usable manifest; try next */ }
  }
  return null;
};

const manifestMinAccVersion = (manifest: ReleaseManifestV1): string | null =>
  manifest.min_acc_version ?? manifest.min_version ?? null;
const manifestReleaseVersion = (manifest: ReleaseManifestV1): string | null =>
  manifest.release_version ?? manifest.version ?? null;

/** min_acc_version compatibility gate. Returns ok=false (with an
 *  actionable message) when the installed acc version is below the
 *  release's declared minimum — a user several releases behind must apply
 *  an intermediate release first, never partial-apply. Emits an
 *  update_refused ledger row as evidence of the refusal. A manifest with
 *  no min_acc_version is treated as no-floor (ok). */
const checkMinAccVersionGate = (
  manifest: ReleaseManifestV1,
  env: UpdateEnv,
  sourceKind: ReleaseSource["kind"],
): { ok: true } | { ok: false; message: string } => {
  const minVersion = manifestMinAccVersion(manifest);
  if (!minVersion) return { ok: true };
  const installed = readInstalledVersion(env);
  if (!installed) {
    return { ok: false, message: "cannot determine installed acc version (package.json version missing); refusing to apply a release with min_acc_version " + minVersion };
  }
  if (compareSemver(installed, minVersion) >= 0) return { ok: true };
  const releaseVersion = manifestReleaseVersion(manifest);
  const message =
    "this release requires acc ≥ " + minVersion + "; you are on " + installed +
    (releaseVersion ? " (release " + releaseVersion + ")" : "") +
    " — apply an intermediate release first, then re-run acc update. Refusing to partial-apply across the version gap.";
  // Ledger evidence of the refusal (fail-loud, never silent partial-apply).
  try {
    if (existsSync(env.dbPath)) {
      const db = openDb(env.dbPath);
      try {
        emitEvent(db, {
          kind: "update_refused",
          substrate_origin: "substrate_auto",
          payload: {
            reason: "min_acc_version_gate",
            installed_version: installed,
            min_acc_version: minVersion,
            release_version: releaseVersion,
            source_kind: sourceKind,
          },
        });
      } finally {
        closeDb(env.dbPath);
      }
    }
  } catch { /* evidence emit is best-effort; the refusal itself still stands */ }
  return { ok: false, message };
};

export const defaultUpdateEnv = (): UpdateEnv => ({ out:(line)=>console.log(line), err:(line)=>console.error(line), spawnSync, startDaemon: realStartDaemon, stopDaemon: realStopDaemon, healthOk: realHealthOk, snapshot: realSnapshot, dbPath: resolveDbPath() });
const usage = () => "acc update — safe self-update\n\nUsage: acc update [--yes] [--no-pull] [--source git|ipfs-cid] [--cid CID] [--gateway URL]";

const sha256Bytes = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");
const sha256File = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");
const argValue = (argv: string[], name: string): string | undefined => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
export const parseReleaseSource = (argv: string[], env: UpdateEnv = defaultUpdateEnv()): ReleaseSource => { const explicit = argValue(argv, "--source"); const cid = argValue(argv, "--cid") ?? argValue(argv, "--ipfs-cid"); const gateway = argValue(argv, "--gateway") ?? env.ipfsGateway ?? process.env.ACC_UPDATE_IPFS_GATEWAY ?? process.env.PINATA_GATEWAY_URL; if (explicit?.startsWith("ipfs-cid:")) return { kind: "ipfs-cid", cid: explicit.slice("ipfs-cid:".length), gateway }; if (explicit === "ipfs-cid" || cid) return { kind: "ipfs-cid", cid: (cid ?? "").replace(/^ipfs:\/\//, ""), gateway }; return { kind: "git", noPull: argv.includes("--no-pull") }; };
const canonicalJson = (value: unknown): string => { if (value === null || typeof value !== "object") return JSON.stringify(value); if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]"; const obj = value as Record<string, unknown>; return "{" + Object.keys(obj).sort().map((k) => JSON.stringify(k) + ":" + canonicalJson(obj[k])).join(",") + "}"; };
const unsignedManifestPayload = (manifest: ReleaseManifestV1): string => { const { manifest_checksum_sha256: _checksum, signature: _signature, ...rest } = manifest; void _checksum; void _signature; return canonicalJson(rest); };
const verifyManifest = (manifest: ReleaseManifestV1, env: UpdateEnv): { ok: true } | { ok: false; error: string } => { if (!Array.isArray(manifest.files) || manifest.files.length === 0) return { ok: false, error: "manifest_files_missing" }; if (!manifest.signature?.value || manifest.signature.algorithm !== "ed25519") return { ok: false, error: "manifest_signature_missing_or_unsupported" }; const payload = unsignedManifestPayload(manifest); if (sha256Bytes(payload) !== manifest.manifest_checksum_sha256) return { ok: false, error: "manifest_checksum_mismatch" }; const publicKey = env.releasePublicKeyPem ?? process.env.ACC_UPDATE_RELEASE_PUBLIC_KEY; if (!publicKey) return { ok: false, error: "release_public_key_missing" }; const ok = verifySignature(null, Buffer.from(payload), publicKey, Buffer.from(manifest.signature.value, "base64")); return ok ? { ok: true } : { ok: false, error: "manifest_signature_invalid" }; };
const safeBundlePath = (root: string, rel: string): string | null => { if (!rel || isAbsolute(rel)) return null; const normalized = normalize(rel); if (normalized === "." || normalized.startsWith("..") || normalized.includes("/.git/") || normalized === ".git") return null; return join(root, normalized); };
const ipfsBaseUrl = (cid: string, gateway?: string): string => { const g = (gateway ?? "https://gateway.pinata.cloud").replace(/\/+$/, ""); if (g.includes("{cid}")) return g.replace("{cid}", encodeURIComponent(cid)); if (g.endsWith("/ipfs/" + cid)) return g; if (g.endsWith("/ipfs")) return g + "/" + encodeURIComponent(cid); return g + "/ipfs/" + encodeURIComponent(cid); };
const fetchBytes = async (env: UpdateEnv, url: string): Promise<Uint8Array> => { const res = await (env.fetch ?? fetch)(url); if (!res.ok) throw new Error("fetch_failed:" + res.status + ":" + url); return new Uint8Array(await res.arrayBuffer()); };
const fetchAndApplyIpfsRelease = async (source: Extract<ReleaseSource, { kind: "ipfs-cid" }>, env: UpdateEnv): Promise<{ ok: true; summary: string } | { ok: false; error: string }> => { if (!source.cid) return { ok: false, error: "ipfs_cid_missing" }; const repoRoot = env.repoRoot ?? process.cwd(); const stageRoot = mkdtempSync(join(env.tmpRoot ?? tmpdir(), "acc2-release-")); try { const base = ipfsBaseUrl(source.cid, source.gateway); const manifestBytes = await fetchBytes(env, base + "/manifest.json"); let manifest: ReleaseManifestV1; try { manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as ReleaseManifestV1; } catch (err) { return { ok: false, error: "manifest_unparseable:" + (err as Error).message }; } const verified = verifyManifest(manifest, env); if (!verified.ok) return verified; const gate = checkMinAccVersionGate(manifest, env, "ipfs-cid"); if (!gate.ok) return { ok: false, error: "min_acc_version_gate: " + gate.message }; for (const file of manifest.files) { if (!/^[a-f0-9]{64}$/.test(file.sha256)) return { ok: false, error: "file_hash_invalid:" + file.path }; const staged = safeBundlePath(stageRoot, file.path); if (!staged) return { ok: false, error: "unsafe_bundle_path:" + file.path }; mkdirSync(dirname(staged), { recursive: true }); const bytes = await fetchBytes(env, base + "/" + file.path.split("/").map(encodeURIComponent).join("/")); writeFileSync(staged, bytes); if (sha256Bytes(bytes) !== file.sha256) return { ok: false, error: "file_hash_mismatch:" + file.path }; } for (const file of manifest.files) { const staged = safeBundlePath(stageRoot, file.path); const target = safeBundlePath(repoRoot, file.path); if (!staged || !target) return { ok: false, error: "unsafe_bundle_path:" + file.path }; mkdirSync(dirname(target), { recursive: true }); copyFileSync(staged, target); if (sha256File(target) !== file.sha256) return { ok: false, error: "applied_file_hash_mismatch:" + file.path }; } return { ok: true, summary: "ipfs release " + source.cid + " applied (" + manifest.files.length + " files)" }; } catch (err) { return { ok: false, error: (err as Error).message }; } finally { rmSync(stageRoot, { recursive: true, force: true }); } };
const applyMigrationsAndRestart = async (env: UpdateEnv, before: string): Promise<number> => { if (existsSync(env.dbPath)) { const db = openDb(env.dbPath); try { const pending = inspectPendingMigrations(db); env.out("pending migrations: " + (pending.pending_versions.length ? pending.pending_versions.join(", ") : "none")); const applied = runVersionedMigrations(db); if (applied.failed) { env.err("migration failed: " + applied.errors.join("; ")); return 1; } if (applied.applied) env.out("migrations applied: " + applied.versions_applied.join(", ")); } finally { closeDb(env.dbPath); } } const wasRunning = await env.stopDaemon(); if (wasRunning) env.out("daemon drained and stopped"); await env.startDaemon(); await new Promise((r) => setTimeout(r, env.settleMs ?? 1000)); if (await env.healthOk()) { env.out("post-update health: ok"); return 0; } env.err("post-update health failed; rolling source back"); const rb = run(env, "git", ["reset", "--hard", before]); if (!rb.ok) { env.err("rollback failed: " + rb.text); return 1; } await env.stopDaemon(); await env.startDaemon(); env.err("rollback complete; inspect with acc doctor"); return 1; };

export const runUpdate = async (argv: string[], env: UpdateEnv = defaultUpdateEnv()): Promise<number> => {
  if (argv.includes("--help") || argv.includes("-h")) { env.out(usage()); return 0; }
  if (!(argv.includes("--yes") || argv.includes("-y"))) { env.err("acc update mutates source/schema/daemon; rerun with --yes to proceed"); return 1; }
  const source = parseReleaseSource(argv, env);
  env.out("pre-update health snapshot:"); for (const line of await env.snapshot()) env.out("  " + line);
  const before = gitHead(env); if (!before) { env.err("cannot read current git HEAD; refusing update"); return 1; } env.out("source before: " + before);
  if (source.kind === "git") {
    if (!source.noPull) { const pull = run(env, "git", ["pull", "--ff-only"]); if (!pull.ok) { env.err("git pull --ff-only failed: " + pull.text); return 1; } env.out(pull.text || "source already current"); }
    env.out("source after:  " + (gitHead(env) ?? before));
    // min_acc_version gate (git path): the pulled tree may ship a release
    // manifest at repo root (release-manifest.json). When present, enforce
    // the same compatibility floor as the ipfs path. A behind organism that
    // pulls a release requiring a newer acc MUST be rolled back to its
    // pre-update HEAD rather than running incompatible migrations — never
    // silent partial-apply.
    const gitManifest = readGitTreeManifest(env);
    if (gitManifest) {
      const gate = checkMinAccVersionGate(gitManifest, env, "git");
      if (!gate.ok) {
        env.err("min_acc_version_gate: " + gate.message);
        env.err("rolling source back to pre-update HEAD " + before);
        const rb = run(env, "git", ["reset", "--hard", before]);
        if (!rb.ok) { env.err("rollback failed: " + rb.text); }
        return 1;
      }
    }
  } else {
    const applied = await fetchAndApplyIpfsRelease(source, env);
    if (!applied.ok) { env.err("ipfs release apply failed: " + applied.error); return 1; }
    env.out(applied.summary);
  }
  return applyMigrationsAndRestart(env, before);
};
if (import.meta.main) void runUpdate(process.argv.slice(2)).then((code) => process.exit(code));
