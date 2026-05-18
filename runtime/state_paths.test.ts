// runtime/state_paths.test.ts — covers the shared path resolver: the
// ACC2_STATE_DIR env-var branch (vs default) and socket/token/db
// precedence.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  resolveDbPath, resolveSocketFile, resolveStateDir,
  resolveStateDirVerbose, resolveTokenFile,
} from "./state_paths";

let prevStateDir: string | undefined;
let prevSocketFile: string | undefined;
let prevTokenFile: string | undefined;
let prevDbPath: string | undefined;

beforeEach(() => {
  prevStateDir = process.env.ACC2_STATE_DIR;
  prevSocketFile = process.env.ACC2_SOCKET_FILE;
  prevTokenFile = process.env.ACC2_TOKEN_FILE;
  prevDbPath = process.env.ACC2_DB_PATH;
  delete process.env.ACC2_STATE_DIR;
  delete process.env.ACC2_SOCKET_FILE;
  delete process.env.ACC2_TOKEN_FILE;
  delete process.env.ACC2_DB_PATH;
});

afterEach(() => {
  if (prevStateDir === undefined) delete process.env.ACC2_STATE_DIR;
  else process.env.ACC2_STATE_DIR = prevStateDir;
  if (prevSocketFile === undefined) delete process.env.ACC2_SOCKET_FILE;
  else process.env.ACC2_SOCKET_FILE = prevSocketFile;
  if (prevTokenFile === undefined) delete process.env.ACC2_TOKEN_FILE;
  else process.env.ACC2_TOKEN_FILE = prevTokenFile;
  if (prevDbPath === undefined) delete process.env.ACC2_DB_PATH;
  else process.env.ACC2_DB_PATH = prevDbPath;
});

describe("resolveStateDirVerbose — env-var precedence", () => {
  test("ACC2_STATE_DIR wins when set", () => {
    process.env.ACC2_STATE_DIR = "/tmp/state-from-acc2";
    const res = resolveStateDirVerbose();
    expect(res.dir).toBe("/tmp/state-from-acc2");
    expect(res.source).toBe("ACC2_STATE_DIR");
  });

  test("falls back to ~/.accint when unset", () => {
    const res = resolveStateDirVerbose();
    expect(res.dir).toBe(join(homedir(), ".accint"));
    expect(res.source).toBe(null);
  });

  test("treats empty-string ACC2_STATE_DIR as unset", () => {
    process.env.ACC2_STATE_DIR = "";
    const res = resolveStateDirVerbose();
    expect(res.dir).toBe(join(homedir(), ".accint"));
    expect(res.source).toBe(null);
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

  test("ACC2_DB_PATH wins over ACC2_STATE_DIR", () => {
    process.env.ACC2_STATE_DIR = "/tmp/dir";
    process.env.ACC2_DB_PATH = "/tmp/custom.db";
    expect(resolveDbPath()).toBe("/tmp/custom.db");
  });

  test("dbPath = ${ACC2_STATE_DIR}/state.db when set", () => {
    process.env.ACC2_STATE_DIR = "/tmp/dir";
    expect(resolveDbPath()).toBe("/tmp/dir/state.db");
  });

  test("dbPath falls back to ~/.accint/state.db when no env is set", () => {
    expect(resolveDbPath()).toBe(join(homedir(), ".accint", "state.db"));
  });

  test("resolvers re-read env on every call (lazy semantics)", () => {
    process.env.ACC2_STATE_DIR = "/tmp/first";
    expect(resolveSocketFile()).toBe("/tmp/first/v2.sock");
    process.env.ACC2_STATE_DIR = "/tmp/second";
    expect(resolveSocketFile()).toBe("/tmp/second/v2.sock");
  });
});
