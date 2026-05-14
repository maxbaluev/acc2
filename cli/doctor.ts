// `acc doctor` — diagnostics for the v2 daemon. Exits 0 if all checks green,
// 1 if any check is red. Yellow warnings (e.g. missing OPENAI_API_KEY for
// embeddings) do not fail.

import { statfsSync } from "node:fs";
import { resolve } from "node:path";
import { auxBaseUrl, readDaemonLock, rpcGet } from "./rpc";

type Verdict = "green" | "yellow" | "red";
type Check = { name: string; verdict: Verdict; detail: string };

const RED = "\x1b[31m"; const YEL = "\x1b[33m"; const GRN = "\x1b[32m"; const RST = "\x1b[0m";
const colour = (v: Verdict): string =>
  v === "green" ? GRN + "OK " + RST : v === "yellow" ? YEL + "WARN" + RST : RED + "FAIL" + RST;

const checkDaemonHealth = async (): Promise<Check> => {
  const base = auxBaseUrl();
  if (!base) return { name: "daemon", verdict: "red", detail: "not running (no socket lock found)" };
  try {
    const h = await rpcGet<Record<string, unknown>>(`${base}/health`);
    if ((h as { status?: string }).status === "ok") {
      const lock = readDaemonLock();
      return {
        name: "daemon", verdict: "green",
        detail: `pid=${lock?.pid ?? "?"} mcp=${lock?.port ?? "?"} aux=${lock?.aux_port ?? "?"} ` +
          `uptime_ms=${(h as { uptime_ms?: number }).uptime_ms ?? 0}`,
      };
    }
    return { name: "daemon", verdict: "red", detail: `health endpoint returned ${JSON.stringify(h).slice(0, 120)}` };
  } catch (err) {
    return { name: "daemon", verdict: "red", detail: `health check failed: ${(err as Error).message}` };
  }
};

const checkDbIntegrity = async (): Promise<Check> => {
  const base = auxBaseUrl();
  if (!base) return { name: "db_integrity", verdict: "yellow", detail: "daemon not running — cannot check" };
  try {
    const h = await rpcGet<Record<string, unknown>>(`${base}/health`);
    const n = (h as { events_count?: number }).events_count ?? 0;
    return { name: "db_integrity", verdict: "green", detail: `events_count=${n} (PRAGMA integrity_check delegated to daemon boot)` };
  } catch (err) {
    return { name: "db_integrity", verdict: "red", detail: `probe failed: ${(err as Error).message}` };
  }
};

const checkDiskFree = (): Check => {
  const stateDir = resolve(import.meta.dirname ?? ".", "..", "state");
  try {
    const s = statfsSync(stateDir);
    const freeBytes = Number(s.bavail) * Number(s.bsize);
    const freeGb = freeBytes / 1e9;
    if (freeGb >= 1.0) return { name: "disk_free", verdict: "green", detail: `${freeGb.toFixed(2)} GB free at ${stateDir}` };
    return { name: "disk_free", verdict: "red", detail: `${freeGb.toFixed(2)} GB free at ${stateDir} (need ≥ 1 GB)` };
  } catch (err) {
    return { name: "disk_free", verdict: "yellow", detail: `statfs failed on ${stateDir}: ${(err as Error).message}` };
  }
};

const checkOpenAiKey = (): Check => {
  if (process.env.OPENAI_API_KEY) {
    return { name: "openai_api_key", verdict: "green", detail: "present (used by embedder in Phase F)" };
  }
  return { name: "openai_api_key", verdict: "yellow", detail: "missing — Phase F embeddings disabled until set in .env" };
};

const summarise = (checks: Check[]): number => {
  let width = 0;
  for (const c of checks) width = Math.max(width, c.name.length);
  console.log("acc doctor — v2 diagnostics"); console.log("");
  let red = 0;
  for (const c of checks) {
    if (c.verdict === "red") red++;
    console.log(`  ${colour(c.verdict)}  ${c.name.padEnd(width)}  ${c.detail}`);
  }
  console.log("");
  console.log(red === 0 ? "result: all checks green" : `result: ${red} failing check(s)`);
  return red === 0 ? 0 : 1;
};

export const runDoctor = async (_argv: string[]): Promise<number> => {
  const checks: Check[] = [];
  checks.push(await checkDaemonHealth());
  checks.push(await checkDbIntegrity());
  checks.push(checkDiskFree());
  checks.push(checkOpenAiKey());
  return summarise(checks);
};

if (import.meta.main) {
  void runDoctor(process.argv.slice(2)).then((code) => process.exit(code));
}
