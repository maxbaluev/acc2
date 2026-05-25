import { describe, expect, test } from "bun:test";
import {
  parseReleaseSource,
  resolveReleaseSource,
  type ReleaseSource,
} from "./release_source";

describe("parseReleaseSource", () => {
  test("rejects the removed git update path", () => {
    expect(parseReleaseSource("git")).toEqual({ error: "release_source_unrecognized_spec" });
  });

  test("parses an ipfs CID spec (no gateway)", () => {
    expect(parseReleaseSource("ipfs:bafyabc123")).toEqual({
      kind: "ipfs_cid",
      cid: "bafyabc123",
    });
  });

  test("parses an ipfs CID spec with an explicit gateway", () => {
    expect(parseReleaseSource("ipfs:bafyabc123@https://gateway.pinata.cloud")).toEqual({
      kind: "ipfs_cid",
      cid: "bafyabc123",
      gateway: "https://gateway.pinata.cloud",
    });
  });

  test("parses the reserved future pubsub seam into a real source", () => {
    expect(parseReleaseSource("pubsub:01HEVENTIDXYZ")).toEqual({
      kind: "pubsub_announcement",
      announcement_event_id: "01HEVENTIDXYZ",
    });
  });

  test("trims surrounding whitespace", () => {
    expect(parseReleaseSource("  ipfs:bafyabc123  ")).toEqual({ kind: "ipfs_cid", cid: "bafyabc123" });
  });

  test("rejects an empty spec", () => {
    expect(parseReleaseSource("")).toEqual({ error: "release_source_empty_spec" });
    expect(parseReleaseSource("   ")).toEqual({ error: "release_source_empty_spec" });
  });

  test("rejects an ipfs spec with no CID", () => {
    expect(parseReleaseSource("ipfs:")).toEqual({
      error: "release_source_missing_cid",
    });
  });

  test("rejects a pubsub spec with no event id", () => {
    expect(parseReleaseSource("pubsub:")).toEqual({
      error: "release_source_missing_announcement_event_id",
    });
  });

  test("rejects an unrecognized spec", () => {
    expect(parseReleaseSource("ftp://nope")).toEqual({
      error: "release_source_unrecognized_spec",
    });
  });
});

describe("resolveReleaseSource", () => {

  test("ipfs_cid resolves through unchanged", () => {
    const src: ReleaseSource = { kind: "ipfs_cid", cid: "bafyabc123" };
    expect(resolveReleaseSource(src)).toEqual(src);
  });

  test("pubsub parses but does NOT resolve — reserved seam", () => {
    const parsed = parseReleaseSource("pubsub:01HEVENTIDXYZ");
    // parse succeeds
    expect(parsed).toEqual({
      kind: "pubsub_announcement",
      announcement_event_id: "01HEVENTIDXYZ",
    });
    // resolve is gated
    expect(resolveReleaseSource(parsed as ReleaseSource)).toEqual({
      error: "pubsub_source_not_yet_implemented",
    });
  });
});
