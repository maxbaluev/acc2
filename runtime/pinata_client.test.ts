import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  createPinataClient,
  pinataConfigFromEnv,
  pinataConfigured,
  gatewayUrls,
  extractCid,
  type PinataConfig,
  type FetchImpl,
} from "./pinata_client";

const CONFIGURED: PinataConfig = {
  jwt: "test-jwt-token",
  gateway: "https://gw.mypinata.cloud",
  apiBase: "https://api.pinata.cloud",
};

interface RecordedCall {
  url: string;
  init: RequestInit;
}

function mockFetch(
  handler: (call: RecordedCall) => Response | Promise<Response>,
): { fetchImpl: FetchImpl; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const call: RecordedCall = { url, init: init ?? {} };
    calls.push(call);
    return await handler(call);
  }) as unknown as FetchImpl;
  return { fetchImpl, calls };
}

function authOf(init: RequestInit): string | undefined {
  const h = init.headers as Record<string, string> | undefined;
  return h?.Authorization;
}

// --- env-gating ---------------------------------------------------------

describe("pinata config + gating", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  test("pinataConfigured is false without JWT, true with JWT", () => {
    delete process.env.PINATA_JWT;
    expect(pinataConfigured(pinataConfigFromEnv())).toBe(false);
    process.env.PINATA_JWT = "abc";
    expect(pinataConfigured(pinataConfigFromEnv())).toBe(true);
  });

  test("apiBase defaults and trims trailing slash; gateway normalized", () => {
    delete process.env.PINATA_API_BASE;
    delete process.env.PINATA_GATEWAY;
    expect(pinataConfigFromEnv().apiBase).toBe("https://api.pinata.cloud");
    process.env.PINATA_API_BASE = "https://api.pinata.cloud/";
    process.env.PINATA_GATEWAY = "https://gw.mypinata.cloud/";
    const cfg = pinataConfigFromEnv();
    expect(cfg.apiBase).toBe("https://api.pinata.cloud");
    expect(cfg.gateway).toBe("https://gw.mypinata.cloud");
  });
});

// --- unconfigured = no-op-with-error ------------------------------------

describe("unconfigured client is a no-op with typed error", () => {
  const cfg: PinataConfig = { apiBase: "https://api.pinata.cloud" };

  test("pinFile/pinJson/listPins return pinata_not_configured without network", async () => {
    const { fetchImpl, calls } = mockFetch(() => new Response("should-not-be-called", { status: 500 }));
    const client = createPinataClient(cfg, { fetchImpl });
    expect(await client.pinJson({ a: 1 })).toEqual({ ok: false, error: "pinata_not_configured" });
    expect(await client.listPins()).toEqual({ ok: false, error: "pinata_not_configured" });
    expect(client.configured()).toBe(false);
    expect(calls.length).toBe(0);
  });
});

// --- pinFile ------------------------------------------------------------

describe("pinFile", () => {
  let tmpPath: string;
  beforeEach(async () => {
    tmpPath = `/tmp/pinata-test-${Date.now()}-${Math.random().toString(36).slice(2)}.bin`;
    await Bun.write(tmpPath, "release-bundle-contents");
  });
  afterEach(async () => {
    try {
      await Bun.file(tmpPath).unlink?.();
    } catch {
      /* best effort */
    }
  });

  test("sends multipart + Bearer auth to v3 files endpoint and parses CID", async () => {
    const { fetchImpl, calls } = mockFetch(() =>
      new Response(JSON.stringify({ data: { cid: "bafyFILE" } }), { status: 200 }),
    );
    const client = createPinataClient(CONFIGURED, { fetchImpl });
    const res = await client.pinFile(tmpPath, { name: "rel-1.0.tar", keyvalues: { version: "1.0" } });
    expect(res).toEqual({ ok: true, cid: "bafyFILE", bytes: "release-bundle-contents".length });
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe("https://uploads.pinata.cloud/v3/files");
    expect(calls[0].init.method).toBe("POST");
    expect(authOf(calls[0].init)).toBe("Bearer test-jwt-token");
    expect(calls[0].init.body).toBeInstanceOf(FormData);
    const form = calls[0].init.body as FormData;
    expect(form.get("file")).toBeInstanceOf(Blob);
    expect(form.get("name")).toBe("rel-1.0.tar");
    expect(form.get("keyvalues")).toBe(JSON.stringify({ version: "1.0" }));
  });

  test("read error on missing file returns typed error (no throw)", async () => {
    const { fetchImpl, calls } = mockFetch(() => new Response("", { status: 200 }));
    const client = createPinataClient(CONFIGURED, { fetchImpl });
    const res = await client.pinFile("/tmp/does-not-exist-xyz.bin");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.startsWith("pinata_read_error:")).toBe(true);
    expect(calls.length).toBe(0);
  });

  test("non-2xx returns typed pinata_http error", async () => {
    const { fetchImpl } = mockFetch(() => new Response("unauthorized", { status: 401 }));
    const client = createPinataClient(CONFIGURED, { fetchImpl });
    const res = await client.pinFile(tmpPath);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.startsWith("pinata_http_401")).toBe(true);
  });

  test("missing CID in 2xx body returns pinata_no_cid_in_response", async () => {
    const { fetchImpl } = mockFetch(() => new Response(JSON.stringify({ data: {} }), { status: 200 }));
    const client = createPinataClient(CONFIGURED, { fetchImpl });
    const res = await client.pinFile(tmpPath);
    expect(res).toEqual({ ok: false, error: "pinata_no_cid_in_response" });
  });
});

// --- pinJson ------------------------------------------------------------

describe("pinJson", () => {
  test("posts JSON manifest to pinJSONToIPFS and returns CID from IpfsHash", async () => {
    const { fetchImpl, calls } = mockFetch(() =>
      new Response(JSON.stringify({ IpfsHash: "bafyJSON" }), { status: 200 }),
    );
    const client = createPinataClient(CONFIGURED, { fetchImpl });
    const res = await client.pinJson(
      { release: "1.0", artifacts: ["bafyFILE"] },
      { name: "release-index", keyvalues: { channel: "stable" } },
    );
    expect(res).toEqual({ ok: true, cid: "bafyJSON" });
    expect(calls[0].url).toBe("https://api.pinata.cloud/pinning/pinJSONToIPFS");
    expect(authOf(calls[0].init)).toBe("Bearer test-jwt-token");
    const body = JSON.parse(calls[0].init.body as string);
    expect(body.pinataContent).toEqual({ release: "1.0", artifacts: ["bafyFILE"] });
    expect(body.pinataMetadata).toEqual({ name: "release-index", keyvalues: { channel: "stable" } });
  });

  test("non-2xx returns typed error", async () => {
    const { fetchImpl } = mockFetch(() => new Response("rate limited", { status: 429 }));
    const client = createPinataClient(CONFIGURED, { fetchImpl });
    const res = await client.pinJson({ a: 1 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.startsWith("pinata_http_429")).toBe(true);
  });
});

// --- fetchByCid + gateway fallback --------------------------------------

describe("fetchByCid gateway fallback chain", () => {
  test("tries configured gateway first and returns bytes", async () => {
    const { fetchImpl, calls } = mockFetch(() => new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
    const client = createPinataClient(CONFIGURED, { fetchImpl });
    const res = await client.fetchByCid("bafyX");
    expect(res.ok).toBe(true);
    if (res.ok) expect(Array.from(res.bytes)).toEqual([1, 2, 3]);
    expect(calls[0].url).toBe("https://gw.mypinata.cloud/ipfs/bafyX");
  });

  test("falls through to public gateways when configured gateway fails", async () => {
    const { fetchImpl, calls } = mockFetch((call) => {
      if (call.url.includes("mypinata.cloud")) return new Response("", { status: 504 });
      if (call.url.includes("ipfs.io")) return new Response(new Uint8Array([9]), { status: 200 });
      return new Response("", { status: 500 });
    });
    const client = createPinataClient(CONFIGURED, { fetchImpl });
    const res = await client.fetchByCid("bafyY");
    expect(res.ok).toBe(true);
    if (res.ok) expect(Array.from(res.bytes)).toEqual([9]);
    expect(calls[0].url).toContain("mypinata.cloud");
    expect(calls[1].url).toBe("https://ipfs.io/ipfs/bafyY");
  });

  test("all gateways failing returns typed error (no throw)", async () => {
    const { fetchImpl, calls } = mockFetch(() => new Response("", { status: 502 }));
    const cfgNoGw: PinataConfig = { apiBase: "https://api.pinata.cloud" };
    const client = createPinataClient(cfgNoGw, { fetchImpl });
    const res = await client.fetchByCid("bafyZ");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.startsWith("pinata_http_502")).toBe(true);
    // no configured gateway -> ipfs.io then dweb.link
    expect(calls.length).toBe(2);
    expect(calls[0].url).toBe("https://ipfs.io/ipfs/bafyZ");
    expect(calls[1].url).toBe("https://bafyZ.ipfs.dweb.link");
  });

  test("gatewayUrls helper produces the documented fallback chain", () => {
    expect(gatewayUrls(CONFIGURED, "C")).toEqual([
      "https://gw.mypinata.cloud/ipfs/C",
      "https://ipfs.io/ipfs/C",
      "https://C.ipfs.dweb.link",
    ]);
  });
});

// --- listPins -----------------------------------------------------------

describe("listPins discovery", () => {
  test("queries pinList by metadata and maps rows to {cid,name,keyvalues}", async () => {
    const { fetchImpl, calls } = mockFetch(() =>
      new Response(
        JSON.stringify({
          rows: [{ ipfs_pin_hash: "bafyR", metadata: { name: "release-index", keyvalues: { channel: "stable" } } }],
        }),
        { status: 200 },
      ),
    );
    const client = createPinataClient(CONFIGURED, { fetchImpl });
    const res = await client.listPins({ keyvalues: { channel: "stable" }, limit: 5 });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.pins).toEqual([
        { cid: "bafyR", name: "release-index", keyvalues: { channel: "stable" } },
      ]);
    }
    expect(authOf(calls[0].init)).toBe("Bearer test-jwt-token");
    expect(calls[0].url).toContain("/data/pinList?");
    expect(calls[0].url).toContain("status=pinned");
  });
});

// --- timeout ------------------------------------------------------------

describe("timeout path", () => {
  test("aborted request resolves to pinata_timeout (never throws)", async () => {
    // fetchImpl that rejects with an abort once the signal fires.
    const fetchImpl = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      return await new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal) {
          signal.addEventListener("abort", () => {
            const e = new Error("aborted");
            e.name = "AbortError";
            reject(e);
          });
        }
      });
    }) as unknown as FetchImpl;
    const client = createPinataClient(CONFIGURED, { fetchImpl, timeoutMsOverride: 20 });
    const res = await client.pinJson({ a: 1 });
    expect(res).toEqual({ ok: false, error: "pinata_timeout" });
  });

  test("network rejection (non-abort) maps to pinata_network_error", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as FetchImpl;
    const client = createPinataClient(CONFIGURED, { fetchImpl });
    const res = await client.pinJson({ a: 1 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.startsWith("pinata_network_error:")).toBe(true);
  });
});

// --- extractCid shapes --------------------------------------------------

describe("extractCid", () => {
  test("handles v3 data.cid, legacy IpfsHash, and bare cid/Hash", () => {
    expect(extractCid({ data: { cid: "a" } })).toBe("a");
    expect(extractCid({ IpfsHash: "b" })).toBe("b");
    expect(extractCid({ cid: "c" })).toBe("c");
    expect(extractCid({ Hash: "d" })).toBe("d");
    expect(extractCid({ data: { IpfsHash: "e" } })).toBe("e");
    expect(extractCid({})).toBeUndefined();
    expect(extractCid(null)).toBeUndefined();
  });
});
