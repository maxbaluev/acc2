// acc2 cli/admin tests — drive the programmatic entry against injected
// AdminEnv stubs. Hermetic: no subprocess, no daemon, no network, no fs.

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { runAdmin, type AdminEnv } from "./admin";
import { defaultVersionEnv, type VersionEnv } from "../runtime/opencode_version";
import { closeDb, openDb } from "../substrate/db";
import { runViews } from "../substrate/views";
import { emitEvent } from "../runtime/events";
import { insertArtifact } from "../runtime/artifact_store";
import { runExport } from "./admin_export";

const makeVersionEnv = (overrides: Partial<VersionEnv> = {}): VersionEnv => {
  const files = new Map<string, string>();
  return {
    which: () => null,
    spawn: () => ({ status: 0, stdout: "", stderr: "" }),
    fileExists: (p) => files.has(p),
    readFile: (p) => files.get(p) ?? null,
    writeFile: (p, c) => { files.set(p, c); },
    mkdirp: () => undefined,
    fetch: async () => ({ ok: false, status: 500, text: async () => "" }),
    homedir: () => "/home/test",
    now: () => 1_700_000_000_000,
    env: {},
    ...overrides,
  };
};

const makeEnv = (overrides: Partial<AdminEnv> = {}): { env: AdminEnv; out: string[]; err: string[] } => {
  const out: string[] = [];
  const err: string[] = [];
  const env: AdminEnv = {
    version: makeVersionEnv(),
    stopDaemon: async () => false,
    startDaemon: async () => undefined,
    prompt: async () => "y",
    out: (line) => { out.push(line); },
    err: (line) => { err.push(line); },
    yes: false,
    ...overrides,
  };
  return { env, out, err };
};

describe("acc admin help", () => {
  test("prints usage banner when no subcommand", async () => {
    const { env, out } = makeEnv();
    const code = await runAdmin([], env);
    expect(code).toBe(0);
    expect(out.join("\n")).toContain("opencode-version");
    expect(out.join("\n")).toContain("update-opencode");
    expect(out.join("\n")).toContain("upgrade-check");
  });

  test("returns 1 for unknown subcommand", async () => {
    const { env, err } = makeEnv();
    const code = await runAdmin(["bogus"], env);
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("unknown subcommand");
  });
});

describe("acc admin opencode-version", () => {
  test("prints current + latest + up-to-date when versions equal", async () => {
    const { env, out } = makeEnv({
      version: makeVersionEnv({
        which: () => "/home/test/.opencode/bin/opencode",
        fileExists: () => true,
        spawn: () => ({ status: 0, stdout: "1.4.3\n", stderr: "" }),
        fetch: async () => ({
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ tag_name: "v1.4.3", published_at: "2026-04-01T00:00:00Z" }),
        }),
      }),
    });
    const code = await runAdmin(["opencode-version"], env);
    expect(code).toBe(0);
    const joined = out.join("\n");
    expect(joined).toContain("current: 1.4.3");
    expect(joined).toContain("latest:  1.4.3");
    expect(joined).toContain("up to date");
  });

  test("flags upgrade-available when current < latest", async () => {
    const { env, out } = makeEnv({
      version: makeVersionEnv({
        which: () => "/home/test/.opencode/bin/opencode",
        fileExists: () => true,
        spawn: () => ({ status: 0, stdout: "1.4.3\n", stderr: "" }),
        fetch: async () => ({
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ tag_name: "v1.5.0" }),
        }),
      }),
    });
    const code = await runAdmin(["opencode-version"], env);
    expect(code).toBe(0);
    expect(out.join("\n")).toContain("upgrade available");
  });

  test("returns 1 when opencode missing", async () => {
    const { env, err } = makeEnv({
      version: makeVersionEnv({
        which: () => null,
        fileExists: () => false,
      }),
    });
    const code = await runAdmin(["opencode-version"], env);
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("not installed");
  });

  test("renders unknown when fetch fails", async () => {
    const { env, out } = makeEnv({
      version: makeVersionEnv({
        which: () => "/home/test/.opencode/bin/opencode",
        fileExists: () => true,
        spawn: () => ({ status: 0, stdout: "1.4.3\n", stderr: "" }),
        fetch: async () => ({ ok: false, status: 503, text: async () => "" }),
      }),
    });
    const code = await runAdmin(["opencode-version"], env);
    expect(code).toBe(0);
    expect(out.join("\n")).toContain("latest:  unknown");
  });
});

describe("acc admin update-opencode", () => {
  test("returns 1 when opencode missing", async () => {
    const { env, err } = makeEnv({
      version: makeVersionEnv({
        which: () => null,
        fileExists: () => false,
      }),
    });
    const code = await runAdmin(["update-opencode", "--yes"], env);
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("not installed");
  });

  test("returns 0 when already current (informational)", async () => {
    const { env, out } = makeEnv({
      version: makeVersionEnv({
        which: () => "/home/test/.opencode/bin/opencode",
        fileExists: () => true,
        spawn: () => ({ status: 0, stdout: "1.5.0\n", stderr: "" }),
        fetch: async () => ({
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ tag_name: "v1.5.0" }),
        }),
      }),
    });
    const code = await runAdmin(["update-opencode", "--yes"], env);
    expect(code).toBe(0);
    expect(out.join("\n")).toContain("already current");
  });

  test("--yes path bypasses prompt and calls upgrade", async () => {
    let promptCalled = false;
    // `--version` is queried multiple times across the chain (admin pre-check
    // + updateOpencode's internal check + post-upgrade re-detection). We
    // flip to the new version only AFTER the upgrade command has been seen.
    let upgraded = false;
    const { env, out } = makeEnv({
      version: makeVersionEnv({
        which: () => "/home/test/.opencode/bin/opencode",
        fileExists: () => true,
        spawn: (cmd, args) => {
          if (args[0] === "--version") {
            return upgraded
              ? { status: 0, stdout: "1.5.0\n", stderr: "" }
              : { status: 0, stdout: "1.4.3\n", stderr: "" };
          }
          // Anything else is the upgrade command (`sh -lc curl … | bash`).
          upgraded = true;
          return { status: 0, stdout: "ok", stderr: "" };
        },
        fetch: async () => ({
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ tag_name: "v1.5.0" }),
        }),
      }),
      prompt: async () => { promptCalled = true; return "n"; },
    });
    const code = await runAdmin(["update-opencode", "--yes"], env);
    expect(promptCalled).toBe(false);
    expect(code).toBe(0);
    expect(out.join("\n")).toContain("opencode upgraded");
  });

  test("interactive 'n' answer cancels and returns 0", async () => {
    const { env, out } = makeEnv({
      version: makeVersionEnv({
        which: () => "/home/test/.opencode/bin/opencode",
        fileExists: () => true,
        spawn: () => ({ status: 0, stdout: "1.4.3\n", stderr: "" }),
        fetch: async () => ({
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ tag_name: "v1.5.0" }),
        }),
      }),
      prompt: async () => "n",
    });
    const code = await runAdmin(["update-opencode"], env);
    expect(code).toBe(0);
    expect(out.join("\n")).toContain("upgrade cancelled");
  });

  test("returns 1 on install failure", async () => {
    const { env, err } = makeEnv({
      version: makeVersionEnv({
        which: () => "/home/test/.opencode/bin/opencode",
        fileExists: () => true,
        spawn: (cmd, args) => {
          if (args[0] === "--version") return { status: 0, stdout: "1.4.3\n", stderr: "" };
          return { status: 1, stdout: "", stderr: "boom" };
        },
        fetch: async () => ({
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ tag_name: "v1.5.0" }),
        }),
      }),
    });
    const code = await runAdmin(["update-opencode", "--yes"], env);
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("upgrade failed");
  });

  test("daemon stop+start invoked when daemon running", async () => {
    let stopCalled = false;
    let startCalled = false;
    let upgraded = false;
    const { env, out } = makeEnv({
      version: makeVersionEnv({
        which: () => "/home/test/.opencode/bin/opencode",
        fileExists: () => true,
        spawn: (cmd, args) => {
          if (args[0] === "--version") {
            return upgraded
              ? { status: 0, stdout: "1.5.0\n", stderr: "" }
              : { status: 0, stdout: "1.4.3\n", stderr: "" };
          }
          upgraded = true;
          return { status: 0, stdout: "ok", stderr: "" };
        },
        fetch: async () => ({
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ tag_name: "v1.5.0" }),
        }),
      }),
      stopDaemon: async () => { stopCalled = true; return true; },
      startDaemon: async () => { startCalled = true; },
    });
    const code = await runAdmin(["update-opencode", "--yes"], env);
    expect(code).toBe(0);
    expect(stopCalled).toBe(true);
    expect(startCalled).toBe(true);
    expect(out.join("\n")).toContain("daemon stopped before upgrade");
  });
});

describe("acc admin upgrade-check", () => {
  test("reports all subsystems", async () => {
    const { env, out } = makeEnv({
      version: makeVersionEnv({
        which: () => "/home/test/.opencode/bin/opencode",
        fileExists: () => true,
        spawn: (cmd, args) => {
          if (cmd === "/home/test/.opencode/bin/opencode" && args[0] === "--version") {
            return { status: 0, stdout: "1.4.3\n", stderr: "" };
          }
          if (cmd === "bun" && args[0] === "--version") return { status: 0, stdout: "1.3.0\n", stderr: "" };
          if (cmd === "uv" && args[0] === "--version") return { status: 0, stdout: "uv 0.5.0\n", stderr: "" };
          return { status: 1, stdout: "", stderr: "" };
        },
        fetch: async () => ({
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ tag_name: "v1.5.0" }),
        }),
      }),
    });
    const code = await runAdmin(["upgrade-check"], env);
    expect(code).toBe(0);
    const joined = out.join("\n");
    expect(joined).toContain("opencode");
    expect(joined).toContain("bun");
    expect(joined).toContain("uv");
    expect(joined).toContain("camoufox");
    expect(joined).toContain("[UPGRADE]"); // opencode 1.4.3 → 1.5.0
  });

  test("reports all-current when no upgrades available", async () => {
    const { env, out } = makeEnv({
      version: makeVersionEnv({
        which: () => "/home/test/.opencode/bin/opencode",
        fileExists: () => true,
        spawn: () => ({ status: 0, stdout: "1.5.0\n", stderr: "" }),
        fetch: async () => ({
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ tag_name: "v1.5.0" }),
        }),
      }),
    });
    const code = await runAdmin(["upgrade-check"], env);
    expect(code).toBe(0);
    expect(out.join("\n")).toContain("all subsystems current");
  });
});

describe("export shape", () => {
  test("runAdmin is exported as expected", () => {
    expect(typeof runAdmin).toBe("function");
  });

  test("defaultVersionEnv constructs without throwing", () => {
    const env = defaultVersionEnv();
    expect(typeof env.which).toBe("function");
    expect(typeof env.spawn).toBe("function");
  });
});

// ─────────────────────────────────────────────────────────────────────
// Batch 3.ADMIN — export / import / rotate / inspect / override / archive
// ─────────────────────────────────────────────────────────────────────

afterAll(() => closeDb());

const makeAdminEnvWithDb = (db: Database, opts: Partial<AdminEnv> = {}): {
  env: AdminEnv; out: string[]; err: string[];
} => {
  const out: string[] = [];
  const err: string[] = [];
  const env: AdminEnv = {
    version: ((): VersionEnv => ({
      which: () => null,
      spawn: () => ({ status: 0, stdout: "", stderr: "" }),
      fileExists: () => false,
      readFile: () => null,
      writeFile: () => {},
      mkdirp: () => undefined,
      fetch: async () => ({ ok: false, status: 500, text: async () => "" }),
      homedir: () => "/home/test",
      now: () => 1_700_000_000_000,
      env: {},
    }))(),
    stopDaemon: async () => false,
    startDaemon: async () => undefined,
    prompt: async () => "y",
    out: (line) => { out.push(line); },
    err: (line) => { err.push(line); },
    yes: false,
    openSubstrate: () => db,
    stateDbPath: ":memory:",
    adminTokenFile: "/tmp/test-token.json",
    auxBaseUrlProbe: () => null,
    currentSchemaVersion: "0",
    ...opts,
  };
  return { env, out, err };
};

// ── inspect-knowledge ────────────────────────────────────────────────

describe("acc admin inspect-knowledge", () => {
  test("returns 0 + empty banner when no promoted rows exist", async () => {
    closeDb();
    const db = openDb(":memory:");
    runViews(db);
    const { env, out } = makeAdminEnvWithDb(db);
    const code = await runAdmin(["inspect-knowledge"], env);
    expect(code).toBe(0);
    expect(out.join("\n")).toContain("no rows match");
    closeDb();
  });

  test("lists promoted knowledge rows", async () => {
    closeDb();
    const db = openDb(":memory:");
    runViews(db);
    const cand = emitEvent(db, {
      kind: "knowledge_candidate",
      substrate_origin: "opencode",
      payload: { text: "Verifier residual must be in [0,1].", tags: ["substrate"] },
    });
    emitEvent(db, {
      kind: "knowledge_promoted",
      substrate_origin: "opencode",
      payload: { candidate_id: cand.id, score: 0.9, confidence: 0.85 },
      context_refs: [cand.id],
    });
    const { env, out } = makeAdminEnvWithDb(db);
    const code = await runAdmin(["inspect-knowledge"], env);
    expect(code).toBe(0);
    const joined = out.join("\n");
    expect(joined).toContain("opencode");
    expect(joined).toContain("Verifier residual");
    expect(joined).toContain("score=0.900");
    closeDb();
  });

  test("filters by --origin", async () => {
    closeDb();
    const db = openDb(":memory:");
    runViews(db);
    for (const origin of ["opencode", "claude_root"] as const) {
      const c = emitEvent(db, {
        kind: "knowledge_candidate",
        substrate_origin: origin,
        payload: { text: `from ${origin}` },
      });
      emitEvent(db, {
        kind: "knowledge_promoted",
        substrate_origin: origin,
        payload: { candidate_id: c.id, score: 0.8, confidence: 0.7 },
        context_refs: [c.id],
      });
    }
    const { env, out } = makeAdminEnvWithDb(db);
    const code = await runAdmin(["inspect-knowledge", "--origin", "opencode"], env);
    expect(code).toBe(0);
    const joined = out.join("\n");
    expect(joined).toContain("from opencode");
    expect(joined).not.toContain("from claude_root");
    closeDb();
  });

  test("respects --limit", async () => {
    closeDb();
    const db = openDb(":memory:");
    runViews(db);
    for (let i = 0; i < 5; i++) {
      const c = emitEvent(db, {
        kind: "knowledge_candidate",
        substrate_origin: "opencode",
        payload: { text: `entry ${i}` },
      });
      emitEvent(db, {
        kind: "knowledge_promoted",
        substrate_origin: "opencode",
        payload: { candidate_id: c.id, score: 0.85, confidence: 0.8 },
        context_refs: [c.id],
      });
    }
    const { env, out } = makeAdminEnvWithDb(db);
    const code = await runAdmin(["inspect-knowledge", "--limit", "2"], env);
    expect(code).toBe(0);
    const joined = out.join("\n");
    // The header reports "2 row" — be lenient about plural
    expect(joined).toMatch(/2 rows?/);
    closeDb();
  });
});

// ── override-quarantine ──────────────────────────────────────────────

describe("acc admin override-quarantine", () => {
  test("flips a quarantined artifact back to admitted", async () => {
    closeDb();
    const db = openDb(":memory:");
    runViews(db);
    const a = insertArtifact(db, {
      runtime: "bun",
      body: "// q",
      declaredSandbox: { runtime: "bun", cpu_ms: 100, wall_ms: 1000, memory_mb: 32 },
      stateRoot: null,
      posteriorAlpha: 1,
      posteriorBeta: 5,
      score: 0.1,
      confidence: 0.6,
      recentResidualMean: 0.9,
      recentKillCount: 0,
      status: "quarantined",
      name: null,
      fixtureInput: null,
      fixtureExpectedResidual: 0,
    });
    const { env, out } = makeAdminEnvWithDb(db);
    const code = await runAdmin(["override-quarantine", a.id, "--reason", "manual_test"], env);
    expect(code).toBe(0);
    expect(out.join("\n")).toContain("quarantined → admitted");
    expect(out.join("\n")).toContain("manual_test");
    const after = db.query("SELECT status FROM act_artifact WHERE id=?").get(a.id) as { status: string };
    expect(after.status).toBe("admitted");
    const ev = db
      .query("SELECT id FROM events WHERE kind = 'act_artifact_quarantine_overridden'")
      .all() as Array<{ id: string }>;
    expect(ev.length).toBe(1);
    closeDb();
  });

  test("returns 1 when artifact is missing", async () => {
    closeDb();
    const db = openDb(":memory:");
    runViews(db);
    const { env, err } = makeAdminEnvWithDb(db);
    const code = await runAdmin(["override-quarantine", "no_such_id"], env);
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("not found");
    closeDb();
  });

  test("idempotent: second call reports already admitted", async () => {
    closeDb();
    const db = openDb(":memory:");
    runViews(db);
    const a = insertArtifact(db, {
      runtime: "bun",
      body: "// q",
      declaredSandbox: { runtime: "bun", cpu_ms: 100, wall_ms: 1000, memory_mb: 32 },
      stateRoot: null,
      posteriorAlpha: 1,
      posteriorBeta: 5,
      score: 0.1,
      confidence: 0.6,
      recentResidualMean: 0.9,
      recentKillCount: 0,
      status: "quarantined",
      name: null,
      fixtureInput: null,
      fixtureExpectedResidual: 0,
    });
    const first = await runAdmin(["override-quarantine", a.id], makeAdminEnvWithDb(db).env);
    expect(first).toBe(0);
    const { env, out } = makeAdminEnvWithDb(db);
    const second = await runAdmin(["override-quarantine", a.id], env);
    expect(second).toBe(0);
    expect(out.join("\n")).toContain("already admitted");
    closeDb();
  });
});

// ── archive-rolling ──────────────────────────────────────────────────

describe("acc admin archive-rolling", () => {
  test("archives a rolling_active directive", async () => {
    closeDb();
    const db = openDb(":memory:");
    runViews(db);
    const directiveId = "dir_test_rolling";
    emitEvent(db, {
      kind: "directive_opened",
      substrate_origin: "owner",
      directive_id: directiveId,
      payload: { text: "rolling work", lifecycle: "rolling_active" },
    });
    const { env, out } = makeAdminEnvWithDb(db);
    const code = await runAdmin(["archive-rolling", directiveId], env);
    expect(code).toBe(0);
    expect(out.join("\n")).toContain("rolling_active → committed");
    const archived = db
      .query("SELECT id FROM events WHERE kind = 'directive_archived_by_operator'")
      .all();
    expect(archived.length).toBe(1);
    const amend = db
      .query("SELECT payload FROM events WHERE kind = 'directive_amended' ORDER BY ts DESC LIMIT 1")
      .get() as { payload: string };
    expect(JSON.parse(amend.payload).lifecycle).toBe("committed");
    closeDb();
  });

  test("refuses non-rolling lifecycle", async () => {
    closeDb();
    const db = openDb(":memory:");
    runViews(db);
    const directiveId = "dir_test_one_shot";
    emitEvent(db, {
      kind: "directive_opened",
      substrate_origin: "owner",
      directive_id: directiveId,
      payload: { text: "one-shot", lifecycle: "one_shot" },
    });
    const { env, err } = makeAdminEnvWithDb(db);
    const code = await runAdmin(["archive-rolling", directiveId], env);
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("not 'rolling_active'");
    closeDb();
  });

  test("idempotent: second call says already archived", async () => {
    closeDb();
    const db = openDb(":memory:");
    runViews(db);
    const directiveId = "dir_test_already";
    emitEvent(db, {
      kind: "directive_opened",
      substrate_origin: "owner",
      directive_id: directiveId,
      payload: { text: "rolling work", lifecycle: "rolling_active" },
    });
    expect(await runAdmin(["archive-rolling", directiveId], makeAdminEnvWithDb(db).env)).toBe(0);
    const { env, out } = makeAdminEnvWithDb(db);
    const code = await runAdmin(["archive-rolling", directiveId], env);
    expect(code).toBe(0);
    expect(out.join("\n")).toContain("already archived");
    closeDb();
  });

  test("returns 1 when directive does not exist", async () => {
    closeDb();
    const db = openDb(":memory:");
    runViews(db);
    const { env, err } = makeAdminEnvWithDb(db);
    const code = await runAdmin(["archive-rolling", "dir_nope"], env);
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("not found");
    closeDb();
  });
});

// ── rotate-admin-token ───────────────────────────────────────────────

describe("acc admin rotate-admin-token", () => {
  let tmpRoot = "";
  let tokenFile = "";

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "acc2-admin-rot-"));
    tokenFile = join(tmpRoot, "v2.sock.token");
  });

  test("writes a new token with 0600 mode and emits the audit event", async () => {
    closeDb();
    const db = openDb(":memory:");
    runViews(db);
    const { env, out } = makeAdminEnvWithDb(db, { adminTokenFile: tokenFile });
    const code = await runAdmin(["rotate-admin-token"], env);
    expect(code).toBe(0);
    expect(existsSync(tokenFile)).toBe(true);
    const st = statSync(tokenFile);
    expect(st.mode & 0o777).toBe(0o600);
    const parsed = JSON.parse(readFileSync(tokenFile, "utf8")) as { admin_token?: string };
    expect(parsed.admin_token).toBeDefined();
    expect(parsed.admin_token!.length).toBeGreaterThanOrEqual(32);
    expect(out.join("\n")).toContain("admin token rotated");
    const audit = db
      .query("SELECT id FROM events WHERE kind = 'admin_token_rotated'")
      .all();
    expect(audit.length).toBe(1);
    rmSync(tmpRoot, { recursive: true, force: true });
    closeDb();
  });

  test("subsequent rotations replace the token (no append)", async () => {
    closeDb();
    const db = openDb(":memory:");
    runViews(db);
    expect(await runAdmin(["rotate-admin-token"], makeAdminEnvWithDb(db, { adminTokenFile: tokenFile }).env)).toBe(0);
    const first = JSON.parse(readFileSync(tokenFile, "utf8")).admin_token;
    expect(await runAdmin(["rotate-admin-token"], makeAdminEnvWithDb(db, { adminTokenFile: tokenFile }).env)).toBe(0);
    const second = JSON.parse(readFileSync(tokenFile, "utf8")).admin_token;
    expect(second).not.toBe(first);
    rmSync(tmpRoot, { recursive: true, force: true });
    closeDb();
  });
});

// ── rotate-external-token ────────────────────────────────────────────

describe("acc admin rotate-external-token", () => {
  test("rotates a registered source's token + emits audit", async () => {
    closeDb();
    const db = openDb(":memory:");
    runViews(db);
    emitEvent(db, {
      kind: "external_source_registered",
      substrate_origin: "owner",
      payload: { source: "github_webhook", schema_hint: null },
    });
    const { env, out } = makeAdminEnvWithDb(db);
    const code = await runAdmin(["rotate-external-token", "github_webhook"], env);
    expect(code).toBe(0);
    const joined = out.join("\n");
    expect(joined).toContain("github_webhook");
    expect(joined).toContain("preview:");
    const meta = db.query("SELECT value FROM meta WHERE key='external_source_tokens'").get() as { value: string };
    const map = JSON.parse(meta.value) as Record<string, string>;
    expect(map.github_webhook).toBeDefined();
    expect(map.github_webhook!.length).toBeGreaterThanOrEqual(16);
    const audit = db
      .query("SELECT id FROM events WHERE kind = 'external_source_token_rotated'")
      .all();
    expect(audit.length).toBe(1);
    closeDb();
  });

  test("refuses unregistered source", async () => {
    closeDb();
    const db = openDb(":memory:");
    runViews(db);
    const { env, err } = makeAdminEnvWithDb(db);
    const code = await runAdmin(["rotate-external-token", "bogus_source"], env);
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("source_not_registered");
    closeDb();
  });

  test("requires source argument", async () => {
    closeDb();
    const db = openDb(":memory:");
    runViews(db);
    const { env, err } = makeAdminEnvWithDb(db);
    const code = await runAdmin(["rotate-external-token"], env);
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("missing <source>");
    closeDb();
  });
});

// ── export / import round-trip ──────────────────────────────────────

describe("acc admin export / import", () => {
  let tmpRoot = "";
  let srcStateDir = "";
  let dstStateDir = "";

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "acc2-admin-ex-"));
    srcStateDir = join(tmpRoot, "src", "state");
    dstStateDir = join(tmpRoot, "dst", "state");
    require("node:fs").mkdirSync(srcStateDir, { recursive: true });
    require("node:fs").mkdirSync(dstStateDir, { recursive: true });
  });

  test("export then import yields the same event count", async () => {
    closeDb();
    const srcDb = openDb(join(srcStateDir, "accint.db"));
    runViews(srcDb);
    for (let i = 0; i < 4; i++) {
      emitEvent(srcDb, {
        kind: "directive_opened",
        substrate_origin: "owner",
        payload: { text: `t${i}` },
      });
    }
    const expectedCount = (srcDb.query("SELECT COUNT(*) AS c FROM events").get() as { c: number }).c;
    closeDb();

    const archive = join(tmpRoot, "snap.tar.gz");
    const exportResult = await runExport({
      archivePath: archive,
      mode: "live",
      stateDir: srcStateDir,
    });
    expect(exportResult.ok).toBe(true);
    expect(exportResult.eventCount).toBeGreaterThanOrEqual(expectedCount);
    expect(existsSync(archive)).toBe(true);

    // Import into the destination state dir (force=true since fresh dir).
    closeDb();
    const { env, out } = makeAdminEnvWithDb(openDb(":memory:"), {
      stateDbPath: join(dstStateDir, "accint.db"),
      currentSchemaVersion: exportResult.schemaVersion,
      auxBaseUrlProbe: () => null,
    });
    const code = await runAdmin(["import", archive, "--force"], env);
    expect(code).toBe(0);
    expect(out.join("\n")).toContain("import complete");

    // Verify event count survived.
    closeDb();
    const restored = openDb(join(dstStateDir, "accint.db"));
    const c = (restored.query("SELECT COUNT(*) AS c FROM events").get() as { c: number }).c;
    // The import path emits a state_imported event so the row count is
    // expectedCount + state_exported (from export) + state_imported.
    expect(c).toBeGreaterThanOrEqual(expectedCount);
    closeDb();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  test("import refuses on schema mismatch", async () => {
    closeDb();
    const srcDb = openDb(join(srcStateDir, "accint.db"));
    runViews(srcDb);
    // Force a schema_version stamp on the source so the export captures it.
    srcDb.run("INSERT INTO meta(key,value) VALUES('schema_version','7') ON CONFLICT(key) DO UPDATE SET value=excluded.value");
    closeDb();

    const archive = join(tmpRoot, "schema7.tar.gz");
    const exportResult = await runExport({
      archivePath: archive,
      mode: "live",
      stateDir: srcStateDir,
    });
    expect(exportResult.ok).toBe(true);
    expect(exportResult.schemaVersion).toBe("7");

    closeDb();
    const { env, err } = makeAdminEnvWithDb(openDb(":memory:"), {
      stateDbPath: join(dstStateDir, "accint.db"),
      currentSchemaVersion: "0", // mismatch
      auxBaseUrlProbe: () => null,
    });
    const code = await runAdmin(["import", archive, "--force"], env);
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("schema_mismatch");
    closeDb();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  test("export refuses when --cold and daemon is running", async () => {
    closeDb();
    const db = openDb(":memory:");
    const { env, err } = makeAdminEnvWithDb(db, {
      stateDbPath: join(srcStateDir, "accint.db"),
      auxBaseUrlProbe: () => "http://127.0.0.1:9999", // daemon "up"
    });
    const code = await runAdmin(["export", join(tmpRoot, "out.tar.gz"), "--cold"], env);
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("daemon is running");
    closeDb();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  test("import refuses while daemon is running unless --force", async () => {
    closeDb();
    const srcDb = openDb(join(srcStateDir, "accint.db"));
    runViews(srcDb);
    emitEvent(srcDb, { kind: "directive_opened", substrate_origin: "owner", payload: { text: "x" } });
    closeDb();
    const archive = join(tmpRoot, "snap.tar.gz");
    const r = await runExport({ archivePath: archive, mode: "live", stateDir: srcStateDir });
    expect(r.ok).toBe(true);
    closeDb();

    const { env, err } = makeAdminEnvWithDb(openDb(":memory:"), {
      stateDbPath: join(dstStateDir, "accint.db"),
      currentSchemaVersion: r.schemaVersion,
      auxBaseUrlProbe: () => "http://127.0.0.1:9999",
    });
    const code = await runAdmin(["import", archive], env);
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("daemon_running_refusing_without_force");
    closeDb();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  test("import refuses with missing archive", async () => {
    closeDb();
    const { env, err } = makeAdminEnvWithDb(openDb(":memory:"));
    const code = await runAdmin(["import", join(tmpRoot, "no-such.tar.gz")], env);
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("archive_missing");
    closeDb();
    rmSync(tmpRoot, { recursive: true, force: true });
  });
});

// ── usage banner ────────────────────────────────────────────────────

describe("usage banner includes Batch 3.ADMIN subcommands", () => {
  test("help text mentions every new surface", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const env: AdminEnv = {
      version: defaultVersionEnv(),
      stopDaemon: async () => false,
      startDaemon: async () => undefined,
      prompt: async () => "y",
      out: (line) => out.push(line),
      err: (line) => err.push(line),
      yes: false,
    };
    await runAdmin([], env);
    const joined = out.join("\n");
    for (const surface of [
      "export",
      "import",
      "rotate-admin-token",
      "rotate-external-token",
      "inspect-knowledge",
      "override-quarantine",
      "archive-rolling",
    ]) {
      expect(joined).toContain(surface);
    }
  });
});

void writeFileSync;
