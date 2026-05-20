// acc2 T2.1 — universal threshold registry.
// Per roadmap F-Universal-Threshold-Registry (meta-move #1) + Architecture
// §15 (every boundary is a posterior-scored row).
//
// Every threshold constant the runtime depends on can become an
// act_artifact{kind:"threshold_predicate"} row with its own Beta posterior.
// Callers query getThreshold(name, defaultValue). Cold-start safety:
// when no row exists, the hardcoded default wins. Once admitted, the
// row's posterior calibrates from outcome correlation — the standard
// substrate machinery (action_scored → maybePromote/maybeQuarantine)
// applies uniformly because threshold predicates are just act_artifacts.
//
// Idempotency contract: getThreshold reads the HIGHEST-posterior admitted
// row matching the name. There may be multiple variants (e.g., per
// goal_class); the caller can pass a more specific name to opt into
// class-scoped tuning. Default-cold-start = hardcoded number.
//
// Caching: a per-process Map memoizes (name → value) reads so the hot
// path doesn't hit SQLite per call. The cache invalidates on a
// 5-minute TTL OR when a `act_artifact_score_updated` event fires for
// any threshold_predicate row (set on the daemon side via activation).

import type { Database } from "bun:sqlite";

const CACHE_TTL_MS = 5 * 60 * 1000;
type CacheEntry = { value: number; storedAt: number };
const cache: Map<string, CacheEntry> = new Map();

export const getThreshold = (
  db: Database,
  name: string,
  defaultValue: number,
): number => {
  const now = Date.now();
  const cached = cache.get(name);
  if (cached && now - cached.storedAt < CACHE_TTL_MS) {
    return cached.value;
  }
  try {
    const row = db
      .query<{ body: string; score: number }, [string]>(
        `SELECT body, score FROM act_artifact
          WHERE kind = 'threshold_predicate'
            AND name = ?
            AND status IN ('admitted','promoted')
          ORDER BY score DESC, updated_at DESC
          LIMIT 1`,
      )
      .get(name);
    if (row?.body) {
      const parsed = JSON.parse(row.body) as { value?: unknown };
      if (typeof parsed.value === "number" && Number.isFinite(parsed.value)) {
        cache.set(name, { value: parsed.value, storedAt: now });
        return parsed.value;
      }
    }
  } catch {
    // SQL failure → fall through to default
  }
  cache.set(name, { value: defaultValue, storedAt: now });
  return defaultValue;
};

/** Invalidate the cache. Call when a threshold_predicate row is
 *  promoted/quarantined or its posterior updates significantly. */
export const invalidateThresholdCache = (name?: string): void => {
  if (name) cache.delete(name);
  else cache.clear();
};

/** Convenience for callers that want to set a threshold via brain-side
 *  amendment OR a hand-crafted seed. Not the hot path — use brain
 *  dispatch + admission worker for production. */
export const seedThresholdPredicate = (
  db: Database,
  name: string,
  value: number,
  meta: { fixture_input?: unknown; fixture_expected_residual?: number } = {},
): void => {
  // Best-effort upsert into act_artifact registry. Idempotent: existing
  // row with same name+kind wins (preserve posterior); new row inserts.
  const existing = db
    .query("SELECT id FROM act_artifact WHERE kind = ? AND name = ? LIMIT 1")
    .get("threshold_predicate", name);
  if (existing) {
    invalidateThresholdCache(name);
    return;
  }
  const id = `threshold_${name}`;
  const body = JSON.stringify({ value, ...meta });
  const declaredSandbox = JSON.stringify({
    runtime: "bun",
    substrate_access: "ro" as const,
    cpu_ms: 100,
    wall_ms: 1000,
    memory_mb: 8,
    fs_read: [],
    fs_write: [],
    net_allow: [],
    proc_allow: [],
  });
  const ts = new Date().toISOString();
  try {
    db.run(
      `INSERT INTO act_artifact (
         id, runtime, body, declared_sandbox, state_root, kind,
         posterior_alpha, posterior_beta, score, confidence,
         recent_residual_mean, recent_kill_count, status, name,
         fixture_input, fixture_expected_residual,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        "bun",
        body,
        declaredSandbox,
        `substrate/threshold/${name}`,
        "threshold_predicate",
        1.0,
        1.0,
        0.5,
        0.5,
        0.0,
        0,
        "admitted",
        name,
        JSON.stringify(meta.fixture_input ?? null),
        meta.fixture_expected_residual ?? 0.5,
        ts,
        ts,
      ],
    );
    invalidateThresholdCache(name);
  } catch {
    /* swallow — best-effort */
  }
};
