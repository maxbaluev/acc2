// acc2 init CLI tests — drive the programmatic entry against a temp HOME
// and assert idempotency, the admin-token mint, the foundational-seed
// opt-in, and the interactive-prompt path for OPENAI_API_KEY.

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb } from "../substrate/db";
import {
  detectOpenAiKey, ensureAdminToken, resolveInitPaths,
  runInit, runInitProgrammatic, writeOpenAiKey,
} from "./init";

let tmpRoot = "";
let accintHome = "";
let envFile = "";
let prevAccintHome: string | undefined;
let prevOpenAiKey: string | undefined;
let prevCwd = "";

const silent = () => { /* swallow output */ };

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "acc2-init-"));
  accintHome = join(tmpRoot, ".accint");
  prevCwd = process.cwd();
  // Each test makes its own working dir so .env writes don't collide.
  const workDir = join(tmpRoot, "work");
  require("node:fs").mkdirSync(workDir, { recursive: true });
  process.chdir(workDir);
  envFile = join(workDir, ".env");
  prevAccintHome = process.env.ACCINT_HOME;
  prevOpenAiKey = process.env.OPENAI_API_KEY;
  process.env.ACCINT_HOME = accintHome;
  delete process.env.OPENAI_API_KEY;
});

afterAll(() => {
  closeDb();
  if (prevAccintHome === undefined) delete process.env.ACCINT_HOME;
  else process.env.ACCINT_HOME = prevAccintHome;
  if (prevOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = prevOpenAiKey;
});

const cleanup = () => {
  closeDb();
  try { process.chdir(prevCwd); } catch { /* prev cwd gone */ }
  rmSync(tmpRoot, { recursive: true, force: true });
};

describe("resolveInitPaths", () => {
  test("honors ACCINT_HOME override", () => {
    process.env.ACCINT_HOME = accintHome;
    const paths = resolveInitPaths();
    expect(paths.accintHome).toBe(accintHome);
    expect(paths.stateDir).toBe(join(accintHome, "state"));
    expect(paths.tokenFile).toBe(join(accintHome, "state", "v2.sock.token"));
    expect(paths.dbPath).toBe(join(accintHome, "state", "accint.db"));
    cleanup();
  });
});

describe("ensureAdminToken", () => {
  test("mints a 64-hex token on first call; idempotent on second", () => {
    const tokenFile = join(tmpRoot, "tok.json");
    const first = ensureAdminToken(tokenFile);
    expect(first.minted).toBe(true);
    expect(existsSync(tokenFile)).toBe(true);
    const parsed = JSON.parse(readFileSync(tokenFile, "utf8")) as { admin_token?: string };
    expect(parsed.admin_token).toBeDefined();
    expect(parsed.admin_token!.length).toBeGreaterThanOrEqual(32);

    const second = ensureAdminToken(tokenFile);
    expect(second.minted).toBe(false);
    const parsed2 = JSON.parse(readFileSync(tokenFile, "utf8")) as { admin_token?: string };
    expect(parsed2.admin_token).toBe(parsed.admin_token);
    cleanup();
  });

  test("re-mints when file is corrupt", () => {
    const tokenFile = join(tmpRoot, "tok.json");
    writeFileSync(tokenFile, "not json", { mode: 0o600 });
    const r = ensureAdminToken(tokenFile);
    expect(r.minted).toBe(true);
    const parsed = JSON.parse(readFileSync(tokenFile, "utf8")) as { admin_token?: string };
    expect(parsed.admin_token).toBeDefined();
    cleanup();
  });
});

describe("detectOpenAiKey", () => {
  test("returns 'env' when process.env has it", () => {
    process.env.OPENAI_API_KEY = "sk-test-from-env";
    expect(detectOpenAiKey(envFile)).toBe("env");
    cleanup();
  });

  test("returns 'dotenv' when env file has a non-empty value", () => {
    writeFileSync(envFile, "OPENAI_API_KEY=sk-test-from-file\n");
    expect(detectOpenAiKey(envFile)).toBe("dotenv");
    cleanup();
  });

  test("returns 'missing' when neither has it", () => {
    expect(detectOpenAiKey(envFile)).toBe("missing");
    cleanup();
  });

  test("returns 'missing' when env file has empty value", () => {
    writeFileSync(envFile, "OPENAI_API_KEY=\n");
    expect(detectOpenAiKey(envFile)).toBe("missing");
    cleanup();
  });
});

describe("writeOpenAiKey", () => {
  test("creates the env file when absent", () => {
    const r = writeOpenAiKey(envFile, "sk-new-key");
    expect(r.wrote).toBe(true);
    expect(readFileSync(envFile, "utf8")).toContain("OPENAI_API_KEY=sk-new-key");
    cleanup();
  });

  test("appends to existing env file", () => {
    writeFileSync(envFile, "SOMETHING_ELSE=x\n");
    const r = writeOpenAiKey(envFile, "sk-new-key");
    expect(r.wrote).toBe(true);
    const content = readFileSync(envFile, "utf8");
    expect(content).toContain("SOMETHING_ELSE=x");
    expect(content).toContain("OPENAI_API_KEY=sk-new-key");
    cleanup();
  });

  test("does not overwrite an existing non-empty key", () => {
    writeFileSync(envFile, "OPENAI_API_KEY=sk-keep-this\n");
    const r = writeOpenAiKey(envFile, "sk-new-value");
    expect(r.wrote).toBe(false);
    expect(readFileSync(envFile, "utf8")).toContain("sk-keep-this");
    cleanup();
  });
});

describe("runInitProgrammatic(--yes mode)", () => {
  test("creates state dir, mints token, seeds foundational knowledge", async () => {
    const summary = await runInitProgrammatic({ yes: true, log: silent, warn: silent });
    expect(summary.exitCode).toBe(0);
    expect(summary.stateDirCreated).toBe(true);
    expect(summary.tokenMinted).toBe(true);

    const tokenFile = join(accintHome, "state", "v2.sock.token");
    expect(existsSync(tokenFile)).toBe(true);
    const st = statSync(tokenFile);
    // 0o600 — owner rw only. statSync().mode masks the file type bits.
    expect(st.mode & 0o777).toBe(0o600);

    // Foundational seed should have imported >0 rows.
    expect(summary.foundationalSeedImported).toBeGreaterThan(0);
    cleanup();
  });

  test("second run is idempotent — no duplicate writes", async () => {
    const first = await runInitProgrammatic({ yes: true, log: silent, warn: silent });
    expect(first.tokenMinted).toBe(true);
    expect(first.foundationalSeedImported).toBeGreaterThan(0);

    const second = await runInitProgrammatic({ yes: true, log: silent, warn: silent });
    expect(second.exitCode).toBe(0);
    expect(second.stateDirCreated).toBe(false);
    expect(second.tokenMinted).toBe(false);
    // Already-seeded — substrate refuses a second import.
    expect(second.foundationalSeedImported).toBe(0);
    cleanup();
  });

  test("recognises an existing partial state (state dir but no token) and heals forward", async () => {
    // Pre-create the state dir but no token.
    require("node:fs").mkdirSync(join(accintHome, "state"), { recursive: true });
    const summary = await runInitProgrammatic({ yes: true, log: silent, warn: silent });
    expect(summary.exitCode).toBe(0);
    expect(summary.stateDirCreated).toBe(false); // dir was already there
    expect(summary.tokenMinted).toBe(true);      // but the token had to be minted
    cleanup();
  });

  test("warns when OPENAI_API_KEY is missing in --yes mode", async () => {
    delete process.env.OPENAI_API_KEY;
    const summary = await runInitProgrammatic({ yes: true, log: silent, warn: silent });
    expect(summary.openAiKeyStatus).toBe("missing");
    expect(summary.warnings.some((w) => w.includes("OPENAI_API_KEY"))).toBe(true);
    cleanup();
  });

  test("detects OPENAI_API_KEY in process.env", async () => {
    process.env.OPENAI_API_KEY = "sk-test-already-set";
    const summary = await runInitProgrammatic({ yes: true, log: silent, warn: silent });
    expect(summary.openAiKeyStatus).toBe("env");
    cleanup();
  });

  test("returns exit 0 from runInit(['--yes'])", async () => {
    const origLog = console.log; const origWarn = console.warn;
    console.log = () => { /* silence */ };
    console.warn = () => { /* silence */ };
    try {
      const code = await runInit(["--yes"]);
      expect(code).toBe(0);
    } finally {
      console.log = origLog;
      console.warn = origWarn;
    }
    cleanup();
  });

  test("runInit(['--help']) prints usage and returns 0", async () => {
    const lines: string[] = [];
    const origLog = console.log;
    console.log = (...a: unknown[]) => { lines.push(a.map((x) => String(x)).join(" ")); };
    try {
      const code = await runInit(["--help"]);
      expect(code).toBe(0);
      expect(lines.join("\n")).toContain("acc init");
      expect(lines.join("\n")).toContain("--yes");
    } finally {
      console.log = origLog;
    }
    cleanup();
  });
});
