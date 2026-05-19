// `acc artifact provenance` CLI tests. Covers tree render + JSON,
// prefix resolution, and the supersedes chain fixture smoke surface.

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { closeDb, openDb } from "../substrate/db";
import { runArtifact } from "./artifact";
import {
  seedDriveDocProvenanceFixture,
  FIXTURE_DRIVE_DOC_PROVENANCE_HEAD_ID,
} from "../tests/fixtures/drive_doc_provenance";

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

describe("acc artifact provenance — fixture chain", () => {
  test("pretty render lists 4 nodes with v4 at HEAD and lost_version_count=3", async () => {
    const { db, out, env } = collectEnv();
    seedDriveDocProvenanceFixture(db);
    const code = await runArtifact(["provenance", FIXTURE_DRIVE_DOC_PROVENANCE_HEAD_ID], env);
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
    expect(combined).toContain(FIXTURE_DRIVE_DOC_PROVENANCE_HEAD_ID);
    expect(combined).toContain("[TRASHED]");
    expect(combined).toContain("Drive doc fixture v4 (current)");
  });

  test("--json emits structured JSON the orchestrator can consume", async () => {
    const { db, out, env } = collectEnv();
    seedDriveDocProvenanceFixture(db);
    const code = await runArtifact(["provenance", FIXTURE_DRIVE_DOC_PROVENANCE_HEAD_ID, "--json"], env);
    expect(code).toBe(0);
    const parsed = JSON.parse(out.join("\n"));
    expect(parsed.head.artifact_id).toBe(FIXTURE_DRIVE_DOC_PROVENANCE_HEAD_ID);
    expect(parsed.ancestors.length).toBe(3);
    expect(parsed.descendants.length).toBe(0);
    expect(parsed.lost_version_count).toBe(3);
  });
});

describe("acc artifact provenance — prefix resolution + errors", () => {
  test("resolves a prefix >= 6 chars", async () => {
    const { db, out, env } = collectEnv();
    seedDriveDocProvenanceFixture(db);
    const code = await runArtifact(["provenance", "fixture_drive_doc_v4"], env);
    expect(code).toBe(0);
    expect(out.join("\n")).toContain(FIXTURE_DRIVE_DOC_PROVENANCE_HEAD_ID);
  });

  test("refuses short prefixes (< 6 chars)", async () => {
    const { db, env, err } = collectEnv();
    seedDriveDocProvenanceFixture(db);
    const code = await runArtifact(["provenance", "fix"], env);
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("artifact not found");
  });

  test("flags ambiguous prefixes when multiple ids match", async () => {
    const { db, env, err } = collectEnv();
    seedDriveDocProvenanceFixture(db);
    const code = await runArtifact(["provenance", "fixture_drive_doc_v"], env);
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
