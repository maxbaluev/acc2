// `acc admin <sub>` — operator-side maintenance namespace.
//
// Status / updates (Batch 2.γ):
//   acc admin opencode-version          Print current + latest opencode version.
//   acc admin update-opencode [--yes]   Upgrade opencode to the latest version.
//   acc admin upgrade-check             Check if any subsystem has an update available.
//
// Backup / restore (Batch 3.ADMIN):
//   acc admin export <path> [--cold] [--include-logs]
//   acc admin import <path> [--force]
//
// Secrets (Batch 3.ADMIN):
//   acc admin rotate-admin-token
//   acc admin rotate-external-token <source>
//
// Audit (Batch 3.ADMIN):
//   acc admin inspect-knowledge [--promoted-only] [--origin X] [--limit N] [--since <iso>]
//   acc admin override-quarantine <artifact_id> [--reason "..."]
//   acc admin archive-rolling <directive_id>
//
// The daemon is stopped before an opencode upgrade (if running) and
// restarted after, because opencode is the brain subprocess and upgrading
// a live binary while the daemon may dispatch through it is unsafe.

import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, join } from "node:path";
import { createInterface } from "node:readline";
import { Database } from "bun:sqlite";
import { openDb } from "../substrate/db";
import { runViews, promotedKnowledge, type PromotedKnowledgeFilter } from "../substrate/views";
import {
  checkLatestOpencodeVersion,
  compareSemver,
  defaultVersionEnv,
  detectOpencodeVersion,
  updateOpencode,
  type VersionEnv,
} from "../runtime/opencode_version";
import { emitEvent } from "../runtime/events";
import { getArtifact } from "../runtime/artifact_store";
import {
  auxBaseUrl, readAdminToken, readDaemonLock,
  rpcPostAuth,
} from "./rpc";
import { runExport, type ExportMode } from "./admin_export";
import { runImport } from "./admin_import";
import { rotateAdminToken, rotateExternalToken } from "./admin_rotate";

const usage = (): string => `acc admin — operator-side maintenance

  Status:
    opencode-version          Print current + latest opencode version.
    upgrade-check             Show which subsystems have an update available.

  Updates:
    update-opencode [--yes]   Upgrade opencode to the latest version.

  Backup:
    export <path> [--cold] [--include-logs]
                              Snapshot the substrate state dir into a tar.gz.
    import <path> [--force]   Restore from an archive produced by export.

  Secrets:
    rotate-admin-token        Mint a fresh admin token (write 0600 to token file).
    rotate-external-token <source>
                              Rotate an external-source bearer token.

  Audit:
    inspect-knowledge [--promoted-only] [--origin X] [--limit N] [--since <iso>]
                              List promoted knowledge with rich filtering.
    override-quarantine <artifact_id> [--reason "..."]
                              Manually rehabilitate a quarantined artifact.
    archive-rolling <directive_id>
                              Manually archive a rolling-active directive.
`;

// ── Shared helpers for Batch 3.ADMIN surfaces ───────────────────────

const defaultStateDbPath = (): string => {
  const home = process.env.ACCINT_HOME ?? join(homedir(), ".accint");
  return join(home, "state", "accint.db");
};

const defaultAdminTokenFile = (): string => {
  const home = process.env.ACCINT_HOME ?? join(homedir(), ".accint");
  return join(home, "state", "v2.sock.token");
};

/** Walk argv for a flag value (`--name value`).  Returns undefined when
 *  the flag is absent or trails the array. */
const flagValue = (argv: string[], name: string): string | undefined => {
  const i = argv.indexOf(name);
  if (i < 0 || i + 1 >= argv.length) return undefined;
  const v = argv[i + 1]!;
  return v.startsWith("--") ? undefined : v;
};
const hasFlag = (argv: string[], name: string): boolean => argv.includes(name);

// ── Shared types ─────────────────────────────────────────────────────

export type AdminEnv = {
  version: VersionEnv;
  /** Stop the daemon if it is running. Returns true if the daemon was
   *  running (so the caller knows to restart it after the upgrade). */
  stopDaemon: () => Promise<boolean>;
  /** Detached respawn of the daemon. */
  startDaemon: () => Promise<void>;
  /** Read line from stdin for interactive prompts (--yes bypasses). */
  prompt: (q: string) => Promise<string>;
  out: (line: string) => void;
  err: (line: string) => void;
  /** Used by `update-opencode --yes` to override the prompt path. */
  yes: boolean;
  // ── Batch 3.ADMIN injection points (optional — defaults below) ──
  /** Open or reuse a DB handle.  Tests inject an in-memory DB; the
   *  default opens the on-disk state DB. */
  openSubstrate?: (path?: string) => Database;
  /** Path of the on-disk DB; used by export/import/rotate when no
   *  override is in play. */
  stateDbPath?: string;
  /** Path of the on-disk admin token file (rotation surface). */
  adminTokenFile?: string;
  /** Source-of-truth aux base url; rotation/import check it to refuse
   *  destructive ops while the daemon is up.  Default reads the lock
   *  file via `auxBaseUrl()` (real-world behavior). */
  auxBaseUrlProbe?: () => string | null;
  /** Current schema version the binary expects (import refuses on mismatch). */
  currentSchemaVersion?: string;
};

// Real daemon-control implementations.

const realStopDaemon = async (): Promise<boolean> => {
  const base = auxBaseUrl();
  if (!base) return false;
  const token = readAdminToken();
  if (!token) return false;
  try {
    const reply = await rpcPostAuth<{ ok?: boolean }>(`${base}/shutdown`, token, {});
    return Boolean(reply.ok);
  } catch {
    return false;
  }
};

const realStartDaemon = async (): Promise<void> => {
  if (auxBaseUrl()) return; // already running
  const entry = resolve(import.meta.dirname ?? ".", "..", "runtime", "daemon.ts");
  const child = spawn("bun", [entry], { detached: true, stdio: "ignore", env: { ...process.env } });
  child.unref();
};

const realPrompt = async (q: string): Promise<string> => {
  return new Promise((resolveLine) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(q, (answer) => { rl.close(); resolveLine(answer); });
  });
};

const defaultAdminEnv = (yes: boolean): AdminEnv => ({
  version: defaultVersionEnv(),
  stopDaemon: realStopDaemon,
  startDaemon: realStartDaemon,
  prompt: realPrompt,
  out: (line) => console.log(line),
  err: (line) => console.error(line),
  yes,
  openSubstrate: (path?: string) => openDb(path ?? defaultStateDbPath()),
  stateDbPath: defaultStateDbPath(),
  adminTokenFile: defaultAdminTokenFile(),
  auxBaseUrlProbe: () => auxBaseUrl(),
  currentSchemaVersion: "0",
});

// ── opencode-version ─────────────────────────────────────────────────

export const runOpencodeVersion = async (env: AdminEnv): Promise<number> => {
  const current = await detectOpencodeVersion(env.version);
  if (!current.binaryExists) {
    env.err(`opencode not installed (not on PATH)`);
    env.err(`install: https://github.com/sst/opencode`);
    return 1;
  }
  env.out(`current: ${current.version} (${current.installMethod}) at ${current.installPath}`);
  const latest = await checkLatestOpencodeVersion(env.version);
  if (!latest) {
    env.out(`latest:  unknown (could not reach api.github.com — set GITHUB_TOKEN if rate-limited)`);
    return 0;
  }
  env.out(`latest:  ${latest.version} (released ${latest.releasedAt || "?"})`);
  const cmp = compareSemver(current.version, latest.version);
  if (cmp < 0) {
    env.out(`status:  upgrade available (run \`acc admin update-opencode\`)`);
  } else if (cmp === 0) {
    env.out(`status:  up to date`);
  } else {
    env.out(`status:  ahead of latest (dev build?)`);
  }
  return 0;
};

// ── update-opencode ──────────────────────────────────────────────────

export const runUpdateOpencode = async (env: AdminEnv): Promise<number> => {
  const current = await detectOpencodeVersion(env.version);
  if (!current.binaryExists) {
    env.err(`opencode not installed; nothing to upgrade. Install from https://github.com/sst/opencode`);
    return 1;
  }
  const latest = await checkLatestOpencodeVersion(env.version);
  if (!latest) {
    env.err(`could not check latest opencode version (network or GitHub rate-limit)`);
    return 1;
  }
  const cmp = compareSemver(current.version, latest.version);
  if (cmp >= 0) {
    env.out(`opencode ${current.version} is already current (latest = ${latest.version}); nothing to do`);
    return 0;
  }
  // Prompt unless --yes.
  if (!env.yes) {
    const answer = (await env.prompt(`Upgrade opencode from ${current.version} to ${latest.version}? [Y/n] `)).trim().toLowerCase();
    if (answer === "n" || answer === "no") {
      env.out(`upgrade cancelled`);
      return 0;
    }
  }
  // Stop daemon first if running.
  const wasRunning = await env.stopDaemon();
  if (wasRunning) {
    env.out(`daemon stopped before upgrade; will restart after`);
    // Brief settle window so the socket file is released.
    await new Promise((r) => setTimeout(r, 500));
  }
  // Open the substrate DB so events land even when the daemon is down.
  const stateDb = process.env.ACC2_STATE_DB
    ?? resolve(import.meta.dirname ?? ".", "..", "state", "accint.db");
  const db = existsSync(stateDb) ? openDb(stateDb) : undefined;
  env.out(`upgrading opencode (${current.installMethod})…`);
  const result = await updateOpencode({ env: env.version, db });
  if (wasRunning) await env.startDaemon();
  if (!result.ok) {
    env.err(`upgrade failed: ${result.reason}`);
    env.err(result.detail.split("\n").slice(0, 6).join("\n"));
    return 1;
  }
  env.out(`opencode upgraded: ${result.from} → ${result.to} (${result.durationMs}ms)`);
  if (wasRunning) env.out(`daemon restart requested; poll with \`acc daemon status\``);
  return 0;
};

// ── upgrade-check ────────────────────────────────────────────────────

type SubsystemStatus = {
  name: string;
  installed: string;
  latest?: string;
  updateAvailable: boolean;
  detail: string;
};

export const runUpgradeCheck = async (env: AdminEnv): Promise<number> => {
  const reports: SubsystemStatus[] = [];

  // opencode
  const current = await detectOpencodeVersion(env.version);
  if (current.binaryExists) {
    const latest = await checkLatestOpencodeVersion(env.version);
    const updateAvailable = latest != null && compareSemver(current.version, latest.version) < 0;
    reports.push({
      name: "opencode",
      installed: current.version,
      latest: latest?.version,
      updateAvailable,
      detail: updateAvailable
        ? `upgrade via \`acc admin update-opencode\``
        : (latest ? "up to date" : "could not check"),
    });
  } else {
    reports.push({
      name: "opencode",
      installed: "missing",
      updateAvailable: false,
      detail: "install from https://github.com/sst/opencode",
    });
  }

  // bun
  const bun = env.version.spawn("bun", ["--version"]);
  if (bun.status === 0) {
    const v = (bun.stdout || "").split("\n")[0]!.trim();
    reports.push({
      name: "bun",
      installed: v,
      updateAvailable: false,
      detail: "upgrade with `bun upgrade`",
    });
  } else {
    reports.push({ name: "bun", installed: "missing", updateAvailable: false, detail: "install from https://bun.sh" });
  }

  // uv
  const uvProbe = env.version.spawn("uv", ["--version"]);
  if (uvProbe.status === 0) {
    const v = (uvProbe.stdout || "").split("\n")[0]!.trim();
    reports.push({
      name: "uv",
      installed: v,
      updateAvailable: false,
      detail: "upgrade with `uv self update`",
    });
  } else {
    reports.push({ name: "uv", installed: "missing", updateAvailable: false, detail: "optional; install from https://github.com/astral-sh/uv" });
  }

  // camoufox — binary check only (versions are bundled with the binary).
  const explicit = process.env.CAMOUFOX_BINARY_PATH;
  const cached = join(homedir(), ".cache", "camoufox", "camoufox");
  const camoPath = explicit && existsSync(explicit) ? explicit : (existsSync(cached) ? cached : null);
  if (camoPath) {
    reports.push({
      name: "camoufox",
      installed: "present",
      updateAvailable: false,
      detail: `at ${camoPath}; refresh with \`python -m camoufox fetch\``,
    });
  } else {
    reports.push({
      name: "camoufox",
      installed: "missing",
      updateAvailable: false,
      detail: "optional; download from https://github.com/daijro/camoufox/releases",
    });
  }

  // Render table.
  env.out(`acc admin upgrade-check — subsystem versions`);
  env.out(`─────────────────────────────────────────────`);
  const nameW = Math.max(...reports.map((r) => r.name.length));
  const installedW = Math.max(...reports.map((r) => r.installed.length));
  for (const r of reports) {
    const flag = r.updateAvailable ? "[UPGRADE]" : "[ok    ]";
    const latest = r.latest ? ` → ${r.latest}` : "";
    env.out(`${flag} ${r.name.padEnd(nameW)}  ${r.installed.padEnd(installedW)}${latest}  ${r.detail}`);
  }
  env.out(`─────────────────────────────────────────────`);
  const anyAvailable = reports.some((r) => r.updateAvailable);
  if (anyAvailable) {
    env.out(`updates available; run the listed command(s)`);
    return 0;
  }
  env.out(`all subsystems current`);
  return 0;
};

// ── export / import (Batch 3.ADMIN) ──────────────────────────────────

export const runExportCmd = async (argv: string[], env: AdminEnv): Promise<number> => {
  const archivePath = argv[0];
  if (!archivePath || archivePath.startsWith("--")) {
    env.err("acc admin export: missing <path>");
    env.err("usage: acc admin export <path> [--cold] [--include-logs]");
    return 1;
  }
  const mode: ExportMode = hasFlag(argv, "--cold") ? "cold" : "live";
  // LIVE export with daemon down is fine (it just means VACUUM INTO on a
  // quiet file); COLD export with daemon up is a footgun — refuse.
  if (mode === "cold" && (env.auxBaseUrlProbe?.() ?? null) !== null) {
    env.err("acc admin export --cold: daemon is running. Stop it first or drop --cold.");
    return 1;
  }
  const includeLogs = hasFlag(argv, "--include-logs");
  const result = await runExport({
    archivePath,
    mode,
    includeLogs,
    stateDir: env.stateDbPath ? resolveStateDir(env.stateDbPath) : undefined,
  });
  if (!result.ok) {
    env.err(`acc admin export failed: ${result.errors.join("; ")}`);
    return 1;
  }
  env.out(`export complete: ${result.archivePath}`);
  env.out(`  sha256: ${result.sha256}`);
  env.out(`  events: ${result.eventCount}`);
  env.out(`  schema: ${result.schemaVersion}`);
  env.out(`  mode:   ${result.mode}`);
  if (result.errors.length > 0) {
    for (const e of result.errors) env.err(`  warn: ${e}`);
  }
  return 0;
};

const resolveStateDir = (dbPath: string): string => {
  // The DB is always `<stateDir>/accint.db`.
  return dbPath.endsWith("accint.db") ? dbPath.slice(0, -("accint.db".length + 1)) : dbPath;
};

export const runImportCmd = async (argv: string[], env: AdminEnv): Promise<number> => {
  const archivePath = argv[0];
  if (!archivePath || archivePath.startsWith("--")) {
    env.err("acc admin import: missing <path>");
    env.err("usage: acc admin import <path> [--force]");
    return 1;
  }
  const force = hasFlag(argv, "--force");
  const result = await runImport({
    archivePath,
    stateDir: env.stateDbPath ? resolveStateDir(env.stateDbPath) : undefined,
    force,
    auxBaseUrlProbe: env.auxBaseUrlProbe,
    currentSchemaVersion: env.currentSchemaVersion ?? "0",
  });
  if (!result.ok) {
    env.err(`acc admin import failed: ${result.errors.join("; ")}`);
    return 1;
  }
  env.out(`import complete from: ${argv[0]}`);
  env.out(`  archive sha256:    ${result.archiveSha256}`);
  env.out(`  restored events:   ${result.restoredEventCount}`);
  env.out(`  schema:            ${result.schemaVersion}`);
  env.out(`  integrity_check:   ${result.integrityOk ? "ok" : "failed"}`);
  return 0;
};

// ── rotate-admin-token ───────────────────────────────────────────────

export const runRotateAdminTokenCmd = async (
  _argv: string[],
  env: AdminEnv,
): Promise<number> => {
  const tokenFile = env.adminTokenFile ?? defaultAdminTokenFile();
  let db: Database;
  try { db = (env.openSubstrate ?? openDb)(env.stateDbPath ?? defaultStateDbPath()); }
  catch (err) {
    env.err(`acc admin rotate-admin-token: failed to open substrate: ${(err as Error).message}`);
    return 1;
  }
  const r = rotateAdminToken({ tokenFile, db });
  if (!r.ok) {
    env.err(`acc admin rotate-admin-token failed: ${r.errors.join("; ")}`);
    return 1;
  }
  env.out(`admin token rotated.  preview: ${r.newTokenPreview}`);
  env.out(`written to:           ${r.tokenFile}`);
  env.out(r.reminder);
  return 0;
};

// ── rotate-external-token ────────────────────────────────────────────

export const runRotateExternalTokenCmd = async (
  argv: string[],
  env: AdminEnv,
): Promise<number> => {
  const source = argv[0];
  if (!source || source.startsWith("--")) {
    env.err("acc admin rotate-external-token: missing <source>");
    env.err("usage: acc admin rotate-external-token <source>");
    return 1;
  }
  let db: Database;
  try { db = (env.openSubstrate ?? openDb)(env.stateDbPath ?? defaultStateDbPath()); }
  catch (err) {
    env.err(`acc admin rotate-external-token: failed to open substrate: ${(err as Error).message}`);
    return 1;
  }
  const r = rotateExternalToken({ db, source });
  if (!r.ok) {
    env.err(`acc admin rotate-external-token failed: ${r.errors.join("; ")}`);
    return 1;
  }
  env.out(`external token rotated for source='${r.source}'`);
  env.out(`  preview: ${r.newTokenPreview}`);
  env.out(`  raw (copy now, printed ONCE): ${r.rawToken}`);
  env.out(r.reminder);
  return 0;
};

// ── inspect-knowledge ────────────────────────────────────────────────

export const runInspectKnowledgeCmd = async (
  argv: string[],
  env: AdminEnv,
): Promise<number> => {
  const promotedOnly = hasFlag(argv, "--promoted-only");
  const origin = flagValue(argv, "--origin");
  const limitRaw = flagValue(argv, "--limit");
  const since = flagValue(argv, "--since");
  const limit = limitRaw ? Math.max(1, Math.floor(Number(limitRaw))) : 50;

  let db: Database;
  try { db = (env.openSubstrate ?? openDb)(env.stateDbPath ?? defaultStateDbPath()); }
  catch (err) {
    env.err(`acc admin inspect-knowledge: failed to open substrate: ${(err as Error).message}`);
    return 1;
  }
  try { runViews(db); } catch { /* idempotent — proceed anyway */ }

  const filter: PromotedKnowledgeFilter = {
    origin,
    since,
    limit: Number.isFinite(limit) ? limit : 50,
  };
  // `--promoted-only` is the default semantic of the view (it ONLY surfaces
  // promoted rows).  The flag exists for symmetry with future modes that
  // might surface candidates too; for now it is a no-op acknowledgment.
  void promotedOnly;

  const rows = promotedKnowledge(db, filter);
  if (rows.length === 0) {
    env.out("acc admin inspect-knowledge: no rows match the filter");
    return 0;
  }
  env.out(`acc admin inspect-knowledge — ${rows.length} row${rows.length === 1 ? "" : "s"}`);
  env.out("─".repeat(72));
  for (const r of rows) {
    const text = (r.text ?? "(candidate pruned)").replace(/\s+/g, " ").slice(0, 140);
    const cites = r.context_refs.length > 0 ? r.context_refs.slice(0, 3).join(",") : "(none)";
    env.out(
      `${r.event_id}  score=${r.score.toFixed(3)} conf=${r.confidence.toFixed(3)} ` +
        `origin=${r.substrate_origin} ts=${r.ts}`,
    );
    env.out(`  cite: ${cites}`);
    env.out(`  text: ${text}`);
  }
  return 0;
};

// ── override-quarantine ──────────────────────────────────────────────

export const runOverrideQuarantineCmd = async (
  argv: string[],
  env: AdminEnv,
): Promise<number> => {
  const artifactId = argv[0];
  if (!artifactId || artifactId.startsWith("--")) {
    env.err("acc admin override-quarantine: missing <artifact_id>");
    env.err("usage: acc admin override-quarantine <artifact_id> [--reason \"...\"]");
    return 1;
  }
  const reason = flagValue(argv, "--reason") ?? "operator_override";

  let db: Database;
  try { db = (env.openSubstrate ?? openDb)(env.stateDbPath ?? defaultStateDbPath()); }
  catch (err) {
    env.err(`acc admin override-quarantine: failed to open substrate: ${(err as Error).message}`);
    return 1;
  }
  const row = getArtifact(db, artifactId);
  if (!row) {
    env.err(`acc admin override-quarantine: artifact not found: ${artifactId}`);
    return 1;
  }
  if (row.status === "admitted" || row.status === "promoted") {
    env.out(`artifact ${artifactId} is already ${row.status}; nothing to do`);
    return 0;
  }
  if (row.status !== "quarantined") {
    env.err(`acc admin override-quarantine: unexpected status: ${row.status}`);
    return 1;
  }
  const ts = new Date().toISOString();
  db.run(
    "UPDATE code_artifact SET status = 'admitted', updated_at = ? WHERE id = ?",
    [ts, artifactId],
  );
  emitEvent(db, {
    kind: "code_artifact_quarantine_overridden",
    substrate_origin: "owner",
    action_artifact_id: artifactId,
    payload: {
      artifact_id: artifactId,
      previous_status: "quarantined",
      new_status: "admitted",
      reason,
    },
  });
  env.out(`artifact ${artifactId}: quarantined → admitted (reason=${reason})`);
  return 0;
};

// ── archive-rolling ──────────────────────────────────────────────────

type DirectivePayload = Record<string, unknown> & { lifecycle?: unknown };

const latestDirectivePayload = (
  db: Database, directiveId: string,
): { payload: DirectivePayload; ts: string } | null => {
  const row = db
    .query(
      `SELECT ts, payload FROM events
       WHERE directive_id = ? AND kind IN ('directive_opened', 'directive_amended')
       ORDER BY ts DESC LIMIT 1`,
    )
    .get(directiveId) as { ts: string; payload: string } | null;
  if (!row) return null;
  try { return { payload: JSON.parse(row.payload ?? "{}") as DirectivePayload, ts: row.ts }; }
  catch { return null; }
};

const liftLifecycleKind = (payload: DirectivePayload): string | null => {
  const direct = payload.lifecycle;
  if (typeof direct === "string") return direct;
  if (direct && typeof direct === "object") {
    const k = (direct as Record<string, unknown>).kind;
    if (typeof k === "string") return k;
  }
  return null;
};

const alreadyArchived = (db: Database, directiveId: string): boolean => {
  const row = db
    .query(
      `SELECT id FROM events
       WHERE directive_id = ?
         AND kind IN ('directive_archived_missed_reviews', 'directive_archived_by_operator')
       LIMIT 1`,
    )
    .get(directiveId) as { id: string } | null;
  return row !== null;
};

export const runArchiveRollingCmd = async (
  argv: string[],
  env: AdminEnv,
): Promise<number> => {
  const directiveId = argv[0];
  if (!directiveId || directiveId.startsWith("--")) {
    env.err("acc admin archive-rolling: missing <directive_id>");
    env.err("usage: acc admin archive-rolling <directive_id>");
    return 1;
  }
  let db: Database;
  try { db = (env.openSubstrate ?? openDb)(env.stateDbPath ?? defaultStateDbPath()); }
  catch (err) {
    env.err(`acc admin archive-rolling: failed to open substrate: ${(err as Error).message}`);
    return 1;
  }
  const latest = latestDirectivePayload(db, directiveId);
  if (!latest) {
    env.err(`acc admin archive-rolling: directive not found: ${directiveId}`);
    return 1;
  }
  const lifecycleKind = liftLifecycleKind(latest.payload);
  if (lifecycleKind !== "rolling_active") {
    env.err(`acc admin archive-rolling: directive lifecycle is '${lifecycleKind ?? "(unknown)"}', not 'rolling_active'`);
    return 1;
  }
  if (alreadyArchived(db, directiveId)) {
    env.out(`directive ${directiveId} already archived; nothing to do`);
    return 0;
  }
  // 1. Emit the canonical archive event.
  emitEvent(db, {
    kind: "directive_archived_by_operator",
    substrate_origin: "owner",
    directive_id: directiveId,
    payload: {
      directive_id: directiveId,
      reason: "operator_archive",
      previous_lifecycle: lifecycleKind,
    },
  });
  // 2. Amend the directive lifecycle to 'committed' so the rolling reviewer
  //    stops emitting reviews for it.  The amendment carries reason=operator_archive
  //    so the lineage is auditable.
  const amendedPayload = { ...latest.payload, lifecycle: "committed" };
  emitEvent(db, {
    kind: "directive_amended",
    substrate_origin: "owner",
    directive_id: directiveId,
    payload: { ...amendedPayload, reason: "operator_archive" },
  });
  env.out(`directive ${directiveId}: rolling_active → committed (operator archive)`);
  return 0;
};

// ── Programmatic entry ───────────────────────────────────────────────

export const runAdmin = async (argv: string[], envOverride?: AdminEnv): Promise<number> => {
  const sub = argv[0];
  const flags = new Set(argv.slice(1));
  const yes = flags.has("--yes") || flags.has("-y");
  const env = envOverride ?? defaultAdminEnv(yes);
  if (envOverride && yes) env.yes = true; // honour --yes even with injected env

  if (!sub || sub === "help" || sub === "--help" || sub === "-h") {
    env.out(usage());
    return 0;
  }
  if (sub === "opencode-version") return runOpencodeVersion(env);
  if (sub === "update-opencode") return runUpdateOpencode(env);
  if (sub === "upgrade-check") return runUpgradeCheck(env);
  // Batch 3.ADMIN surfaces.
  if (sub === "export") return runExportCmd(argv.slice(1), env);
  if (sub === "import") return runImportCmd(argv.slice(1), env);
  if (sub === "rotate-admin-token") return runRotateAdminTokenCmd(argv.slice(1), env);
  if (sub === "rotate-external-token") return runRotateExternalTokenCmd(argv.slice(1), env);
  if (sub === "inspect-knowledge") return runInspectKnowledgeCmd(argv.slice(1), env);
  if (sub === "override-quarantine") return runOverrideQuarantineCmd(argv.slice(1), env);
  if (sub === "archive-rolling") return runArchiveRollingCmd(argv.slice(1), env);
  env.err(`acc admin: unknown subcommand '${sub}'`);
  env.err(usage());
  return 1;
};

if (import.meta.main) {
  void runAdmin(process.argv.slice(2)).then((code) => process.exit(code));
}

// Mark the realDaemonLock import as referenced (used in some test paths).
void readDaemonLock;
void spawnSync;
