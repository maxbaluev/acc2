/**
 * ReleaseSource — the update-transport abstraction for `acc update`.
 *
 * DISTREL_P2 (directive 3GZGQ0V5TH5KHF3YDTTDVQ6BH8): reserve the P2P seam
 * WITHOUT implementing pub/sub. This module is PURE TYPES + parsing — it
 * contains NO network code, NO libp2p, NO IPFS client, NO pub/sub.
 *
 * The owner's vision is a future P2P network for updates + communication
 * (+ market) over IPFS pub/sub, with Pinata as the pin/metadata provider.
 * Right now we only RESERVE the seams:
 *
 *   - "git"                  — the CURRENT update path (clone/pull a ref).
 *   - "ipfs_cid"             — the NEW fetch-by-CID path (resolved by the
 *                              `acc update` task against a gateway/Pinata).
 *   - "pubsub_announcement"  — the RESERVED FUTURE P2P path. A
 *                              `release_announced` event id (see
 *                              substrate/event_kinds.ts) that a future
 *                              pub/sub layer will resolve to an ipfs_cid.
 *                              Parsing succeeds today; RESOLVING does not.
 */

export type ReleaseSource =
  | { kind: "git" }
  | { kind: "ipfs_cid"; cid: string; gateway?: string }
  | { kind: "pubsub_announcement"; announcement_event_id: string };

/** A typed error result. Free-string `error` preserves the open vocabulary. */
export type ReleaseSourceError = { error: string };

/**
 * Map a CLI `--from <spec>` string to a ReleaseSource (or a typed error).
 *
 * Accepted spec shapes:
 *   - "git"                  → { kind: "git" }
 *   - "ipfs:<cid>"           → { kind: "ipfs_cid", cid }
 *   - "ipfs:<cid>@<gateway>" → { kind: "ipfs_cid", cid, gateway }
 *   - "pubsub:<event_id>"    → { kind: "pubsub_announcement", announcement_event_id }
 *
 * `git` and `ipfs_cid` are parsed fully. `pubsub:` parses into a real
 * `pubsub_announcement` source so the seam is genuine, but it is not
 * resolvable yet — see `resolveReleaseSource`.
 */
export function parseReleaseSource(spec: string): ReleaseSource | ReleaseSourceError {
  const trimmed = spec.trim();
  if (trimmed.length === 0) return { error: "release_source_empty_spec" };

  if (trimmed === "git") return { kind: "git" };

  if (trimmed.startsWith("ipfs:")) {
    const rest = trimmed.slice("ipfs:".length);
    const atIdx = rest.indexOf("@");
    const cid = (atIdx >= 0 ? rest.slice(0, atIdx) : rest).trim();
    const gateway = atIdx >= 0 ? rest.slice(atIdx + 1).trim() : "";
    if (cid.length === 0) return { error: "release_source_missing_cid" };
    return gateway.length > 0
      ? { kind: "ipfs_cid", cid, gateway }
      : { kind: "ipfs_cid", cid };
  }

  if (trimmed.startsWith("pubsub:")) {
    const announcement_event_id = trimmed.slice("pubsub:".length).trim();
    if (announcement_event_id.length === 0) {
      return { error: "release_source_missing_announcement_event_id" };
    }
    // Seam is real: the parse succeeds and yields a well-formed source.
    // Resolution is the part that is reserved-not-implemented.
    return { kind: "pubsub_announcement", announcement_event_id };
  }

  return { error: "release_source_unrecognized_spec" };
}

/**
 * Resolve a ReleaseSource to a concrete fetchable CID.
 *
 * `git` and `ipfs_cid` are terminal/concrete and pass through unchanged.
 * `pubsub_announcement` is the RESERVED future P2P seam: resolving it
 * requires the unimplemented pub/sub layer (look up the
 * `release_announced` event, verify the signature, extract `bundle_cid`),
 * so it returns a typed error today. The PARSE above still succeeds — only
 * the RESOLVE is gated — so the seam is real and ready to be filled in.
 */
export function resolveReleaseSource(
  source: ReleaseSource,
): ReleaseSource | ReleaseSourceError {
  switch (source.kind) {
    case "git":
    case "ipfs_cid":
      return source;
    case "pubsub_announcement":
      return { error: "pubsub_source_not_yet_implemented" };
  }
}
