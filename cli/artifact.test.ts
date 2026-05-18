// `acc artifact provenance` CLI tests (C5,
// HJJS1665H961B2SRYHC5J85D14, 2026-05-18). Covers tree render + JSON,
// prefix resolution, and the Lakeland backfill smoke surface.

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { closeDb, openDb } from "../substrate/db";
import { runArtifact } from "./artifact";
import {
  seedLakelandDriveProvenance,
  LAKELAND_PROVENANCE_HEAD_ID,
} from "../substrate/seed";

afterAll(() => closeDb());
beforeEach(() => closeDb());

const collectEnv = () => {
  const out: string[] = [];
  const err: string[] = [];
  const db = openDb(":memory:");
  return {
    db,
    out,
    err,
    env: {
      out: (s: string) => out.push(s),
      err: (s: string) => err.push(s),
      openSubstrate: () => db,
      color: false,
    },
  };
};

describe("acc artifact provenance — Lakeland chain", () => {
  test("pretty render lists 4 nodes with v7 at HEAD and lost_version_count=3", async () => {
    const { db, out, env } = collectEnv();
    seedLakelandDriveProvenance(db);
    const code = await runArtifact(["provenance", LAKELAND_PROVENANCE_HEAD_ID], env);
    expect(code).toBe(0);
    const combined = out.join("\n");
    expect(combined).toContain("acc artifact provenance — supersedes chain");
    expect(combined).toContain("lost_version_count : 3");
    // Each Drive doc id is rendered, plus the head id (12-char prefix
    // truncation in the chain rows; the head_artifact_id header line
    // carries the full id).
    expect(combined).toContain("12-3Mv4u0RF8x1");
    expect(combined).toContain("1dzcacsEVA9LFy");
    expect(combined).toContain("11nw_4-28eoab0");
    expect(combined).toContain(LAKELAND_PROVENANCE_HEAD_ID);
    expect(combined).toContain("[TRASHED]");
    expect(combined).toContain("Lakeland ATMS report v7 (current)");
  });

  test("--json emits structured JSON the orchestrator can consume", async () => {
    const { db, out, env } = collectEnv();
    seedLakelandDriveProvenance(db);
    const code = await runArtifact(["provenance", LAKELAND_PROVENANCE_HEAD_ID, "--json"], env);
    expect(code).toBe(0);
    const parsed = JSON.parse(out.join("\n"));
    expect(parsed.head.artifact_id).toBe(LAKELAND_PROVENANCE_HEAD_ID);
    expect(parsed.ancestors.length).toBe(3);
    expect(parsed.descendants.length).toBe(0);
    expect(parsed.lost_version_count).toBe(3);
  });
});

describe("acc artifact provenance — prefix resolution + errors", () => {
  test("resolves a prefix >= 6 chars", async () => {
    const { db, out, env } = collectEnv();
    seedLakelandDriveProvenance(db);
    const code = await runArtifact(["provenance", "seed_lakeland_drive_doc_v7"], env);
    expect(code).toBe(0);
    expect(out.join("\n")).toContain(LAKELAND_PROVENANCE_HEAD_ID);
  });

  test("refuses short prefixes (< 6 chars)", async () => {
    const { db, env, err } = collectEnv();
    seedLakelandDriveProvenance(db);
    const code = await runArtifact(["provenance", "see"], env);
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("artifact not found");
  });

  test("flags ambiguous prefixes when multiple ids match", async () => {
    const { db, env, err } = collectEnv();
    seedLakelandDriveProvenance(db);
    const code = await runArtifact(["provenance", "seed_lakeland_drive_doc_v"], env);
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("ambiguous");
  });

  test("missing argument prints usage to stderr and exits 1", async () => {
    const { env, err } = collectEnv();
    const code = await runArtifact(["provenance"], env);
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("missing <artifact_id_or_prefix>");
  });

  test("unknown subcommand prints usage + exits 1", async () => {
    const { env, err } = collectEnv();
    const code = await runArtifact(["nuke"], env);
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("unknown subcommand");
  });
});
