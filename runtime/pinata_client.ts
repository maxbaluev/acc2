// runtime/pinata_client.ts
//
// Env-gated Pinata/IPFS pinning + metadata client. This is the TRANSPORT SEAM
// for acc2 distribution/updates: package a release bundle -> pin to IPFS via
// Pinata -> get a content-addressed CID that the release manifest records and
// `acc update` later fetches by CID.
//
// Pinata is used here as a PINNING + METADATA provider:
//   - pinFile  -> pins a packaged release bundle (tarball/CAR) to IPFS
//   - pinJson  -> publishes release metadata (manifest / release-index) to IPFS
//   - fetchByCid -> the read seam `acc update` uses to retrieve content by CID
//   - listPins -> discover pinned releases by metadata keyvalue
//
// FUTURE SEAM (NO CODE NOW): a libp2p pub/sub layer will sit beside this client
// for P2P release announcement/discovery. Pinata handles pin + metadata +
// discovery today; pubsub arrives later as a sibling module — this file
// deliberately contains NO pubsub code.
//
// Design invariants:
//   - Never throws across the public surface. Missing config, network errors,
//     non-2xx responses, and timeouts all resolve to a typed {ok:false,error}.
//   - The HTTP layer (fetch) is injectable via createPinataClient(cfg,{fetchImpl})
//     so tests run fully network-free.
//   - Config is read from env at call time (see pinataConfigFromEnv); this module
//     never mutates .env or package.json.

import { readdirSync, statSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";

export interface PinataConfig {
  jwt?: string;
  gateway?: string; // e.g. https://<gw>.mypinata.cloud
  apiBase: string; // default https://api.pinata.cloud
}

export type FetchImpl = typeof fetch;

export interface PinOpts {
  name?: string;
  keyvalues?: Record<string, string>;
}

export interface ListPinsOpts {
  name?: string;
  keyvalues?: Record<string, string>;
  limit?: number;
}

export type PinFileResult =
  | { ok: true; cid: string; bytes: number }
  | { ok: false; error: string };

export type PinJsonResult =
  | { ok: true; cid: string }
  | { ok: false; error: string };

export type FetchByCidResult =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; error: string };

export interface PinListItem {
  cid: string;
  name?: string;
  keyvalues?: Record<string, string>;
}

export type ListPinsResult =
  | { ok: true; pins: PinListItem[] }
  | { ok: false; error: string };

const DEFAULT_API_BASE = "https://api.pinata.cloud";
const DEFAULT_TIMEOUT_MS = 30_000;

/** Read Pinata config from process.env at call time. Never throws. */
export function pinataConfigFromEnv(): PinataConfig {
  const jwt = process.env.PINATA_JWT?.trim() || undefined;
  const gateway = normalizeGateway(process.env.PINATA_GATEWAY?.trim() || undefined);
  const apiBase = (process.env.PINATA_API_BASE?.trim() || DEFAULT_API_BASE).replace(/\/+$/, "");
  return { jwt, gateway, apiBase };
}

/** True only if a Pinata JWT is present — the client is otherwise a no-op-with-error. */
export function pinataConfigured(cfg: PinataConfig = pinataConfigFromEnv()): boolean {
  return typeof cfg.jwt === "string" && cfg.jwt.length > 0;
}

function normalizeGateway(gw: string | undefined): string | undefined {
  if (!gw) return undefined;
  return gw.replace(/\/+$/, "");
}

function timeoutMs(): number {
  const raw = process.env.ACC2_PINATA_TIMEOUT_MS;
  if (!raw) return DEFAULT_TIMEOUT_MS;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TIMEOUT_MS;
}

export interface PinataClient {
  configured(): boolean;
  pinFile(path: string, opts?: PinOpts): Promise<PinFileResult>;
  pinJson(obj: unknown, opts?: PinOpts): Promise<PinJsonResult>;
  fetchByCid(cid: string): Promise<FetchByCidResult>;
  listPins(opts?: ListPinsOpts): Promise<ListPinsResult>;
}

export interface CreatePinataClientOptions {
  fetchImpl?: FetchImpl;
  timeoutMsOverride?: number;
}

/**
 * Construct a Pinata client. The fetch implementation is injectable so tests
 * can assert endpoints/headers and return canned responses without network.
 */
export function createPinataClient(
  cfg: PinataConfig = pinataConfigFromEnv(),
  options: CreatePinataClientOptions = {},
): PinataClient {
  const doFetch: FetchImpl = options.fetchImpl ?? fetch;
  const reqTimeout = options.timeoutMsOverride ?? timeoutMs();

  function authHeader(): Record<string, string> {
    return { Authorization: `Bearer ${cfg.jwt}` };
  }

  // Pinata v3 upload endpoint. Public file uploads go to the uploads host.
  // ASSUMPTION (unverifiable offline): v3 public file upload endpoint is
  // POST https://uploads.pinata.cloud/v3/files with multipart field "file"
  // and optional "name"/"keyvalues"/"network" fields. Confirm against live docs.
  function uploadsBase(): string {
    // Derive uploads host from apiBase host swap; fall back to canonical host.
    if (cfg.apiBase === DEFAULT_API_BASE) return "https://uploads.pinata.cloud";
    return cfg.apiBase;
  }

  async function withTimeout<T>(
    fn: (signal: AbortSignal) => Promise<T>,
  ): Promise<T | { ok: false; error: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), reqTimeout);
    try {
      return await fn(controller.signal);
    } catch (err) {
      if (controller.signal.aborted) return { ok: false, error: "pinata_timeout" };
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `pinata_network_error:${msg}` };
    } finally {
      clearTimeout(timer);
    }
  }

  async function pinFile(path: string, opts?: PinOpts): Promise<PinFileResult> {
    if (!pinataConfigured(cfg)) return { ok: false, error: "pinata_not_configured" };
    let files: Array<{ relativePath: string; bytes: Uint8Array }>;
    try {
      files = await readPinFiles(path);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `pinata_read_error:${msg}` };
    }
    const totalBytes = files.reduce((n, file) => n + file.bytes.byteLength, 0);
    const fileName = opts?.name ?? basename(path) ?? "release.bin";
    const form = new FormData();
    // Pinata accepts multipart field "file"; directories are represented as
    // repeated file parts with stable relative filenames.
    for (const file of files) {
      const uploadName = files.length === 1 ? fileName : file.relativePath;
      form.append("file", new Blob([file.bytes]), uploadName);
    }
    if (opts?.name) form.append("name", opts.name);
    if (opts?.keyvalues) form.append("keyvalues", JSON.stringify(opts.keyvalues));

    const res = await withTimeout(async (signal) => {
      const r = await doFetch(`${uploadsBase()}/v3/files`, {
        method: "POST",
        headers: { ...authHeader() },
        body: form,
        signal,
      });
      if (!r.ok) {
        const body = await safeText(r);
        return { ok: false as const, error: `pinata_http_${r.status}:${body}` };
      }
      const cid = extractCid(await safeJson(r));
      if (!cid) return { ok: false as const, error: "pinata_no_cid_in_response" };
      return { ok: true as const, cid, bytes: totalBytes };
    });
    return res as PinFileResult;
  }

  async function pinJson(obj: unknown, opts?: PinOpts): Promise<PinJsonResult> {
    if (!pinataConfigured(cfg)) return { ok: false, error: "pinata_not_configured" };
    // ASSUMPTION (unverifiable offline): legacy JSON pin endpoint is
    // POST <apiBase>/pinning/pinJSONToIPFS with body {pinataContent, pinataMetadata}.
    // Returns {IpfsHash}. Confirm against live docs.
    const metadata: Record<string, unknown> = {};
    if (opts?.name) metadata.name = opts.name;
    if (opts?.keyvalues) metadata.keyvalues = opts.keyvalues;
    const body = JSON.stringify({
      pinataContent: obj,
      ...(Object.keys(metadata).length > 0 ? { pinataMetadata: metadata } : {}),
    });

    const res = await withTimeout(async (signal) => {
      const r = await doFetch(`${cfg.apiBase}/pinning/pinJSONToIPFS`, {
        method: "POST",
        headers: { ...authHeader(), "Content-Type": "application/json" },
        body,
        signal,
      });
      if (!r.ok) {
        const t = await safeText(r);
        return { ok: false as const, error: `pinata_http_${r.status}:${t}` };
      }
      const cid = extractCid(await safeJson(r));
      if (!cid) return { ok: false as const, error: "pinata_no_cid_in_response" };
      return { ok: true as const, cid };
    });
    return res as PinJsonResult;
  }

  async function fetchByCid(cid: string): Promise<FetchByCidResult> {
    // No JWT required to fetch by CID via public/configured gateways.
    const candidates = gatewayUrls(cfg, cid);
    let lastError = "pinata_fetch_failed";
    for (const url of candidates) {
      const res = await withTimeout(async (signal) => {
        const r = await doFetch(url, { method: "GET", signal });
        if (!r.ok) return { ok: false as const, error: `pinata_http_${r.status}` };
        const buf = new Uint8Array(await r.arrayBuffer());
        return { ok: true as const, bytes: buf };
      });
      if ("ok" in res && res.ok) return res;
      lastError = (res as { error: string }).error;
    }
    return { ok: false, error: lastError };
  }

  async function listPins(opts?: ListPinsOpts): Promise<ListPinsResult> {
    if (!pinataConfigured(cfg)) return { ok: false, error: "pinata_not_configured" };
    // ASSUMPTION (unverifiable offline): pin-list query is
    // GET <apiBase>/data/pinList?status=pinned[&metadata[name]=..&metadata[keyvalues]={..}]
    // returning {rows:[{ipfs_pin_hash, metadata:{name, keyvalues}}]}. Confirm against live docs.
    const params = new URLSearchParams({ status: "pinned" });
    if (opts?.name) params.set("metadata[name]", opts.name);
    if (opts?.keyvalues) params.set("metadata[keyvalues]", JSON.stringify(opts.keyvalues));
    if (opts?.limit) params.set("pageLimit", String(opts.limit));

    const res = await withTimeout(async (signal) => {
      const r = await doFetch(`${cfg.apiBase}/data/pinList?${params.toString()}`, {
        method: "GET",
        headers: { ...authHeader() },
        signal,
      });
      if (!r.ok) {
        const t = await safeText(r);
        return { ok: false as const, error: `pinata_http_${r.status}:${t}` };
      }
      const json = (await safeJson(r)) as { rows?: unknown[] } | null;
      const rows = Array.isArray(json?.rows) ? json!.rows : [];
      const pins: PinListItem[] = rows.map((row) => {
        const rec = (row ?? {}) as Record<string, unknown>;
        const meta = (rec.metadata ?? {}) as Record<string, unknown>;
        return {
          cid: String(rec.ipfs_pin_hash ?? rec.cid ?? ""),
          name: typeof meta.name === "string" ? meta.name : undefined,
          keyvalues:
            meta.keyvalues && typeof meta.keyvalues === "object"
              ? (meta.keyvalues as Record<string, string>)
              : undefined,
        };
      });
      return { ok: true as const, pins };
    });
    return res as ListPinsResult;
  }

  return { configured: () => pinataConfigured(cfg), pinFile, pinJson, fetchByCid, listPins };
}

/** Gateway fallback chain: configured gateway first, then public gateways. */
export function gatewayUrls(cfg: PinataConfig, cid: string): string[] {
  const urls: string[] = [];
  if (cfg.gateway) urls.push(`${cfg.gateway}/ipfs/${cid}`);
  urls.push(`https://ipfs.io/ipfs/${cid}`);
  urls.push(`https://${cid}.ipfs.dweb.link`);
  return urls;
}

/**
 * Extract a CID from a Pinata response across known shapes:
 *   v3 file upload: { data: { cid } }
 *   legacy pin:     { IpfsHash }
 *   misc:           { cid }
 */
export function extractCid(json: unknown): string | undefined {
  if (!json || typeof json !== "object") return undefined;
  const obj = json as Record<string, unknown>;
  const data = obj.data as Record<string, unknown> | undefined;
  const candidate =
    (data && (data.cid ?? data.IpfsHash)) ?? obj.IpfsHash ?? obj.cid ?? obj.Hash;
  return typeof candidate === "string" && candidate.length > 0 ? candidate : undefined;
}

async function readPinFiles(path: string): Promise<Array<{ relativePath: string; bytes: Uint8Array }>> {
  const root = resolve(path);
  const st = statSync(root);
  if (st.isFile()) return [{ relativePath: basename(root), bytes: await Bun.file(root).bytes() }];
  if (!st.isDirectory()) throw new Error("path_not_file_or_directory");
  const paths: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.isFile()) paths.push(abs);
    }
  };
  walk(root);
  if (paths.length === 0) throw new Error("directory_empty");
  return await Promise.all(paths.map(async (abs) => ({
    relativePath: relative(root, abs).replaceAll("\\", "/"),
    bytes: await Bun.file(abs).bytes(),
  })));
}

async function safeJson(r: Response): Promise<unknown> {
  try {
    return await r.json();
  } catch {
    return null;
  }
}

async function safeText(r: Response): Promise<string> {
  try {
    return (await r.text()).slice(0, 500);
  } catch {
    return "";
  }
}
