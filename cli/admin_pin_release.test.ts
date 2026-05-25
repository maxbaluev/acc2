import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../substrate/db";
import { defaultVersionEnv } from "../runtime/opencode_version";
import type { PinataClient } from "../runtime/pinata_client";
import { runAdmin } from "./admin";
import { runPinReleaseCmd } from "./admin_pin_release";

function fakeClient(calls: unknown[] = []): PinataClient {
  return {
    configured: () => true,
    pinFile: async (path, opts) => {
      calls.push({ method: "pinFile", path, opts });
      return { ok: true, cid: "bafyBUNDLE", bytes: 12 };
    },
    pinJson: async (obj, opts) => {
      calls.push({ method: "pinJson", obj, opts });
      return { ok: true, cid: "bafyMETA" };
    },
    fetchByCid: async () => ({ ok: false, error: "unused" }),
    listPins: async () => ({ ok: true, pins: [] }),
  };
}

describe("acc admin pin-release", () => {
  test("requires approval before checking Pinata or the filesystem", async () => {
    const err: string[] = [];
    const code = await runPinReleaseCmd(["/tmp/nope"], { out: () => {}, err: (line) => err.push(line), yes: false });
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("missing --yes");
  });

  test("pins a file, pins metadata JSON, and records release metadata in the ledger", async () => {
    const root = mkdtempSync(join(tmpdir(), "acc2-pin-release-"));
    const bundle = join(root, "release.tar.gz");
    writeFileSync(bundle, "release-data");
    const manifest = join(root, "manifest.json");
    writeFileSync(manifest, JSON.stringify({ manifest_version: 1, release_version: "1.2.3" }));
    const db = openDb(":memory:");
    const calls: unknown[] = [];
    const out: string[] = [];

    const code = await runPinReleaseCmd([
      bundle,
      "--version", "1.2.3",
      "--channel", "beta",
      "--manifest", manifest,
      "--yes",
    ], {
      out: (line) => out.push(line),
      err: (line) => out.push(`ERR:${line}`),
      yes: false,
      openSubstrate: () => db,
      pinataClient: fakeClient(calls),
      nowIso: () => "2026-05-25T00:00:00.000Z",
    });

    expect(code).toBe(0);
    expect(out.join("\n")).toContain("bafyBUNDLE");
    expect(calls).toHaveLength(2);
    const row = db.query("SELECT payload FROM events WHERE kind = 'state_exported' ORDER BY ts DESC LIMIT 1").get() as { payload: string };
    const payload = JSON.parse(row.payload);
    expect(payload.mode).toBe("release_pin");
    expect(payload.release_version).toBe("1.2.3");
    expect(payload.channel).toBe("beta");
    expect(payload.bundle_cid).toBe("bafyBUNDLE");
    expect(payload.metadata_cid).toBe("bafyMETA");
    expect(payload.pubsub.implemented).toBe(false);
  });

  test("admin dispatcher routes pin-release with injected Pinata client", async () => {
    const root = mkdtempSync(join(tmpdir(), "acc2-pin-release-route-"));
    const bundle = join(root, "release.bin");
    writeFileSync(bundle, "release-data");
    const db = openDb(":memory:");
    const out: string[] = [];
    const err: string[] = [];
    const code = await runAdmin(["pin-release", bundle, "--version", "2.0.0", "--yes"], {
      version: { ...defaultVersionEnv(), spawn: () => ({ status: 0, stdout: "", stderr: "" }) },
      stopDaemon: async () => false,
      startDaemon: async () => undefined,
      prompt: async () => "y",
      out: (line) => out.push(line),
      err: (line) => err.push(line),
      yes: false,
      openSubstrate: () => db,
      pinataClient: fakeClient(),
    });
    expect(code).toBe(0);
    expect(out.join("\n")).toContain("pin-release complete");
    expect(err).toEqual([]);
  });
});
