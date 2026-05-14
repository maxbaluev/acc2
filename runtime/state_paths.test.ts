// runtime/state_paths.test.ts — covers the shared path resolver: each
// env-var branch (ACC2_STATE_DIR / ACCINT_HOME / default), socket/token/
// db precedence, the legacy → canonical layout migration, and the
// ACCINT_HOME deprecation warn-once contract.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, openDb } from "../substrate/db";
import {
  _resetDeprecationLatchForTests, maybeWarnAccintHomeDeprecated,
  migrateLegacyLayout, resolveDbPath, resolveSocketFile, resolveStateDir,
  resolveStateDirVerbose, resolveTokenFile,
} from "./state_paths";

let prevStateDir: string | undefined;
let prevAccintHome: string | undefined;
let prevSocketFile: string | undefined;
let prevTokenFile: string | undefined;
let prevDbPath: string | undefined;

beforeEach(() => {
  prevStateDir = process.env.ACC2_STATE_DIR;
  prevAccintHome = process.env.ACCINT_HOME;
  prevSocketFile = process.env.ACC2_SOCKET_FILE;
  prevTokenFile = process.env.ACC2_TOKEN_FILE;
  prevDbPath = process.env.ACC2_DB_PATH;
  delete process.env.ACC2_STATE_DIR;
  delete process.env.ACCINT_HOME;
  delete process.env.ACC2_SOCKET_FILE;
  delete process.env.ACC2_TOKEN_FILE;
  delete process.env.ACC2_DB_PATH;
  _resetDeprecationLatchForTests();
});

afterEach(() => {
  if (prevStateDir === undefined) delete process.env.ACC2_STATE_DIR;
  else process.env.ACC2_STATE_DIR = prevStateDir;
  if (prevAccintHome === undefined) delete process.env.ACCINT_HOME;
  else process.env.ACCINT_HOME = prevAccintHome;
  if (prevSocketFile === undefined) delete process.env.ACC2_SOCKET_FILE;
  else process.env.ACC2_SOCKET_FILE = prevSocketFile;
  if (prevTokenFile === undefined) delete process.env.ACC2_TOKEN_FILE;
  else process.env.ACC2_TOKEN_FILE = prevTokenFile;
  if (prevDbPath === undefined) delete process.env.ACC2_DB_PATH;
  else process.env.ACC2_DB_PATH = prevDbPath;
});

describe("resolveStateDirVerbose — env-var precedence", () => {
  test("ACC2_STATE_DIR wins over everything", () => {
    process.env.ACC2_STATE_DIR = "/tmp/state-from-acc2";
    process.env.ACCINT_HOME = "/tmp/state-from-legacy";
    const res = resolveStateDirVerbose();
    expect(res.dir).toBe("/tmp/state-from-acc2");
    expect(res.source).toBe("ACC2_STATE_DIR");
  });

  test("ACCINT_HOME wins when ACC2_STATE_DIR is unset", () => {
    process.env.ACCINT_HOME = "/tmp/state-from-legacy";
    const res = resolveStateDirVerbose();
    expect(res.dir).toBe("/tmp/state-from-legacy");
    expect(res.source).toBe("ACCINT_HOME");
  });

  test("falls back to ~/.accint when neither is set", () => {
    const res = resolveStateDirVerbose();
    expect(res.dir).toBe(join(homedir(), ".accint"));
    expect(res.source).toBe(null);
  });

  test("treats empty-string env vars as unset", () => {
    process.env.ACC2_STATE_DIR = "";
    process.env.ACCINT_HOME = "/tmp/legacy";
    const res = resolveStateDirVerbose();
    expect(res.dir).toBe("/tmp/legacy");
    expect(res.source).toBe("ACCINT_HOME");
  });

  test("resolveStateDir returns the same string", () => {
    process.env.ACC2_STATE_DIR = "/tmp/x";
    expect(resolveStateDir()).toBe("/tmp/x");
  });
});

describe("resolveSocketFile / resolveTokenFile / resolveDbPath", () => {
  test("each env-var override wins independently of the others", () => {
    process.env.ACC2_STATE_DIR = "/tmp/dir";
    process.env.ACC2_SOCKET_FILE = "/tmp/custom.sock";
    expect(resolveSocketFile()).toBe("/tmp/custom.sock");
    // token still inherits ACC2_STATE_DIR
    expect(resolveTokenFile()).toBe("/tmp/dir/v2.sock.token");
  });

  test("ACC2_TOKEN_FILE wins over ACC2_STATE_DIR", () => {
    process.env.ACC2_STATE_DIR = "/tmp/dir";
    process.env.ACC2_TOKEN_FILE = "/tmp/custom.token";
    expect(resolveTokenFile()).toBe("/tmp/custom.token");
    expect(resolveSocketFile()).toBe("/tmp/dir/v2.sock");
  });

  test("ACC2_DB_PATH wins over ACC2_STATE_DIR and over the repo fallback", () => {
    process.env.ACC2_STATE_DIR = "/tmp/dir";
    process.env.ACC2_DB_PATH = "/tmp/custom.db";
    expect(resolveDbPath("/repo-root")).toBe("/tmp/custom.db");
  });

  test("dbPath = ${ACC2_STATE_DIR}/state.db when set", () => {
    process.env.ACC2_STATE_DIR = "/tmp/dir";
    expect(resolveDbPath("/repo-root")).toBe("/tmp/dir/state.db");
  });

  test("dbPath = ${ACCINT_HOME}/state.db when only the legacy env is set", () => {
    process.env.ACCINT_HOME = "/tmp/legacy";
    expect(resolveDbPath("/repo-root")).toBe("/tmp/legacy/state.db");
  });

  test("dbPath falls back to <repo>/state/accint.db when no env is set", () => {
    expect(resolveDbPath("/repo-root")).toBe("/repo-root/state/accint.db");
  });

  test("resolvers re-read env on every call (lazy semantics)", () => {
    process.env.ACC2_STATE_DIR = "/tmp/first";
    expect(resolveSocketFile()).toBe("/tmp/first/v2.sock");
    process.env.ACC2_STATE_DIR = "/tmp/second";
    expect(resolveSocketFile()).toBe("/tmp/second/v2.sock");
  });
});

describe("migrateLegacyLayout", () => {
  let tmpRoot = "";

  beforeEach(() => { tmpRoot = mkdtempSync(join(tmpdir(), "acc2-mig-")); });
  afterEach(() => { rmSync(tmpRoot, { recursive: true, force: true }); });

  test("returns {migrated:false} when no legacy `state/` dir exists", () => {
    const res = migrateLegacyLayout(tmpRoot, null);
    expect(res.migrated).toBe(false);
    expect(res.renamed).toEqual([]);
  });

  test("moves v2.sock.token from legacy state/ subdir to flat canonical layout", () => {
    const legacyDir = join(tmpRoot, "state");
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(join(legacyDir, "v2.sock.token"), '{"admin_token":"abc"}');
    const res = migrateLegacyLayout(tmpRoot, null);
    expect(res.migrated).toBe(true);
    expect(res.renamed.length).toBe(1);
    expect(existsSync(join(tmpRoot, "v2.sock.token"))).toBe(true);
    expect(existsSync(join(legacyDir, "v2.sock.token"))).toBe(false);
  });

  test("renames accint.db -> state.db so canonical resolver finds it", () => {
    const legacyDir = join(tmpRoot, "state");
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(join(legacyDir, "accint.db"), "fake sqlite payload");
    const res = migrateLegacyLayout(tmpRoot, null);
    expect(res.migrated).toBe(true);
    expect(existsSync(join(tmpRoot, "state.db"))).toBe(true);
    expect(existsSync(join(legacyDir, "accint.db"))).toBe(false);
  });

  test("does NOT clobber a canonical file that already exists", () => {
    const legacyDir = join(tmpRoot, "state");
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(join(legacyDir, "v2.sock.token"), '{"admin_token":"legacy"}');
    writeFileSync(join(tmpRoot, "v2.sock.token"), '{"admin_token":"canonical"}');
    const res = migrateLegacyLayout(tmpRoot, null);
    // The legacy file is skipped — canonical wins.
    expect(res.renamed.length).toBe(0);
    expect(existsSync(join(legacyDir, "v2.sock.token"))).toBe(true);
  });

  test("emits a cli_layout_migrated event when a DB is provided", () => {
    const legacyDir = join(tmpRoot, "state");
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(join(legacyDir, "v2.sock"), "{}");
    const dbPath = join(tmpRoot, "audit.db");
    const db = openDb(dbPath);
    try {
      const res = migrateLegacyLayout(tmpRoot, db);
      expect(res.migrated).toBe(true);
      const row = db
        .query("SELECT COUNT(*) AS n FROM events WHERE kind = 'cli_layout_migrated'")
        .get() as { n: number };
      expect(row.n).toBe(1);
    } finally { closeDb(dbPath); }
  });

  test("is idempotent: a second call after a successful migration is a no-op", () => {
    const legacyDir = join(tmpRoot, "state");
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(join(legacyDir, "v2.sock"), "{}");
    const first = migrateLegacyLayout(tmpRoot, null);
    expect(first.migrated).toBe(true);
    const second = migrateLegacyLayout(tmpRoot, null);
    // The legacy dir is still empty; the rename above moved the only file
    // out. We do NOT remove the empty `state/` dir as part of the
    // migration, so existsSync(legacyDir) is true; but no files inside
    // means no renames.
    expect(second.migrated).toBe(false);
  });
});

describe("maybeWarnAccintHomeDeprecated", () => {
  let tmpRoot = "";
  let dbPath = "";

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "acc2-dep-"));
    dbPath = join(tmpRoot, "audit.db");
  });
  afterEach(() => {
    closeDb(dbPath);
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  test("emits the deprecation_warning_emitted event exactly once per process", () => {
    process.env.ACCINT_HOME = "/tmp/legacy";
    const db = openDb(dbPath);
    maybeWarnAccintHomeDeprecated(db);
    maybeWarnAccintHomeDeprecated(db);
    maybeWarnAccintHomeDeprecated(db);
    const row = db
      .query("SELECT COUNT(*) AS n FROM events WHERE kind = 'deprecation_warning_emitted'")
      .get() as { n: number };
    expect(row.n).toBe(1);
  });

  test("does NOT emit when ACC2_STATE_DIR is the source", () => {
    process.env.ACC2_STATE_DIR = "/tmp/canonical";
    process.env.ACCINT_HOME = "/tmp/legacy"; // also set — should be IGNORED
    const db = openDb(dbPath);
    maybeWarnAccintHomeDeprecated(db);
    const row = db
      .query("SELECT COUNT(*) AS n FROM events WHERE kind = 'deprecation_warning_emitted'")
      .get() as { n: number };
    expect(row.n).toBe(0);
  });

  test("payload identifies the deprecated key and the canonical replacement", () => {
    process.env.ACCINT_HOME = "/tmp/legacy";
    const db = openDb(dbPath);
    maybeWarnAccintHomeDeprecated(db);
    const row = db
      .query("SELECT payload FROM events WHERE kind = 'deprecation_warning_emitted' LIMIT 1")
      .get() as { payload: string };
    const payload = JSON.parse(row.payload) as { key?: string; canonical?: string };
    expect(payload.key).toBe("ACCINT_HOME");
    expect(payload.canonical).toBe("ACC2_STATE_DIR");
  });

  test("warn-once latch survives the absence of a DB handle", () => {
    process.env.ACCINT_HOME = "/tmp/legacy";
    // First call: no DB — only the logger.warn happens. Latch flips.
    maybeWarnAccintHomeDeprecated(null);
    // Second call with a DB: the latch is already set, so no event lands.
    const db = openDb(dbPath);
    maybeWarnAccintHomeDeprecated(db);
    const row = db
      .query("SELECT COUNT(*) AS n FROM events WHERE kind = 'deprecation_warning_emitted'")
      .get() as { n: number };
    expect(row.n).toBe(0);
  });
});
