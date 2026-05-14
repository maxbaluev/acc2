#!/usr/bin/env bun
// acc2 postinstall — auto-fetch the Camoufox firefox binary so the substrate's
// `camofox-browser` runtime is end-to-end runnable after `bun install`.
//
// IMPORTANT: Camoufox IS the browser (a Firefox fork) — see
// https://camoufox.com/python/installation/. v2 does NOT use chromium. The
// `playwright` npm package gives us the driver API (firefox.launchPersistentContext)
// but the actual binary it drives is camoufox, fetched here via Camoufox's own
// Python launcher.
//
// Idempotent + best-effort: skips when the binary is already on disk; never
// hard-aborts `bun install` on a transient network blip.

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

async function installCamoufox(): Promise<void> {
  const camoufoxBin = process.env.CAMOUFOX_BINARY_PATH ?? join(homedir(), ".cache", "camoufox", "camoufox");
  if (existsSync(camoufoxBin)) {
    log(`camoufox binary present at ${camoufoxBin} → skipping fetch`);
    return;
  }
  log("fetching camoufox firefox binary (one-time, ~120 MB)...");

  // Try uvx (Astral's transient pip-runtime) first — works without a persistent
  // pip install. Requires `uv` on PATH.
  const uvxOk = (await spawn(["uvx", "--from", "camoufox", "python", "-m", "camoufox", "fetch"], { allowFail: true })).ok;
  if (uvxOk) return;

  // Fall back to `python -m camoufox fetch` (expects user pip-installed camoufox).
  const pyOk = (await spawn(["python", "-m", "camoufox", "fetch"], { allowFail: true })).ok;
  if (pyOk) return;

  log("camoufox fetch failed via uvx + python. Operator can run manually:");
  log("  pip install camoufox && python -m camoufox fetch");
  log("OR set CAMOUFOX_BINARY_PATH if you already have the binary elsewhere.");
  log("See https://camoufox.com/python/installation/ for full install paths.");
}

async function main() {
  if (process.env.ACC2_SKIP_POSTINSTALL === "1") {
    log("ACC2_SKIP_POSTINSTALL=1 set → skipping browser fetch");
    return;
  }
  if (process.env.CI === "true" || process.env.NODE_ENV === "test") {
    log("CI / test env detected → skipping browser fetch (run `bun run browser:fetch` when needed)");
    return;
  }
  await installCamoufox();
  log("done — run `acc init` to finish bootstrap, then `acc daemon start`");
}

main().catch((err) => {
  log(`unhandled error: ${err}`);
  // Never fail bun install — operator can re-run `bun run browser:fetch` later.
  process.exit(0);
});
