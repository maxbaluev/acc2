// Reloadable module registry — the foundation under hot-reload that
// actually swaps behavior. Pre-2026-05-17 hot-reload was theatre: the
// fs.watcher dynamically re-imported a module with a cache-busting URL,
// but the rest of the daemon already held references to the OLD
// eagerly-imported module. Most "completed" reloads were no-ops
// semantically; the daemon's behavior only changed on restart.
//
// This registry exposes a lightweight indirection: consumers fetch the
// current module via `registry.current()` instead of a top-level
// `import { foo } from "./bar"`. The hot-reload worker calls
// `registry.refresh(cacheBustUrl)` to swap the cached reference — every
// subsequent .current() call sees the new code. The registry holds the
// PREVIOUS reference for a configurable rollback window so a downstream
// caller that throws on the new code can be reverted automatically.
//
// Consumers opt in incrementally; modules NOT wired through the registry
// receive `daemon_hotreload_no_op` instead of a misleading `completed`
// event (event_kinds.ts; truth-in-audit fix).

export type ValidationResult = true | string;

export type SmokeProbeResult = { ok: true } | { ok: false; error: string };

export type ReloadableOptions<M> = {
  /** Stable module name (matches the manifest entry `name`). */
  name: string;
  /** Loader callback. The worker passes a cache-busted URL on reload;
   *  bare boot uses `undefined`. Implementations typically do
   *  `(url) => url ? import(url) : import("./local-path")`. */
  load: (cacheBustUrl?: string) => Promise<M>;
  /** Optional shape validation. Return `true` on success, or an error
   *  string. The worker rejects the swap on failure. Use to assert
   *  expected exports + their basic types. */
  validate?: (mod: M) => ValidationResult;
  /** Optional smoke probe — a tiny call into the new module that must
   *  succeed before the swap commits. Useful when validate() can only
   *  check the shape; the probe exercises actual behavior. */
  smokeProbe?: (mod: M) => Promise<SmokeProbeResult> | SmokeProbeResult;
};

export type ReloadableModule<M> = {
  name: string;
  /** Always returns the freshest accepted module. Boots on first call. */
  current: () => Promise<M>;
  /** Refresh in place; on validation/probe failure the previous module
   *  remains active and the error string is returned. */
  refresh: (cacheBustUrl: string) => Promise<RefreshResult>;
  /** Version counter — increments on every accepted swap. Workers can
   *  read this to know whether they're on a stale closure. */
  version: () => number;
  /** Previous module reference (held for rollback). Null until the
   *  first successful refresh. */
  previous: () => M | null;
  /** Force the registry back to the previous reference. Returns false
   *  when there is no previous to roll back to. */
  rollback: () => boolean;
};

export type RefreshResult =
  | { ok: true; version: number; previous_kept: boolean }
  | { ok: false; reason: "load_threw"; error: string }
  | { ok: false; reason: "validation_failed"; error: string }
  | { ok: false; reason: "smoke_probe_failed"; error: string };

const REGISTRY = new Map<string, ReloadableModule<unknown>>();

/** Register a module with the reloadable indirection. Idempotent —
 *  registering the same name twice REPLACES the entry (use when a
 *  hot-reloaded source declares the same name). */
export const registerReloadable = <M>(opts: ReloadableOptions<M>): ReloadableModule<M> => {
  let cached: M | null = null;
  let previous: M | null = null;
  let version = 0;

  const entry: ReloadableModule<M> = {
    name: opts.name,
    version: () => version,
    previous: () => previous,
    current: async () => {
      if (cached === null) {
        cached = await opts.load();
        version = 1;
      }
      return cached;
    },
    refresh: async (cacheBustUrl: string): Promise<RefreshResult> => {
      let fresh: M;
      try {
        fresh = await opts.load(cacheBustUrl);
      } catch (err) {
        return { ok: false, reason: "load_threw", error: (err as Error).message };
      }
      if (opts.validate) {
        const v = opts.validate(fresh);
        if (v !== true) return { ok: false, reason: "validation_failed", error: v };
      }
      if (opts.smokeProbe) {
        let probe: SmokeProbeResult;
        try {
          probe = await opts.smokeProbe(fresh);
        } catch (err) {
          return { ok: false, reason: "smoke_probe_failed", error: (err as Error).message };
        }
        if (!probe.ok) return { ok: false, reason: "smoke_probe_failed", error: probe.error };
      }
      previous = cached;
      cached = fresh;
      version++;
      return { ok: true, version, previous_kept: previous !== null };
    },
    rollback: (): boolean => {
      if (previous === null) return false;
      const swap = previous;
      previous = cached;
      cached = swap;
      version++;
      return true;
    },
  };
  REGISTRY.set(opts.name, entry as ReloadableModule<unknown>);
  return entry;
};

export const getReloadable = (name: string): ReloadableModule<unknown> | null =>
  REGISTRY.get(name) ?? null;

export const listReloadables = (): string[] => [...REGISTRY.keys()];

export const reloadableVersions = (): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const [name, entry] of REGISTRY) out[name] = entry.version();
  return out;
};

/** Test-only — wipe the registry so each test starts from scratch. */
export const __resetReloadableRegistryForTests = (): void => {
  REGISTRY.clear();
};
