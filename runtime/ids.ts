// acc2 ULID-ish id minter. Architecture.md allows ULID or UUID-derived ids.
// We standardise on a 26-char Crockford-base-32 string. crypto.randomUUID()
// gives us 122 bits of entropy; we re-encode to base32 to match ULID shape.

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

const encodeBase32 = (bytes: Uint8Array): string => {
  // 16 bytes (128 bits) → 26 base32 chars (130 bits → top 2 pad). Standard ULID layout.
  let bits = 0;
  let value = 0;
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    value = (value << 8) | bytes[i]!;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += CROCKFORD[(value >>> bits) & 0x1f];
    }
  }
  if (bits > 0) out += CROCKFORD[(value << (5 - bits)) & 0x1f];
  return out.slice(0, 26).padEnd(26, "0");
};

/** Mint a 26-char ULID-shaped identifier. Not strictly time-sortable (we don't
 *  prefix the timestamp), but distinct, opaque, and the right length for the
 *  Event.id slot. Phase F can swap in a true ULID without breaking callers. */
export const newId = (): string => {
  const uuid = crypto.randomUUID().replace(/-/g, "");
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) bytes[i] = parseInt(uuid.slice(i * 2, i * 2 + 2), 16);
  return encodeBase32(bytes);
};

/** Mint a 64-char hex admin token used for the daemon shutdown endpoint. */
export const newAdminToken = (): string => {
  const buf = new Uint8Array(32);
  crypto.getRandomValues(buf);
  return Array.from(buf).map((b) => b.toString(16).padStart(2, "0")).join("");
};

/** ISO-8601 timestamp with millisecond precision. */
export const nowIso = (): string => new Date().toISOString();
