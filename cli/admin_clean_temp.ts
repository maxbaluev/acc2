// `acc admin clean-temp-state` — OS hygiene for stale harness state dirs.
//
// Harness runs (and a handful of CLI smoke probes) leave behind transient
// state directories under `/tmp/` when invoked with `--keep-state` or when
// they crash before cleanup. Over time these accumulate to gigabytes. This
// command sweeps them up.
//
// The command emits ZERO events into the production substrate — it is OS
// hygiene, not substrate state. It also REFUSES to touch anything outside
// `/tmp/` matching the canonical glob patterns: the safety check is
// path-prefix + filename-prefix, both checked before any rmSync call. A
// stray `/tmp/something-else/` directory will never be deleted by this
// command no matter what argv contains.
//
// Recognised glob prefixes (all under `/tmp/`):
//   - acc2-harness-task-*       (integration harness, normal runs)
//   - acc2-harness-real-brain-* (integration harness, real-brain runs)
//   - acc2-cli-deep-*           (CLI deep-mode smoke runs)
//   - acc2-cli-smoke-*          (CLI smoke runs)

import { readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

/** Canonical filename-prefixes under `/tmp/` that this command sweeps. */
export const CLEAN_TEMP_PREFIXES: readonly string[] = [
  "acc2-harness-task-",
  "acc2-harness-real-brain-",
  "acc2-cli-deep-",
  "acc2-cli-smoke-",
] as const;

/** The single base path under which we are allowed to operate. */
const TMP_BASE = "/tmp";

/** Filtered enumeration of candidates — paths that exist under `/tmp/`
 *  and whose final filename starts with one of the recognised prefixes.
 *  Anything else is silently excluded; the safety check below also runs
 *  per-path before any deletion. */
const enumerateCandidates = (): string[] => {
  let entries: string[];
  try {
    entries = readdirSync(TMP_BASE);
  } catch {
    // /tmp not readable (extremely unlikely on a real host); return nothing
    // rather than throwing.
    return [];
  }
  const matched: string[] = [];
  for (const name of entries) {
    if (!CLEAN_TEMP_PREFIXES.some((p) => name.startsWith(p))) continue;
    const full = join(TMP_BASE, name);
    matched.push(full);
  }
  return matched;
};

/** Safety check: refuse anything that is not (a) under `/tmp/` AND (b)
 *  whose basename starts with one of the recognised prefixes. Returns
 *  the reason string when refused, `null` when allowed. */
export const refuseReason = (path: string): string | null => {
  if (!path.startsWith(`${TMP_BASE}/`)) {
    return `refusing path outside ${TMP_BASE}/: ${path}`;
  }
  // Disallow path traversal or any further `/` after the first segment.
  const rest = path.slice(TMP_BASE.length + 1);
  if (rest.includes("/")) {
    return `refusing nested path under ${TMP_BASE}/: ${path}`;
  }
  if (!CLEAN_TEMP_PREFIXES.some((p) => rest.startsWith(p))) {
    return `refusing non-matching basename: ${path}`;
  }
  return null;
};

export type CleanTempEnv = {
  out: (line: string) => void;
  err: (line: string) => void;
  /** Override the candidate enumerator for tests. Defaults to scanning
   *  `/tmp/` for entries matching CLEAN_TEMP_PREFIXES. */
  enumerate?: () => string[];
  /** Override the destructive operation for tests. Defaults to rmSync. */
  remove?: (path: string) => void;
};

const defaultEnv = (): CleanTempEnv => ({
  out: (line) => console.log(line),
  err: (line) => console.error(line),
  enumerate: enumerateCandidates,
  remove: (path) => rmSync(path, { recursive: true, force: true }),
});

/** Programmatic entry. Returns the process exit code. Emits ZERO events
 *  into the substrate (this is OS hygiene, not substrate state). */
export const runCleanTempState = async (
  _argv: string[],
  envOverride?: CleanTempEnv,
): Promise<number> => {
  const env = { ...defaultEnv(), ...(envOverride ?? {}) };
  const enumerate = env.enumerate ?? enumerateCandidates;
  const remove = env.remove ?? ((path: string) => rmSync(path, { recursive: true, force: true }));

  const candidates = enumerate();
  if (candidates.length === 0) {
    env.out("clean-temp-state: no stale harness state dirs found");
    return 0;
  }

  let removed = 0;
  let refused = 0;
  for (const path of candidates) {
    const reason = refuseReason(path);
    if (reason !== null) {
      env.err(`refused: ${reason}`);
      refused += 1;
      continue;
    }
    // Best-effort stat — proceed even when stat fails (the rm itself is
    // idempotent with `force: true`).
    try { statSync(path); } catch { /* path vanished between enumerate and rm */ }
    try {
      remove(path);
      env.out(`removed: ${path}`);
      removed += 1;
    } catch (err) {
      env.err(`failed: ${path} — ${(err as Error).message}`);
      refused += 1;
    }
  }
  env.out(`clean-temp-state: removed=${removed} refused=${refused}`);
  return 0;
};
