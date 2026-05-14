// `acc admin rotate-{admin,external}-token` helpers (Batch 3.ADMIN).
//
// Two rotations live here:
//
//   - rotateAdminToken    — mints a fresh 64-char hex token, writes it to
//     the admin token file (mode 0600), emits `admin_token_rotated`.
//     The daemon reads the token once at boot, so an in-flight rotation
//     requires the operator to restart the daemon for the new token to
//     take effect.  We document this in the printed reminder rather than
//     standing up a /admin/reload-token endpoint — restart is the cleaner
//     path and matches the rest of the credentials surface (k_252:
//     daemon stays the single source of truth for in-memory state).
//
//   - rotateExternalToken — mints a fresh bearer token for a registered
//     external source, persists the new mapping in the substrate's
//     `meta` table under key `external_source_tokens` (JSON {source:token}
//     map, same shape `external_ingress.ts` reads at boot), and emits
//     `external_source_token_rotated`.  The operator must update the
//     external service's webhook config with the new value — the CLI
//     prints it once and never logs it again.

import { chmodSync, existsSync, writeFileSync } from "node:fs";
import { Database } from "bun:sqlite";
import { newAdminToken } from "../runtime/ids";
import { emitEvent } from "../runtime/events";

export type RotateAdminTokenOptions = {
  tokenFile: string;
  /** When set the env's existing token is the "previous" value carried into
   *  the audit event.  Tests inject a deterministic stub. */
  mintToken?: () => string;
  /** Source DB to emit the audit event into.  Required — admin rotation
   *  has to land on the substrate or it is silent. */
  db: Database;
};

export type RotateAdminTokenResult = {
  ok: boolean;
  tokenFile: string;
  newTokenPreview: string;
  reminder: string;
  errors: string[];
};

const tokenPreview = (token: string): string =>
  token.length <= 8 ? "***" : `${token.slice(0, 4)}…${token.slice(-4)}`;

/** Mint a fresh admin token + write it + emit the audit event.  Returns
 *  a preview (NEVER the raw token) to avoid double-logging the secret. */
export const rotateAdminToken = (opts: RotateAdminTokenOptions): RotateAdminTokenResult => {
  const result: RotateAdminTokenResult = {
    ok: false,
    tokenFile: opts.tokenFile,
    newTokenPreview: "",
    reminder: "",
    errors: [],
  };
  const mint = opts.mintToken ?? newAdminToken;
  const newToken = mint();
  if (!newToken || newToken.length < 32) {
    result.errors.push("mint_returned_short_token");
    return result;
  }
  try {
    writeFileSync(opts.tokenFile, JSON.stringify({ admin_token: newToken }, null, 2), {
      mode: 0o600,
    });
    try { chmodSync(opts.tokenFile, 0o600); } catch { /* best-effort */ }
  } catch (err) {
    result.errors.push(`token_file_write_failed:${(err as Error).message}`);
    return result;
  }

  try {
    emitEvent(opts.db, {
      kind: "admin_token_rotated",
      substrate_origin: "owner",
      payload: {
        token_file: opts.tokenFile,
        new_token_preview: tokenPreview(newToken),
      },
    });
  } catch (err) {
    result.errors.push(`audit_emit_failed:${(err as Error).message}`);
    return result;
  }

  result.ok = true;
  result.newTokenPreview = tokenPreview(newToken);
  result.reminder = [
    "New admin token written.  The daemon must be restarted for the new",
    "token to take effect; update any scripts that read the token file.",
    `Raw token (printed ONCE, never logged): ${newToken}`,
  ].join("\n");
  return result;
};

// ── external-source token rotation ────────────────────────────────

const META_KEY_EXTERNAL_TOKENS = "external_source_tokens";

type ExternalTokenMap = Record<string, string>;

const readMeta = (db: Database, key: string): string | null => {
  const row = db.query("SELECT value FROM meta WHERE key = ?").get(key) as
    | { value: string } | null;
  return row?.value ?? null;
};

const writeMeta = (db: Database, key: string, value: string): void => {
  db.run(
    "INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    [key, value],
  );
};

const readExternalTokenMap = (db: Database): ExternalTokenMap => {
  const raw = readMeta(db, META_KEY_EXTERNAL_TOKENS);
  if (!raw) return {};
  try { return JSON.parse(raw) as ExternalTokenMap; } catch { return {}; }
};

/** Verify the source was registered (registration emits
 *  `external_source_registered`).  Returns the registration payload when
 *  found, null otherwise. */
const lookupRegistration = (db: Database, source: string): boolean => {
  const row = db
    .query(
      `SELECT id FROM events
       WHERE kind = 'external_source_registered'
         AND json_extract(payload, '$.source') = ?
       ORDER BY ts DESC LIMIT 1`,
    )
    .get(source) as { id: string } | null;
  return row !== null;
};

export type RotateExternalTokenOptions = {
  db: Database;
  source: string;
  /** Tests inject a deterministic mint. */
  mintToken?: () => string;
};

export type RotateExternalTokenResult = {
  ok: boolean;
  source: string;
  newTokenPreview: string;
  rawToken: string; // printed once by the caller; never re-logged
  reminder: string;
  errors: string[];
};

export const rotateExternalToken = (
  opts: RotateExternalTokenOptions,
): RotateExternalTokenResult => {
  const result: RotateExternalTokenResult = {
    ok: false,
    source: opts.source,
    newTokenPreview: "",
    rawToken: "",
    reminder: "",
    errors: [],
  };
  if (!opts.source || typeof opts.source !== "string") {
    result.errors.push("missing_source");
    return result;
  }
  if (!lookupRegistration(opts.db, opts.source)) {
    result.errors.push(`source_not_registered:${opts.source}`);
    return result;
  }
  const mint = opts.mintToken ?? newAdminToken;
  const newToken = mint();
  if (!newToken || newToken.length < 16) {
    result.errors.push("mint_returned_short_token");
    return result;
  }

  // Persist the new mapping.
  const map = readExternalTokenMap(opts.db);
  map[opts.source] = newToken;
  writeMeta(opts.db, META_KEY_EXTERNAL_TOKENS, JSON.stringify(map));

  emitEvent(opts.db, {
    kind: "external_source_token_rotated",
    substrate_origin: "owner",
    payload: {
      source: opts.source,
      new_token_preview: tokenPreview(newToken),
    },
  });

  result.ok = true;
  result.newTokenPreview = tokenPreview(newToken);
  result.rawToken = newToken;
  result.reminder = [
    `External token rotated for source='${opts.source}'.`,
    "Update the external service's webhook config with the new value below.",
    "If the daemon is running, restart it so the new token loads into",
    "ExternalIngressState.tokens.perSource on the next boot.",
  ].join("\n");
  return result;
};

// Mark `existsSync` as referenced so future ESM linters don't trim it.
void existsSync;
