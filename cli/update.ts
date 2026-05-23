// `acc update` — safe self-update path: source, schema, daemon, health, rollback.
import { existsSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { openDb, closeDb } from "../substrate/db";
import { inspectPendingMigrations, runVersionedMigrations } from "../substrate/migration_runner";
import { resolveDbPath } from "../runtime/state_paths";
import { auxBaseUrl, readAdminToken, rpcGet, rpcPostAuth } from "./rpc";
import { collectChecks, computeReadiness, defaultDoctorEnv, renderReport } from "./doctor";
export type UpdateEnv = { out:(line:string)=>void; err:(line:string)=>void; spawnSync:typeof spawnSync; startDaemon:()=>Promise<void>; stopDaemon:()=>Promise<boolean>; healthOk:()=>Promise<boolean>; snapshot:()=>Promise<string[]>; dbPath:string; };
const run = (env: UpdateEnv, cmd: string, args: string[]) => { const r = env.spawnSync(cmd, args, { encoding: "utf8" }); return { ok: r.status === 0, text: String((r.stdout ?? "") + (r.stderr ?? "")).trim() }; };
const gitHead = (env: UpdateEnv): string | null => { const r = run(env, "git", ["rev-parse", "HEAD"]); return r.ok ? r.text.split(/\r?\n/)[0]!.trim() : null; };
const realStopDaemon = async (): Promise<boolean> => { const base = auxBaseUrl(); const token = readAdminToken(); if (!base || !token) return false; try { const reply = await rpcPostAuth<{ ok?: boolean }>(base + "/shutdown", token, {}); await new Promise((r) => setTimeout(r, 500)); return Boolean(reply.ok); } catch { return false; } };
const realStartDaemon = async (): Promise<void> => { if (auxBaseUrl()) return; const entry = resolve(import.meta.dirname ?? ".", "..", "runtime", "daemon.ts"); const child = spawn("bun", [entry], { detached: true, stdio: "ignore", env: { ...process.env } }); child.unref(); };
const realHealthOk = async (): Promise<boolean> => { const base = auxBaseUrl(); if (!base) return false; try { const health = await rpcGet<{ status?: string }>(base + "/health"); return health.status === "ok"; } catch { return false; } };
const realSnapshot = async (): Promise<string[]> => { const pre = await collectChecks(defaultDoctorEnv()); return renderReport(pre, computeReadiness(pre), false); };
export const defaultUpdateEnv = (): UpdateEnv => ({ out:(line)=>console.log(line), err:(line)=>console.error(line), spawnSync, startDaemon: realStartDaemon, stopDaemon: realStopDaemon, healthOk: realHealthOk, snapshot: realSnapshot, dbPath: resolveDbPath() });
const usage = () => "acc update — safe self-update\n\nUsage: acc update [--yes] [--no-pull]";
export const runUpdate = async (argv: string[], env: UpdateEnv = defaultUpdateEnv()): Promise<number> => {
  if (argv.includes("--help") || argv.includes("-h")) { env.out(usage()); return 0; }
  if (!(argv.includes("--yes") || argv.includes("-y"))) { env.err("acc update mutates source/schema/daemon; rerun with --yes to proceed"); return 1; }
  env.out("pre-update health snapshot:"); for (const line of await env.snapshot()) env.out("  " + line);
  const before = gitHead(env); if (!before) { env.err("cannot read current git HEAD; refusing update"); return 1; } env.out("source before: " + before);
  if (!argv.includes("--no-pull")) { const pull = run(env, "git", ["pull", "--ff-only"]); if (!pull.ok) { env.err("git pull --ff-only failed: " + pull.text); return 1; } env.out(pull.text || "source already current"); }
  env.out("source after:  " + (gitHead(env) ?? before));
  if (existsSync(env.dbPath)) { const db = openDb(env.dbPath); try { const pending = inspectPendingMigrations(db); env.out("pending migrations: " + (pending.pending_versions.length ? pending.pending_versions.join(", ") : "none")); const applied = runVersionedMigrations(db); if (applied.failed) { env.err("migration failed: " + applied.errors.join("; ")); return 1; } if (applied.applied) env.out("migrations applied: " + applied.versions_applied.join(", ")); } finally { closeDb(env.dbPath); } }
  const wasRunning = await env.stopDaemon(); if (wasRunning) env.out("daemon drained and stopped"); await env.startDaemon(); await new Promise((r) => setTimeout(r, 1000)); if (await env.healthOk()) { env.out("post-update health: ok"); return 0; }
  env.err("post-update health failed; rolling source back"); const rb = run(env, "git", ["reset", "--hard", before]); if (!rb.ok) { env.err("rollback failed: " + rb.text); return 1; } await env.stopDaemon(); await env.startDaemon(); env.err("rollback complete; inspect with acc doctor"); return 1;
};
if (import.meta.main) void runUpdate(process.argv.slice(2)).then((code) => process.exit(code));
