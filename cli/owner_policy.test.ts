// `acc owner policy` tests — bare-command, empty-profile, seeded-profile,
// unknown-subcommand, --help. ACC2_DB_PATH is pinned per-test; events row
// seeded via prepared INSERT (mirrors substrate/extractors.test.ts).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, openDb } from "../substrate/db";
import { runOwnerPolicy } from "./owner_policy";

let dir = ""; let prevDb: string | undefined;

const cap = () => {
  const out: string[] = []; const err: string[] = [];
  const o = process.stdout.write.bind(process.stdout);
  const e = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((c: unknown) => { out.push(typeof c === "string" ? c : String(c)); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((c: unknown) => { err.push(typeof c === "string" ? c : String(c)); return true; }) as typeof process.stderr.write;
  return { out, err, restore: () => { process.stdout.write = o; process.stderr.write = e; } };
};

const seed = (dbPath: string, payload: Record<string, unknown>): void => {
  openDb(dbPath).prepare(
    `INSERT INTO events (id, ts, directive_id, task_id, loop_id, substrate_origin, kind, payload)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run("evt_owner_profile_test", new Date().toISOString(),
    "d_op_test", "t_op_test", "l_op_test", "substrate",
    "owner_profile_recorded", JSON.stringify(payload));
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "acc2-owner-policy-"));
  prevDb = process.env.ACC2_DB_PATH;
  process.env.ACC2_DB_PATH = join(dir, "policy.db");
});

afterEach(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
  if (prevDb === undefined) delete process.env.ACC2_DB_PATH; else process.env.ACC2_DB_PATH = prevDb;
});

describe("runOwnerPolicy", () => {
  test("bare `acc owner` prints usage hint and returns 0", async () => {
    const c = cap(); const code = await runOwnerPolicy([]); c.restore();
    expect(code).toBe(0);
    expect(c.out.join("")).toContain("usage: acc owner policy");
    expect(c.err.join("")).toBe("");
  });

  test("`acc owner policy` with no profile prints the bootstrap-policy section", async () => {
    openDb(process.env.ACC2_DB_PATH!);
    const c = cap(); const code = await runOwnerPolicy(["policy"]); c.restore();
    expect(code).toBe(0);
    expect(c.out.join("")).toContain("## OWNER PROFILE");
    expect(c.out.join("")).toContain("bootstrap_policy: sparse profile");
    expect(c.out.join("")).toContain("autonomy_score:");
  });

  test("`acc owner policy` renders the profile WITHOUT the removed vocabulary-mirroring (preferred_terms/avoided_terms subsystem deleted)", async () => {
    seed(process.env.ACC2_DB_PATH!, {
      detected_language: "es",
      preferred_terms: ["intent", "trajectory"],
      avoided_terms: ["leverage"],
    });
    const c = cap(); const code = await runOwnerPolicy(["policy"]); c.restore();
    expect(code).toBe(0);
    const out = c.out.join("");
    expect(out).toContain("## OWNER PROFILE");
    // detected_language still drives owner-facing language (universal path).
    expect(out).toContain("detected_language: es");
    // The owner-vocabulary subsystem was removed (owner directive: one
    // universal workflow; mirroring the owner's own words degraded deliverable
    // quality). preferred_terms/avoided_terms are no longer rendered or mirrored.
    expect(out).not.toContain("preferred_terms");
    expect(out).not.toContain("avoided_terms");
  });

  test("unknown subcommand prints to stderr and returns 1", async () => {
    const c = cap(); const code = await runOwnerPolicy(["snorgle"]); c.restore();
    expect(code).toBe(1);
    expect(c.err.join("")).toContain("unknown subcommand 'snorgle'");
    expect(c.err.join("")).toContain("usage: acc owner policy");
  });

  test("`acc owner --help` prints the help block and returns 0", async () => {
    const c = cap(); const code = await runOwnerPolicy(["--help"]); c.restore();
    expect(code).toBe(0);
    const out = c.out.join("");
    expect(out).toContain("acc owner — owner profile");
    expect(out).toContain("Subcommands:");
    expect(out).toContain("policy");
  });
});
