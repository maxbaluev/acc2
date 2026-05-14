// `acc doctor` — canonical "is this install ready for real-brain dispatch?"
// diagnostic. Each check returns a typed verdict; the final exit code is 0 if
// every check is ok/warn/info, 1 if any check is fail.
//
// v2-design.md §1 binds the system to subscription CLIs (Claude Code,
// opencode) plus the single API-key exception (OPENAI_API_KEY for
// text-embedding-3-small); §5 binds the always-on daemon and its health
// surface. Doctor folds those constraints into one structured surface so the
// operator can see at a glance what is missing for `ACC2_BRIDGE_MODE=real`
// production dispatch.
//
// Checks are factored as pure functions taking a `DoctorEnv` (env vars +
// subprocess + filesystem probes). Tests inject stubs; in production the
// defaults run real subprocess + fs calls.

import { existsSync, statfsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";
import { auxBaseUrl, readDaemonLock, rpcGet } from "./rpc";
import { resolveDbPath } from "../runtime/state_paths";

export type Verdict = "ok" | "warn" | "fail" | "info";
export type Check = { name: string; verdict: Verdict; detail: string };

// ── Environment shim — injected by tests, defaulted to real I/O ───────────

export type DoctorEnv = {
  env: Record<string, string | undefined>;
  which: (cmd: string) => string | null;
  version: (cmd: string, args: string[]) => string | null;
  fileExists: (path: string) => boolean;
  diskFreeBytes: (dir: string) => number | null;
  daemonHealth: () => Promise<DaemonHealthSnapshot>;
  homedir: () => string;
  platform: NodeJS.Platform;
  /** SubstrateCounts: cheap COUNT() probes against the state DB. Tests
   *  inject deterministic values; production opens the resolved DB and
   *  runs two SELECT COUNTs. Errors become NaN so the checks can
   *  classify them as fail with a useful detail string. */
  substrateCounts: () => SubstrateCounts;
  /** Returns true when sqlite-vec loads into an ephemeral in-memory DB
   *  AND `CREATE VIRTUAL TABLE … USING vec0(...)` succeeds. Tests
   *  inject; production opens a fresh :memory: handle via openDb (which
   *  loads the extension before runSchema). */
  vecExtensionLoadable: () => VecLoadResult;
};

export type SubstrateCounts = {
  /** kind='knowledge_promoted' row count, or NaN on probe error. */
  knowledgePromoted: number;
  /** code_artifact rows where name LIKE 'seed_%' OR id LIKE 'seed_%',
   *  or NaN on probe error. */
  seedArtifacts: number;
  /** Error message when the probe could not run (DB missing, sealed,
   *  etc). null when the probe ran cleanly even if counts are 0. */
  error: string | null;
};

export type VecLoadResult = {
  ok: boolean;
  /** sqlite-vec version string when ok=true (e.g. "v0.1.6"). */
  version?: string;
  error?: string;
};

export type DaemonHealthSnapshot = {
  reachable: boolean;          // could we even contact the daemon?
  ok: boolean;                 // status === "ok"?
  pid?: number | null;
  uptime_ms?: number;
  events_count?: number;
  raw?: unknown;
  error?: string;
};

// Real implementations (production wiring).

const realWhich = (cmd: string): string | null => {
  const out = spawnSync("sh", ["-lc", `command -v ${JSON.stringify(cmd)}`], { encoding: "utf8" });
  if (out.status !== 0) return null;
  const path = (out.stdout ?? "").trim();
  return path.length > 0 ? path : null;
};

const realVersion = (cmd: string, args: string[]): string | null => {
  const out = spawnSync(cmd, args, { encoding: "utf8" });
  if (out.status !== 0) return null;
  return (out.stdout ?? out.stderr ?? "").trim() || null;
};

const realDaemonHealth = async (): Promise<DaemonHealthSnapshot> => {
  const base = auxBaseUrl();
  if (!base) return { reachable: false, ok: false, error: "no socket lock found" };
  try {
    const raw = await rpcGet<Record<string, unknown>>(`${base}/health`);
    const lock = readDaemonLock();
    const ok = (raw as { status?: string }).status === "ok";
    return {
      reachable: true,
      ok,
      pid: lock?.pid ?? null,
      uptime_ms: (raw as { uptime_ms?: number }).uptime_ms ?? 0,
      events_count: (raw as { events_count?: number }).events_count ?? 0,
      raw,
    };
  } catch (err) {
    return { reachable: false, ok: false, error: (err as Error).message };
  }
};

const realSubstrateCounts = (): SubstrateCounts => {
  // Resolve the canonical DB path the same way the daemon does so
  // doctor sees what daemon-start would open. resolveDbPath honors
  // ACC2_DB_PATH / ${stateDir}/state.db with no repo fallback.
  const dbPath = resolveDbPath();
  if (!existsSync(dbPath)) {
    return {
      knowledgePromoted: NaN, seedArtifacts: NaN,
      error: `state DB not found at ${dbPath} — run \`acc init --yes\``,
    };
  }
  try {
    // Open via the shared substrate connection cache so we don't fight
    // the daemon's WAL handle. Read-only-style probes — we never write.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { openDb } = require("../substrate/db") as typeof import("../substrate/db");
    const db = openDb(dbPath);
    const k = db
      .query("SELECT COUNT(*) AS n FROM events WHERE kind = 'knowledge_promoted'")
      .get() as { n: number };
    const a = db
      .query(
        "SELECT COUNT(*) AS n FROM code_artifact WHERE name LIKE 'seed_%' OR id LIKE 'seed_%'",
      )
      .get() as { n: number };
    return { knowledgePromoted: k.n, seedArtifacts: a.n, error: null };
  } catch (err) {
    return {
      knowledgePromoted: NaN, seedArtifacts: NaN,
      error: `db probe failed: ${(err as Error).message}`,
    };
  }
};

const realVecExtensionLoadable = (): VecLoadResult => {
  try {
    // openDb(":memory:") loads sqlite-vec BEFORE runSchema, and runSchema
    // creates the `vec_events` virtual table via vec0(…). If either the
    // extension load or the virtual-table creation fails, this throws.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { openDb, closeDb } = require("../substrate/db") as typeof import("../substrate/db");
    const probe = openDb(":memory:");
    try {
      const row = probe.query("SELECT vec_version() AS v").get() as { v: string };
      // Independent vec0 virtual-table check: create a tiny throwaway
      // table so we PROVE the runtime constructor works under doctor's
      // own probe, not just the cached schema run.
      probe.run("CREATE VIRTUAL TABLE IF NOT EXISTS vec_doctor_probe USING vec0(embedding float[8])");
      probe.run("DROP TABLE vec_doctor_probe");
      return { ok: true, version: row.v };
    } finally {
      try { closeDb(":memory:"); } catch { /* swallow */ }
    }
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
};

export const defaultDoctorEnv = (): DoctorEnv => ({
  env: process.env,
  which: realWhich,
  version: realVersion,
  fileExists: (p) => existsSync(p),
  diskFreeBytes: (dir) => {
    try { const s = statfsSync(dir); return Number(s.bavail) * Number(s.bsize); } catch { return null; }
  },
  daemonHealth: realDaemonHealth,
  homedir,
  platform: process.platform,
  substrateCounts: realSubstrateCounts,
  vecExtensionLoadable: realVecExtensionLoadable,
});

// ── Individual checks ─────────────────────────────────────────────────────

export const checkDaemonHealth = async (env: DoctorEnv): Promise<Check> => {
  const snap = await env.daemonHealth();
  if (!snap.reachable) {
    return { name: "daemon health", verdict: "warn",
      detail: `not running (${snap.error ?? "no socket"}); start with \`acc daemon start\`` };
  }
  if (!snap.ok) {
    return { name: "daemon health", verdict: "fail",
      detail: `unhealthy: ${snap.error ?? JSON.stringify(snap.raw).slice(0, 120)}` };
  }
  const upMs = snap.uptime_ms ?? 0;
  const upH = Math.floor(upMs / 3_600_000);
  const upM = Math.floor((upMs % 3_600_000) / 60_000);
  return { name: "daemon health", verdict: "ok",
    detail: `pid ${snap.pid ?? "?"}, uptime ${upH}h${upM}m, events=${snap.events_count ?? 0}` };
};

export const checkDbIntegrity = async (env: DoctorEnv): Promise<Check> => {
  // Per v2-design.md §5, the daemon owns the WAL connection. The /health
  // endpoint already runs in-process and returns events_count; PRAGMA
  // integrity_check is delegated to daemon boot (it would fail to start if
  // the file were corrupt). We surface the delegation explicitly so the
  // operator sees the constraint.
  const snap = await env.daemonHealth();
  if (!snap.reachable) {
    return { name: "db integrity", verdict: "warn",
      detail: "daemon not running — integrity is verified at daemon boot" };
  }
  if (!snap.ok) {
    return { name: "db integrity", verdict: "fail",
      detail: "daemon unhealthy — cannot verify db integrity" };
  }
  return { name: "db integrity", verdict: "ok",
    detail: `ok (events=${snap.events_count ?? 0}; PRAGMA integrity_check passes at boot)` };
};

export const checkDiskFree = (env: DoctorEnv): Check => {
  const stateDir = resolve(import.meta.dirname ?? ".", "..", "state");
  const free = env.diskFreeBytes(stateDir);
  if (free === null) {
    return { name: "disk space", verdict: "warn",
      detail: `statfs failed on ${stateDir}` };
  }
  const gb = free / 1e9;
  const mb = free / 1e6;
  const human = gb >= 1 ? `${gb.toFixed(2)}GB` : `${mb.toFixed(0)}MB`;
  if (mb < 500) return { name: "disk space", verdict: "fail", detail: `${human} free at ${stateDir} (need ≥ 500MB)` };
  if (gb < 2) return { name: "disk space", verdict: "warn", detail: `${human} free at ${stateDir} (recommend ≥ 2GB)` };
  return { name: "disk space", verdict: "ok", detail: `${human} free` };
};

export const checkOpenAiKey = (env: DoctorEnv): Check => {
  const v = env.env.OPENAI_API_KEY;
  if (v && v.trim().length > 0) {
    return { name: "OPENAI_API_KEY", verdict: "ok",
      detail: "present (used by text-embedding-3-small per v2-design §1)" };
  }
  return { name: "OPENAI_API_KEY", verdict: "warn",
    detail: "missing; run `acc init` to set it (embeddings silently no-op without it)" };
};

export const checkOpencode = (env: DoctorEnv): Check => {
  const path = env.which("opencode");
  if (!path) {
    return { name: "opencode", verdict: "fail",
      detail: "missing; install from https://github.com/sst/opencode (required for ACC2_BRIDGE_MODE=real)" };
  }
  const ver = env.version("opencode", ["--version"]) ?? "unknown";
  return { name: "opencode", verdict: "ok", detail: `${path} (${ver.split("\n")[0]})` };
};

export const checkUv = (env: DoctorEnv): Check => {
  const path = env.which("uv");
  if (!path) {
    return { name: "uv", verdict: "warn",
      detail: "missing; uv runtime artifacts will fail (bun runtime still works)" };
  }
  const ver = env.version("uv", ["--version"]) ?? "unknown";
  return { name: "uv", verdict: "ok", detail: `${path} (${ver.split("\n")[0]})` };
};

export const checkCamoufoxBinary = (env: DoctorEnv): Check => {
  const explicit = env.env.CAMOUFOX_BINARY_PATH;
  if (explicit && env.fileExists(explicit)) {
    return { name: "camoufox binary", verdict: "ok", detail: `${explicit} (from CAMOUFOX_BINARY_PATH)` };
  }
  const cached = join(env.homedir(), ".cache", "camoufox", "camoufox");
  if (env.fileExists(cached)) {
    return { name: "camoufox binary", verdict: "ok", detail: cached };
  }
  return { name: "camoufox binary", verdict: "warn",
    detail: "missing; camofox-browser runtime artifacts will fail (see docs/ops-guide.md)" };
};

export const checkNsjail = (env: DoctorEnv): Check => {
  const path = env.which("nsjail");
  if (path) return { name: "nsjail", verdict: "ok", detail: path };
  // Batch 3.CLEANUP: bumped from `info` to `warn` because nsjail is
  // security-sensitive — the uv runtime's net/proc/fs restrictions degrade to
  // honor-system without it. Operators running untrusted brain-authored uv
  // artifacts SHOULD see this in the doctor's overall verdict, not silently
  // bucketed alongside informational rows.
  return { name: "nsjail", verdict: "warn",
    detail: "not installed — uv sandbox degrades to honor-system (runs still work, but net/proc/fs restrictions are advisory)" };
};

export const checkBunVersion = (env: DoctorEnv): Check => {
  const raw = env.version("bun", ["--version"]);
  if (!raw) {
    return { name: "bun", verdict: "fail", detail: "bun not found on PATH" };
  }
  // First line of the version output, e.g. "1.3.11"
  const v = raw.split("\n")[0]!.trim();
  const major = Number(v.split(".")[0] ?? 0);
  if (Number.isFinite(major) && major >= 1) {
    return { name: "bun", verdict: "ok", detail: v };
  }
  return { name: "bun", verdict: "fail", detail: `${v} (need ≥ 1.0)` };
};

// Seed minimums. `seedFoundationalKnowledge` (substrate/seed.ts) imports
// 10 laws under owner-approval; `seedCodeArtifacts` admits 8 canonical
// rows. The threshold below sets the floor doctor flips to FAIL on —
// some operators may have evicted or rotated entries, but a DB with
// fewer than 5 of either is structurally incomplete and would silently
// degrade real-brain dispatch.
export const SEED_KNOWLEDGE_MIN = 5;
export const SEED_ARTIFACT_MIN = 5;

/** Substrate-content check: at least SEED_KNOWLEDGE_MIN
 *  `knowledge_promoted` rows must exist in the events ledger. An empty
 *  ledger means `acc init` was not run (or the foundational seed was
 *  declined). Real-brain dispatch composes prompts off this index — a
 *  missing seed silently degrades retrieval. */
export const checkSeedKnowledge = (env: DoctorEnv): Check => {
  const counts = env.substrateCounts();
  if (counts.error !== null) {
    return { name: "seed knowledge", verdict: "fail",
      detail: counts.error };
  }
  if (!Number.isFinite(counts.knowledgePromoted)) {
    return { name: "seed knowledge", verdict: "fail",
      detail: "could not read knowledge_promoted count" };
  }
  if (counts.knowledgePromoted < SEED_KNOWLEDGE_MIN) {
    return { name: "seed knowledge", verdict: "fail",
      detail: `${counts.knowledgePromoted} promoted entries (need ≥ ${SEED_KNOWLEDGE_MIN}) — run \`acc init --yes\`` };
  }
  return { name: "seed knowledge", verdict: "ok",
    detail: `${counts.knowledgePromoted} knowledge_promoted rows` };
};

/** Substrate-content check: at least SEED_ARTIFACT_MIN canonical
 *  `seed_*` code artifacts must exist. v2 used to only seed knowledge —
 *  the production install path now seeds both per Task 1 wiring. A DB
 *  with no seed artifacts means an old or partial install. */
export const checkSeedArtifacts = (env: DoctorEnv): Check => {
  const counts = env.substrateCounts();
  if (counts.error !== null) {
    return { name: "seed artifacts", verdict: "fail",
      detail: counts.error };
  }
  if (!Number.isFinite(counts.seedArtifacts)) {
    return { name: "seed artifacts", verdict: "fail",
      detail: "could not read code_artifact count" };
  }
  if (counts.seedArtifacts < SEED_ARTIFACT_MIN) {
    return { name: "seed artifacts", verdict: "fail",
      detail: `${counts.seedArtifacts} seed_* artifacts (need ≥ ${SEED_ARTIFACT_MIN}) — run \`acc init --yes\`` };
  }
  return { name: "seed artifacts", verdict: "ok",
    detail: `${counts.seedArtifacts} canonical seed_* code artifacts present` };
};

/** Vec extension load probe: opens a fresh :memory: DB and proves
 *  sqlite-vec loads + `CREATE VIRTUAL TABLE … USING vec0(…)` succeeds.
 *  Without this, retrieval silently degrades — substrate.search returns
 *  candidates ordered by cosine across a vector table that does not
 *  exist. v2 throws hard at openDb time if vec0 cannot resolve, but
 *  doctor surfaces it BEFORE the daemon starts. */
export const checkVecExtensionLoadable = (env: DoctorEnv): Check => {
  const v = env.vecExtensionLoadable();
  if (!v.ok) {
    return { name: "sqlite-vec extension", verdict: "fail",
      detail: `vec0 not loadable: ${v.error ?? "unknown"} — retrieval will silently degrade; reinstall the sqlite-vec npm package` };
  }
  return { name: "sqlite-vec extension", verdict: "ok",
    detail: `loaded (${v.version ?? "unknown"}); vec0 virtual table constructor works` };
};

export const checkBridgeMode = (env: DoctorEnv): Check => {
  // Default is now `real` (production dispatch). Tests pin `mock` explicitly
  // via the bun test preload — if the operator sees `mock` here outside a
  // test run, they intentionally overrode the production default.
  const mode = env.env.ACC2_BRIDGE_MODE ?? "real";
  if (mode === "real") {
    return { name: "ACC2_BRIDGE_MODE", verdict: "ok", detail: "real (production dispatch — default)" };
  }
  if (mode === "mock") {
    return { name: "ACC2_BRIDGE_MODE", verdict: "info",
      detail: "mock (override; tests use this — unset to restore real default)" };
  }
  return { name: "ACC2_BRIDGE_MODE", verdict: "warn",
    detail: `unknown value '${mode}' (expected mock | real)` };
};

// Composite readiness verdict — derived from the individual checks. Returns
// the check itself (for table rendering) plus a `missing` list (for the
// final summary line).

export type Readiness = { check: Check; missing: string[] };

export const computeReadiness = (checks: Check[]): Readiness => {
  const find = (n: string) => checks.find((c) => c.name === n);
  const missing: string[] = [];
  if (find("daemon health")?.verdict !== "ok") missing.push("daemon health");
  if (find("OPENAI_API_KEY")?.verdict !== "ok") missing.push("OPENAI_API_KEY");
  if (find("opencode")?.verdict !== "ok") missing.push("opencode");
  const mode = find("ACC2_BRIDGE_MODE");
  if (mode?.verdict !== "ok") missing.push("ACC2_BRIDGE_MODE=real");
  // Substrate-content prereqs — a FAIL on any of these flips the composite
  // verdict because the daemon's first real-brain dispatch would silently
  // degrade (empty retrieval / missing seed artifacts / vec0 not loading).
  if (find("seed knowledge")?.verdict === "fail") missing.push("seed knowledge");
  if (find("seed artifacts")?.verdict === "fail") missing.push("seed artifacts");
  if (find("sqlite-vec extension")?.verdict === "fail") missing.push("sqlite-vec extension");
  if (missing.length === 0) {
    return { check: { name: "ready for real-brain dispatch", verdict: "ok", detail: "all prereqs satisfied" }, missing };
  }
  return { check: { name: "ready for real-brain dispatch", verdict: "fail",
    detail: `missing: ${missing.join(", ")}` }, missing };
};

// ── Rendering ─────────────────────────────────────────────────────────────

const RED = "\x1b[31m"; const YEL = "\x1b[33m"; const GRN = "\x1b[32m"; const CYA = "\x1b[36m"; const RST = "\x1b[0m";

const tagFor = (v: Verdict, useColour: boolean): string => {
  if (!useColour) return `[${v.padEnd(4)}]`;
  if (v === "ok") return `[${GRN}ok${RST}  ]`;
  if (v === "warn") return `[${YEL}warn${RST}]`;
  if (v === "fail") return `[${RED}fail${RST}]`;
  return `[${CYA}info${RST}]`;
};

export const renderReport = (checks: Check[], readiness: Readiness, useColour: boolean): string[] => {
  const lines: string[] = [];
  lines.push("acc doctor — system readiness report");
  lines.push("─────────────────────────────────────");
  let width = 0;
  for (const c of checks) if (c.name.length > width) width = c.name.length;
  for (const c of checks) {
    lines.push(`${tagFor(c.verdict, useColour)} ${c.name.padEnd(width)}  ${c.detail}`);
  }
  lines.push("─────────────────────────────────────");
  const verdictLabel = readiness.check.verdict === "ok" ? "PASS" : "FAIL";
  const label = useColour
    ? (readiness.check.verdict === "ok" ? `${GRN}[${verdictLabel}]${RST}` : `${RED}[${verdictLabel}]${RST}`)
    : `[${verdictLabel}]`;
  lines.push(`${label} ${readiness.check.name}  (${readiness.check.detail})`);
  return lines;
};

// ── Public entrypoint ────────────────────────────────────────────────────

export const collectChecks = async (env: DoctorEnv = defaultDoctorEnv()): Promise<Check[]> => {
  const checks: Check[] = [];
  checks.push(await checkDaemonHealth(env));
  checks.push(await checkDbIntegrity(env));
  checks.push(checkDiskFree(env));
  checks.push(checkOpenAiKey(env));
  checks.push(checkOpencode(env));
  checks.push(checkUv(env));
  checks.push(checkCamoufoxBinary(env));
  checks.push(checkNsjail(env));
  checks.push(checkBunVersion(env));
  checks.push(checkBridgeMode(env));
  // Substrate-content checks (Task 3 wiring). A passing acc doctor now
  // means BOTH file-existence AND state-content correctness — not just
  // "the daemon could open the file".
  checks.push(checkSeedKnowledge(env));
  checks.push(checkSeedArtifacts(env));
  checks.push(checkVecExtensionLoadable(env));
  return checks;
};

export const runDoctor = async (
  _argv: string[],
  envOverride?: DoctorEnv,
  outOverride?: (line: string) => void,
): Promise<number> => {
  const env = envOverride ?? defaultDoctorEnv();
  const out = outOverride ?? ((line: string) => console.log(line));
  const useColour = !envOverride && Boolean((process.stdout as { isTTY?: boolean }).isTTY);
  const checks = await collectChecks(env);
  const readiness = computeReadiness(checks);
  for (const line of renderReport(checks, readiness, useColour)) out(line);
  const anyFail = checks.some((c) => c.verdict === "fail") || readiness.check.verdict === "fail";
  return anyFail ? 1 : 0;
};

if (import.meta.main) {
  void runDoctor(process.argv.slice(2)).then((code) => process.exit(code));
}
