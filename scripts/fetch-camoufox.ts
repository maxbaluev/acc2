#!/usr/bin/env bun
// Standalone camoufox fetcher. Used by `bun run browser:fetch` and re-runnable
// any time the binary needs refreshing. Mirrors the camoufox path in
// scripts/postinstall.ts but always runs (no idempotency skip).

import { join } from "node:path";
import { homedir } from "node:os";

const log = (m: string) => console.log(`[acc2 camoufox] ${m}`);

async function spawn(cmd: string[]): Promise<number> {
  log(`exec: ${cmd.join(" ")}`);
  const p = Bun.spawn(cmd, { stdout: "inherit", stderr: "inherit" });
  return p.exited;
}

async function main() {
  log("fetching camoufox firefox binary...");
  let exit = await spawn(["uvx", "--from", "camoufox", "python", "-m", "camoufox", "fetch"]);
  if (exit === 0) {
    log("camoufox fetched via uvx");
    return;
  }
  exit = await spawn(["python", "-m", "camoufox", "fetch"]);
  if (exit === 0) {
    log("camoufox fetched via system python");
    return;
  }
  const fallback = process.env.CAMOUFOX_BINARY_PATH ?? join(homedir(), ".cache", "camoufox", "camoufox");
  log(`fetch failed; either install camoufox manually OR set CAMOUFOX_BINARY_PATH=${fallback}`);
  process.exit(1);
}

main();
