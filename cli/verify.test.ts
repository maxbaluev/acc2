// `acc verify` tests — empty directive, applied+verified, missing commit,
// drift (commit exists but doesn't touch target), stranded proposal.
// ACC2_DB_PATH is pinned per test; git operations run in an ephemeral
// repo created under tmpdir.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, openDb } from "../substrate/db";
import { runVerify } from "./verify";

const cap = () => {
  const out: string[] = []; const err: string[] = [];
  const o = process.stdout.write.bind(process.stdout);
  const e = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((c: unknown) => { out.push(typeof c === "string" ? c : String(c)); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((c: unknown) => { err.push(typeof c === "string" ? c : String(c)); return true; }) as typeof process.stderr.write;
  return { out, err, restore: () => { process.stdout.write = o; process.stderr.write = e; } };
};

const DIRECTIVE_ID = "d_verify_test_0000abcd";

const seedProposal = (db: import("bun:sqlite").Database, id: string, payload: Record<string, unknown>): void => {
  db.run(
    `INSERT INTO events (id, ts, directive_id, task_id, loop_id, substrate_origin, kind, payload, context_refs)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, new Date().toISOString(), DIRECTIVE_ID, "t_v", "l_v", "test",
      "contract_amendment_proposed", JSON.stringify(payload), "[]"],
  );
};

const seedApply = (db: import("bun:sqlite").Database, id: string, sourceId: string, payload: Record<string, unknown>): void => {
  db.run(
    `INSERT INTO events (id, ts, directive_id, task_id, loop_id, substrate_origin, kind, payload, context_refs)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, new Date().toISOString(), DIRECTIVE_ID, "t_v", "l_v", "test",
      "contract_amendment_applied", JSON.stringify({ source_event_id: sourceId, ...payload }), JSON.stringify([sourceId])],
  );
};

const seedDirectiveOpened = (db: import("bun:sqlite").Database): void => {
  db.run(
    `INSERT INTO events (id, ts, directive_id, task_id, loop_id, substrate_origin, kind, payload)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ["evt_open", new Date().toISOString(), DIRECTIVE_ID, "t_root", "l_v", "test", "directive_opened", "{}"],
  );
};

let dir = ""; let repoRoot = ""; let prevDb: string | undefined;

const initRepoWithCommit = (target: string, afterText: string): string => {
  const root = mkdtempSync(join(tmpdir(), "acc2-verify-repo-"));
  spawnSync("git", ["init", "-q"], { cwd: root });
  spawnSync("git", ["config", "user.email", "verify@test"], { cwd: root });
  spawnSync("git", ["config", "user.name", "verify"], { cwd: root });
  spawnSync("git", ["config", "commit.gpgsign", "false"], { cwd: root });
  writeFileSync(join(root, target), `seed\n`);
  spawnSync("git", ["add", target], { cwd: root });
  spawnSync("git", ["commit", "-q", "-m", "seed"], { cwd: root });
  writeFileSync(join(root, target), `seed\n${afterText}\n`);
  spawnSync("git", ["add", target], { cwd: root });
  spawnSync("git", ["commit", "-q", "-m", "apply"], { cwd: root });
  const sha = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout?.toString().trim() ?? "";
  return `${root}::${sha}`;
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "acc2-verify-"));
  prevDb = process.env.ACC2_DB_PATH;
  process.env.ACC2_DB_PATH = join(dir, "verify.db");
  openDb(process.env.ACC2_DB_PATH);
});

afterEach(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
  if (repoRoot) { try { rmSync(repoRoot, { recursive: true, force: true }); } catch { /* ignore */ } repoRoot = ""; }
  if (prevDb === undefined) delete process.env.ACC2_DB_PATH; else process.env.ACC2_DB_PATH = prevDb;
});

describe("runVerify", () => {
  test("empty directive prints all-zero counts and returns 0", async () => {
    const db = openDb(process.env.ACC2_DB_PATH!);
    seedDirectiveOpened(db);
    const c = cap(); const code = await runVerify([DIRECTIVE_ID]); c.restore();
    expect(code).toBe(0);
    const text = c.out.join("");
    expect(text).toContain(`directive: ${DIRECTIVE_ID}`);
    expect(text).toContain("amendments: 0 total");
    expect(text).toContain("applied:  0");
    expect(text).toContain("stranded: 0");
    expect(text).toContain("verified: 0");
  });

  test("applied proposal with matching commit_sha + content → verified=1, exit 0", async () => {
    const target = "verify_target.txt";
    const afterText = "ANCHOR_AFTER_LINE_XYZ";
    const parts = initRepoWithCommit(target, afterText);
    repoRoot = parts.split("::")[0]!;
    const sha = parts.split("::")[1]!;
    const db = openDb(process.env.ACC2_DB_PATH!);
    seedDirectiveOpened(db);
    seedProposal(db, "evt_prop_1", {
      target_resource: `repo:${target}`,
      proposed_behavior: { target_resource: `repo:${target}`, anchor: "anchor1", diff: { kind: "anchored_replace_v1", before: "seed", after: afterText } },
    });
    seedApply(db, "evt_app_1", "evt_prop_1", { status: "applied", commit_sha: sha });
    const c = cap(); const code = await runVerify([DIRECTIVE_ID, "--repo", repoRoot]); c.restore();
    expect(code).toBe(0);
    const text = c.out.join("");
    expect(text).toContain("applied:  1");
    expect(text).toContain("verified: 1");
    expect(text).toContain("drift:    0");
    expect(text).toContain("missing:  0");
    expect(text).toContain(sha.slice(0, 10));
  });

  test("applied with commit_sha NOT in git → missing=1, exit 2", async () => {
    repoRoot = mkdtempSync(join(tmpdir(), "acc2-verify-empty-"));
    spawnSync("git", ["init", "-q"], { cwd: repoRoot });
    const db = openDb(process.env.ACC2_DB_PATH!);
    seedDirectiveOpened(db);
    seedProposal(db, "evt_prop_2", {
      target_resource: "repo:nofile.txt",
      proposed_behavior: { target_resource: "repo:nofile.txt", anchor: "x", diff: { kind: "anchored_replace_v1", before: "a", after: "b" } },
    });
    seedApply(db, "evt_app_2", "evt_prop_2", { status: "applied", commit_sha: "deadbeefcafe" });
    const c = cap(); const code = await runVerify([DIRECTIVE_ID, "--repo", repoRoot]); c.restore();
    expect(code).toBe(2);
    expect(c.out.join("")).toContain("missing:  1");
  });

  test("applied with sha in git but doesn't touch target → drift=1, exit 2", async () => {
    const target = "real.txt";
    const parts = initRepoWithCommit(target, "REAL_AFTER");
    repoRoot = parts.split("::")[0]!;
    const sha = parts.split("::")[1]!;
    const db = openDb(process.env.ACC2_DB_PATH!);
    seedDirectiveOpened(db);
    seedProposal(db, "evt_prop_3", {
      target_resource: "repo:OTHER_FILE_NOT_TOUCHED.txt",
      proposed_behavior: { target_resource: "repo:OTHER_FILE_NOT_TOUCHED.txt", anchor: "x", diff: { kind: "anchored_replace_v1", before: "a", after: "b" } },
    });
    seedApply(db, "evt_app_3", "evt_prop_3", { status: "applied", commit_sha: sha });
    const c = cap(); const code = await runVerify([DIRECTIVE_ID, "--repo", repoRoot]); c.restore();
    expect(code).toBe(2);
    expect(c.out.join("")).toContain("drift:    1");
  });

  test("proposal with no matching contract_amendment_applied → stranded=1, exit 1", async () => {
    const db = openDb(process.env.ACC2_DB_PATH!);
    seedDirectiveOpened(db);
    seedProposal(db, "evt_prop_4", {
      target_resource: "repo:stranded.txt",
      anchor: "stranded_anchor_that_is_longer_than_thirty_chars_yes",
      proposed_behavior: { target_resource: "repo:stranded.txt", anchor: "a", diff: { kind: "anchored_replace_v1", before: "x", after: "y" } },
    });
    repoRoot = mkdtempSync(join(tmpdir(), "acc2-verify-no-repo-"));
    spawnSync("git", ["init", "-q"], { cwd: repoRoot });
    const c = cap(); const code = await runVerify([DIRECTIVE_ID, "--repo", repoRoot]); c.restore();
    expect(code).toBe(1);
    const text = c.out.join("");
    expect(text).toContain("stranded: 1");
    expect(text).toContain("evt_prop_4");
    expect(text).toContain("repo:stranded.txt");
  });
});
