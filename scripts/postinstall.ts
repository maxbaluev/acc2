#!/usr/bin/env bun
// acc2 postinstall — auto-fetch playwright chromium + camoufox so the system is
// end-to-end runnable after `bun install`. Idempotent. Best-effort: each step
// degrades cleanly if its binary already exists or its install path fails, so
// `bun install` never hard-aborts on a transient network blip.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const log = (msg: string) => console.log(`[acc2 postinstall] ${msg}`);

async function spawn(cmd: string[], opts: { allowFail?: boolean } = {}): Promise<{ ok: boolean; exitCode: number }> {
  log(`exec: ${cmd.join(" ")}`);
  const proc = Bun.spawn(cmd, { stdout: "inherit", stderr: "inherit" });
  const code = await proc.exited;
  if (code !== 0 && !opts.allowFail) {
    log(`failed (exit ${code}); continuing with degraded setup`);
  }
  return { ok: code === 0, exitCode: code };
}

async function installPlaywrightChromium(): Promise<void> {
  // playwright caches in ~/.cache/ms-playwright/ ; check before re-running.
  const cacheDir = join(homedir(), ".cache", "ms-playwright");
  if (existsSync(cacheDir)) {
    log("playwright chromium cache exists → skipping fetch (run `bun run browser:fetch` to force)");
    return;
  }
  log("fetching playwright chromium (one-time, ~150 MB)...");
  await spawn(["bunx", "playwright", "install", "chromium"], { allowFail: true });
}

async function installCamoufox(): Promise<void> {
  const camoufoxBin = process.env.CAMOUFOX_BINARY_PATH ?? join(homedir(), ".cache", "camoufox", "camoufox");
  if (existsSync(camoufoxBin)) {
    log(`camoufox binary already present at ${camoufoxBin} → skipping fetch`);
    return;
  }
  // Camoufox ships a Python launcher; we shell out to `python -m camoufox fetch`.
  // Requires either pip-installed camoufox OR uvx. Detect + try in order.
  log("fetching camoufox firefox binary (one-time, ~120 MB)...");

  // Try uvx (Astral's pip-runtime) first — works without a persistent pip install.
  const uvxOk = (await spawn(["uvx", "--from", "camoufox", "python", "-m", "camoufox", "fetch"], { allowFail: true })).ok;
  if (uvxOk) return;

  // Fall back to system python -m camoufox (expects user installed it themselves).
  const pyOk = (await spawn(["python", "-m", "camoufox", "fetch"], { allowFail: true })).ok;
  if (pyOk) return;

  log("camoufox fetch failed via uvx + python; operator can run manually:");
  log("  pip install camoufox && python -m camoufox fetch");
  log("OR set CAMOUFOX_BINARY_PATH if you already have the binary elsewhere.");
}

async function main() {
  if (process.env.ACC2_SKIP_POSTINSTALL === "1") {
    log("ACC2_SKIP_POSTINSTALL=1 set → skipping browser fetches");
    return;
  }
  if (process.env.CI === "true" || process.env.NODE_ENV === "test") {
    log("CI / test env detected → skipping browser fetches (run `bun run browser:fetch` when you need them)");
    return;
  }
  await installPlaywrightChromium();
  await installCamoufox();
  log("done — run `acc init` to finish bootstrap, then `acc daemon start`");
}

main().catch((err) => {
  log(`unhandled error: ${err}`);
  // Don't fail bun install — operator can re-run `bun run browser:fetch` later.
  process.exit(0);
});
