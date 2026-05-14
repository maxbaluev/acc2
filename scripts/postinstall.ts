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
//
// DRY: the camoufox install logic itself now lives in
// `cli/admin_install_deps.ts:installCamoufox` so both `bun install`
// (this script) AND the operator's explicit `acc admin install-deps`
// share one implementation. This file is a thin wrapper.

import { installCamoufox } from "../cli/admin_install_deps";

const log = (msg: string) => console.log(`[acc2 postinstall] ${msg}`);

async function main() {
  if (process.env.ACC2_SKIP_POSTINSTALL === "1") {
    log("ACC2_SKIP_POSTINSTALL=1 set → skipping browser fetch");
    return;
  }
  if (process.env.CI === "true" || process.env.NODE_ENV === "test") {
    log("CI / test env detected → skipping browser fetch (run `bun run browser:fetch` when needed)");
    return;
  }
  const r = await installCamoufox({ log });
  if (r.ok) {
    log(r.detail);
  } else {
    // Print the multi-line detail (it already contains remediation lines).
    for (const line of r.detail.split("\n")) log(line);
  }
  log("done — run `acc admin install-deps` to verify, then `acc init --yes` and `acc daemon start`");
}

main().catch((err) => {
  log(`unhandled error: ${err}`);
  // Never fail bun install — operator can re-run `bun run browser:fetch` later.
  process.exit(0);
});
