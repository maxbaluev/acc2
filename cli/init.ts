// `acc init` — fresh-install bootstrap. Walks a new operator from
// `git clone` to ready-to-run in <60 seconds.
//
// Steps (all idempotent):
//   1. Banner.
//   2. State directory (~/.accint, override via ACCINT_HOME).
//   3. Admin token (~/.accint/state/v2.sock.token, 0600).
//   4. OPENAI_API_KEY detection or interactive prompt.
//   5. opencode CLI check (`which opencode`).
//   6. uv check (`which uv`).
//   7. Camoufox binary check.
//   8. Foundational knowledge seed (Y/n).
//   9. Next-steps printout.
//
// Re-running is safe — every probe is idempotent. `--yes` skips
// prompts and uses defaults (seed=yes, no key prompt).

import {
  appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { newAdminToken } from "../runtime/ids";
import { openDb, closeDb } from "../substrate/db";
import { seedFoundationalKnowledge } from "../substrate/seed";

// ── paths ─────────────────────────────────────────────────────────

export type InitPaths = {
  accintHome: string;          // ~/.accint
  stateDir: string;            // ~/.accint/state
  logsDir: string;             // ~/.accint/logs
  tmpDir: string;              // ~/.accint/tmp
  tokenFile: string;           // ~/.accint/state/v2.sock.token
  dbPath: string;              // ~/.accint/state/accint.db
  envFile: string;             // <cwd>/.env
};

export const resolveInitPaths = (cwd: string = process.cwd()): InitPaths => {
  const accintHome = process.env.ACCINT_HOME ?? join(homedir(), ".accint");
  const stateDir = join(accintHome, "state");
  return {
    accintHome,
    stateDir,
    logsDir: join(accintHome, "logs"),
    tmpDir: join(accintHome, "tmp"),
    tokenFile: join(stateDir, "v2.sock.token"),
    dbPath: join(stateDir, "accint.db"),
    envFile: join(cwd, ".env"),
  };
};

// ── helpers ───────────────────────────────────────────────────────

const ensureDir = (path: string): { created: boolean } => {
  if (existsSync(path)) return { created: false };
  mkdirSync(path, { recursive: true, mode: 0o700 });
  return { created: true };
};

const prompt = async (question: string): Promise<string> => {
  process.stdout.write(question);
  // Bun supports `for await` over process.stdin; collect a single line.
  const chunks: string[] = [];
  for await (const chunk of process.stdin as AsyncIterable<Buffer>) {
    const text = chunk.toString("utf8");
    chunks.push(text);
    if (text.includes("\n")) break;
  }
  return chunks.join("").split("\n")[0]?.trim() ?? "";
};

/** Detect OPENAI_API_KEY in the live env first, then in the project's
 *  .env file (without sourcing it — we just grep for the prefix). */
export const detectOpenAiKey = (envFile: string): "env" | "dotenv" | "missing" => {
  if (process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY.trim()) return "env";
  if (!existsSync(envFile)) return "missing";
  try {
    const lines = readFileSync(envFile, "utf8").split("\n");
    for (const line of lines) {
      const m = line.match(/^\s*OPENAI_API_KEY\s*=\s*(.+)\s*$/);
      if (m && m[1] && m[1].trim().length > 0 && m[1].trim() !== '""') return "dotenv";
    }
  } catch { /* ignore */ }
  return "missing";
};

/** Append OPENAI_API_KEY=<key> to <envFile>, creating it if absent.
 *  Idempotent: if the file already has a non-empty OPENAI_API_KEY line we
 *  leave it untouched (the operator's existing value wins). */
export const writeOpenAiKey = (envFile: string, key: string): { wrote: boolean } => {
  if (detectOpenAiKey(envFile) === "dotenv") return { wrote: false };
  const line = `OPENAI_API_KEY=${key}\n`;
  if (existsSync(envFile)) appendFileSync(envFile, line, { mode: 0o600 });
  else writeFileSync(envFile, line, { mode: 0o600 });
  return { wrote: true };
};

/** Mint a 64-char hex admin token at `path` (0600). Idempotent — if a
 *  valid token already exists we leave it. */
export const ensureAdminToken = (path: string): { minted: boolean } => {
  if (existsSync(path)) {
    try {
      const raw = readFileSync(path, "utf8");
      const parsed = JSON.parse(raw) as { admin_token?: string };
      if (parsed.admin_token && parsed.admin_token.length >= 32) return { minted: false };
    } catch { /* fall through and re-mint */ }
  }
  const token = newAdminToken();
  writeFileSync(path, JSON.stringify({ admin_token: token }, null, 2), { mode: 0o600 });
  try { chmodSync(path, 0o600); } catch { /* best-effort */ }
  return { minted: true };
};

const which = async (binary: string): Promise<string | null> => {
  try {
    const proc = Bun.spawnSync({ cmd: ["which", binary], stdout: "pipe", stderr: "pipe" });
    if (proc.exitCode !== 0) return null;
    const out = new TextDecoder().decode(proc.stdout).trim();
    return out.length > 0 ? out : null;
  } catch { return null; }
};

const findCamofoxBinary = (): string | null => {
  const env = process.env.CAMOUFOX_BINARY_PATH;
  if (env && existsSync(env)) return env;
  const cached = join(homedir(), ".cache", "camofox", "camoufox");
  if (existsSync(cached)) return cached;
  return null;
};

// ── interactive prompt utilities ──────────────────────────────────

const isTty = (): boolean => Boolean(process.stdin.isTTY);

const askYesNo = async (question: string, defaultYes = true): Promise<boolean> => {
  const suffix = defaultYes ? " [Y/n] " : " [y/N] ";
  const ans = (await prompt(question + suffix)).toLowerCase();
  if (ans === "") return defaultYes;
  return ans.startsWith("y");
};

// ── step printers ─────────────────────────────────────────────────

type Logger = (msg: string) => void;

const banner = (log: Logger): void => {
  log("");
  log("─── Welcome to AccInt v2 ───");
  log("Universal Recursive Language Model — persistent thinking daemon.");
  log("Canonical design: docs/v2-design.md");
  log("Quickstart:       docs/operator-install.md (Batch 1.δ)");
  log("");
};

// ── main entry ────────────────────────────────────────────────────

export type InitOptions = {
  yes?: boolean;          // non-interactive mode
  paths?: InitPaths;      // injection for tests
  log?: Logger;           // injection for tests
  warn?: Logger;
};

export type InitSummary = {
  exitCode: number;
  stateDirCreated: boolean;
  tokenMinted: boolean;
  openAiKeyStatus: "env" | "dotenv" | "missing" | "prompted-written" | "prompted-skipped";
  opencodePath: string | null;
  uvPath: string | null;
  camoufoxPath: string | null;
  foundationalSeedImported: number;
  warnings: string[];
};

export const runInitProgrammatic = async (opts: InitOptions = {}): Promise<InitSummary> => {
  const paths = opts.paths ?? resolveInitPaths();
  const log = opts.log ?? ((m: string) => console.log(m));
  const warn = opts.warn ?? ((m: string) => console.warn(m));
  const summary: InitSummary = {
    exitCode: 0,
    stateDirCreated: false,
    tokenMinted: false,
    openAiKeyStatus: "missing",
    opencodePath: null,
    uvPath: null,
    camoufoxPath: null,
    foundationalSeedImported: 0,
    warnings: [],
  };

  banner(log);

  // 1. State directory.
  const home = ensureDir(paths.accintHome);
  const state = ensureDir(paths.stateDir);
  ensureDir(paths.logsDir);
  ensureDir(paths.tmpDir);
  summary.stateDirCreated = home.created || state.created;
  log(`[1/8] state directory: ${paths.accintHome}` + (summary.stateDirCreated ? "  (created)" : "  (existing)"));

  // 2. Admin token.
  const tok = ensureAdminToken(paths.tokenFile);
  summary.tokenMinted = tok.minted;
  log(`[2/8] admin token:     ${paths.tokenFile}` + (tok.minted ? "  (minted)" : "  (existing)"));

  // 3. OPENAI_API_KEY.
  const keyStatus = detectOpenAiKey(paths.envFile);
  if (keyStatus === "env") {
    log("[3/8] OPENAI_API_KEY:  detected in environment");
    summary.openAiKeyStatus = "env";
  } else if (keyStatus === "dotenv") {
    log(`[3/8] OPENAI_API_KEY:  detected in ${paths.envFile}`);
    summary.openAiKeyStatus = "dotenv";
  } else if (opts.yes) {
    warn(`[3/8] OPENAI_API_KEY:  NOT SET — embeddings will be disabled until you add it to ${paths.envFile}`);
    summary.openAiKeyStatus = "missing";
    summary.warnings.push("OPENAI_API_KEY missing — Phase F embeddings disabled");
  } else if (!isTty()) {
    warn("[3/8] OPENAI_API_KEY:  NOT SET (no TTY — cannot prompt)");
    summary.openAiKeyStatus = "missing";
    summary.warnings.push("OPENAI_API_KEY missing");
  } else {
    log("[3/8] OPENAI_API_KEY:  required for embeddings (text-embedding-3-small).");
    const answer = await prompt("       Paste your key now (or press enter to skip): ");
    if (answer && answer.length > 0) {
      writeOpenAiKey(paths.envFile, answer);
      log(`       written to ${paths.envFile}`);
      summary.openAiKeyStatus = "prompted-written";
    } else {
      warn("       skipped — see docs/operator-install.md to configure later.");
      summary.openAiKeyStatus = "prompted-skipped";
      summary.warnings.push("OPENAI_API_KEY skipped at prompt");
    }
  }

  // 4. opencode CLI.
  const opencode = await which("opencode");
  summary.opencodePath = opencode;
  if (opencode) {
    log(`[4/8] opencode CLI:    ${opencode}`);
  } else {
    warn("[4/8] opencode CLI:    NOT FOUND — install from https://github.com/sst/opencode");
    summary.warnings.push("opencode CLI missing — brain dispatch will fail until installed");
  }

  // 5. uv.
  const uv = await which("uv");
  summary.uvPath = uv;
  if (uv) {
    log(`[5/8] uv:              ${uv}`);
  } else {
    warn("[5/8] uv:              NOT FOUND — needed for Phase G uv runtime; install from https://docs.astral.sh/uv/");
    summary.warnings.push("uv missing — uv runtime artifacts will fail until installed");
  }

  // 6. Camoufox binary.
  const camofox = findCamofoxBinary();
  summary.camoufoxPath = camofox;
  if (camofox) {
    log(`[6/8] Camoufox binary: ${camofox}`);
  } else {
    warn("[6/8] Camoufox binary: NOT FOUND — needed for browser runtime; set CAMOUFOX_BINARY_PATH or install to ~/.cache/camofox/");
    summary.warnings.push("Camoufox binary missing — browser runtime artifacts will fail until installed");
  }

  // 7. Foundational seed.
  let approve = false;
  if (opts.yes) {
    approve = true;
    log("[7/8] foundational seed: importing (--yes mode)");
  } else if (!isTty()) {
    approve = false;
    log("[7/8] foundational seed: skipped (no TTY)");
  } else {
    approve = await askYesNo(
      "[7/8] Import the foundational knowledge seed (10 load-bearing principles tagged substrate_auto)?",
      true,
    );
  }
  if (approve) {
    const db = openDb(paths.dbPath);
    try {
      const result = seedFoundationalKnowledge(db, { ownerApproved: true });
      summary.foundationalSeedImported = result.imported;
      if (result.imported > 0) log(`       imported ${result.imported} foundational knowledge entries`);
      else log("       already seeded (skipped)");
    } finally {
      closeDb(paths.dbPath);
    }
  } else {
    log("       skipped — you can run `acc init` again later to opt in");
  }

  // 8. Next steps.
  log("");
  log("[8/8] acc2 is ready. Try:");
  log("       acc daemon start          # spawn the daemon");
  log("       acc daemon status         # confirm it's up");
  log("       acc task \"your first goal\"");
  log("       acc watch                 # live dashboard (Batch 1.β)");
  log("");
  if (summary.warnings.length > 0) {
    warn(`(${summary.warnings.length} warning${summary.warnings.length === 1 ? "" : "s"} above; rerun \`acc init\` after addressing.)`);
  }

  return summary;
};

const usage = (): string => `acc init — fresh-install bootstrap

Usage:
  acc init           Interactive walk-through (prompts for OPENAI_API_KEY,
                     foundational seed import, etc.)
  acc init --yes     Non-interactive; skips prompts, imports the seed,
                     warns about anything missing.

Idempotent — re-running is always safe.
`;

/** Programmatic entry — exported for cli/dispatch.ts and the test suite.
 *  Returns the process exit code (0 = success). */
export const runInit = async (argv: string[]): Promise<number> => {
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h" || arg === "help") {
      console.log(usage());
      return 0;
    }
  }
  const yes = argv.includes("--yes") || argv.includes("-y");

  // Graceful interrupt: finish any in-progress file write, then exit clean.
  // We rely on Node/Bun's default SIGINT handler unless something is in flight;
  // each fs write below is synchronous, so the worst case is a partially-
  // written byte stream just before SIGINT — Bun's synchronous writeFile is
  // atomic per call, so we accept the default behaviour.
  const onInt = () => { console.log("\nacc init: interrupted"); process.exit(130); };
  process.once("SIGINT", onInt);
  try {
    const summary = await runInitProgrammatic({ yes });
    return summary.exitCode;
  } catch (err) {
    console.error(`acc init failed: ${(err as Error).message}`);
    return 1;
  } finally {
    process.off("SIGINT", onInt);
  }
};

if (import.meta.main) {
  void runInit(process.argv.slice(2)).then((code) => process.exit(code));
}
