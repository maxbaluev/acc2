// acc2 camofox-browser runtime — REAL Camoufox (firefox fork) driven via
// playwright's `firefox.launchPersistentContext` against a long-lived,
// substrate-owned profile root (v2-design.md §6.1 row "camofox-browser",
// §11.3 camofox variant, §5.5 supervision).
//
// Batch 1.α reality: the runtime spawns the real Camoufox binary —
// distributed at https://github.com/daijro/camoufox/releases and typically
// fetched via `python -m camoufox fetch` to `~/.cache/camoufox/camoufox`
// (Linux) or `~/Library/Caches/camoufox/camoufox` (macOS). Camoufox is a
// Firefox build with anti-fingerprint randomization patched in; we drive it
// from TypeScript via playwright's `firefox.launchPersistentContext({
// executablePath, userDataDir, ... })`.
//
// The wrapper still imports `playwright` for the JS driver; the binary
// pointed at by `executablePath` is the camoufox firefox build. Operators
// install playwright via `bun add playwright` (the chromium download step
// `bunx playwright install chromium` is NOT required — camoufox brings its
// own firefox binary).
//
// Binary detection chain (`isCamoufoxAvailable`):
//   1. `process.env.CAMOUFOX_BINARY_PATH` — operator override.
//   2. `${HOME}/.cache/camoufox/camoufox` (Linux fetch location).
//   3. `${HOME}/Library/Caches/camoufox/camoufox` (macOS fetch location).
// If none of those exist, the runtime returns `camoufox_runtime_unavailable`
// with an install-instructions message threaded into `sandboxWarnings`.
//
// Playwright availability is ALSO a gate — without the JS driver we cannot
// launch a process. The check is layered: playwright first (cheap), camoufox
// binary second (cheap, just `existsSync`).
//
// Fingerprint env hints — read by the wrapper code that calls
// `firefox.launch`. The orchestrator (substrate/runtime/sandbox.ts builder)
// sets these from the SandboxDecl:
//   - CAMOUFOX_OS       — "linux" | "macos" | "windows"
//   - CAMOUFOX_LOCALE   — BCP 47 (e.g. "en-US")
//   - CAMOUFOX_HEADLESS — "true" | "false"
//
// Lifecycle when camoufox + playwright are BOTH present:
//   1. Acquire the per-profile-root mutex (v2-design.md §11.2 — stateful
//      artifacts queue on a per-state-root mutex; camofox is stateful per
//      profile_root). Concurrent invocations against the SAME profile_root
//      serialize; different profile_roots run in parallel.
//   2. Materialize the artifact body into an ephemeral tempdir. The wrapper
//      provides a `camofox` virtual module with a minimal session API
//      (`session.goto`, `session.fill`, `session.click`, `session.text`,
//      `session.url`, `session.screenshot`, `session.close`, plus raw
//      `session.page` for any extra playwright Page method) on top of
//      playwright's `firefox.launchPersistentContext`. Inputs flow in via
//      ACC2_INPUTS.
//   3. Launch firefox via the Camoufox binary with `userDataDir =
//      browser_profile_root`. The profile root is owned by the substrate;
//      the wrapper does not delete it on exit so state survives across
//      invocations.
//   4. Enforce `browser_allow_domains` via `page.route()` — block requests
//      to disallowed domains.
//   5. Watchdog per §5.5 row "camofox": graceful `session.close()` at
//      wall_ms; SIGKILL at wall_ms × 2 (firefox hung-page recovery is
//      slow). If firefox fails to exit after SIGKILL, emit a
//      `profile_quarantine_pending` event so the supervisor spawns a
//      fresh context on next invocation.
//   6. Drain stdout + stderr. Parse `@@RESULT@@ <json>`.
//   7. Tempdir cleanup unconditional in `finally`. Profile root persists.
//
// Lifecycle when EITHER is absent:
//   - Return `{ok:false, error:"camofox_runtime_unavailable"}` cleanly with
//     a sandboxWarnings entry pointing at the install command. Admission
//     paths can still admit the artifact (the sandbox decl validates); only
//     RUNNING the artifact is gated.

import type { Subprocess } from "bun";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { CamofoxSandboxDecl, JsonValue } from "../../substrate/types";
import { buildCamofoxPermissionArgs } from "../sandbox";
import type { EmitEventInput } from "../events";

export type CamofoxRuntimeInvocation = {
  artifactId: string;
  body: string;
  declaredSandbox: CamofoxSandboxDecl;
  inputs: JsonValue;
  budget?: { wallMs?: number; memoryMb?: number };
  emit?: (event: EmitEventInput) => void;
};

export type CamofoxRuntimeObservation = {
  ok: boolean;
  result?: JsonValue;
  error?: string;
  irreversibleEffects: Array<{ kind: string; description: string }>;
  durationMs: number;
  exitCode: number;
  stderrTail: string;
  sandboxWarnings: string[];
  profileRoot: string;
};

const RESULT_PREFIX = "@@RESULT@@ ";
const IRREVERSIBLE_PREFIX = "@@IRREVERSIBLE@@ ";
const STDERR_TAIL_BYTES = 1024;
/** Robustness: SIGKILL fires this many ms AFTER SIGTERM if the subprocess
 *  has not exited. Firefox hung-page recovery is slow — 1 s grace is the
 *  universal value; no env knob (operators never tuned it). */
const SIGTERM_SIGKILL_ESCALATION_MS = 1_000;

/** See runtimes/bun.ts for the convention — same parser, same semantics.
 *  The camofox wrapper captures console.log; user code emits the marker
 *  via `console.log('@@IRREVERSIBLE@@ <kind>:<description>')`. */
const parseIrreversibleLines = (stdout: string): Array<{ kind: string; description: string }> => {
  const out: Array<{ kind: string; description: string }> = [];
  for (const ln of stdout.split(/\r?\n/)) {
    if (!ln.startsWith(IRREVERSIBLE_PREFIX)) continue;
    const suffix = ln.slice(IRREVERSIBLE_PREFIX.length);
    const sep = suffix.indexOf(":");
    if (sep <= 0) {
      out.push({ kind: "unspecified", description: suffix.trim() });
    } else {
      out.push({
        kind: suffix.slice(0, sep).trim(),
        description: suffix.slice(sep + 1).trim(),
      });
    }
  }
  return out;
};

// ── Per-state-root mutex (v2-design.md §11.2) ─────────────────────
//
// Concurrent invocations against the same profile_root MUST queue. We model
// this as a Map<profile_root, Promise>: each entry is a tail promise; new
// invocations chain onto it and replace it in the same call site, so the
// queue is implicit in the promise chain. The map is per-process; in v2 the
// daemon is the only process running artifacts so a process-local mutex is
// authoritative.

const profileMutexes = new Map<string, Promise<void>>();

const acquireProfileMutex = <T>(profileRoot: string, fn: () => Promise<T>): Promise<T> => {
  const prev = profileMutexes.get(profileRoot) ?? Promise.resolve();
  let release: () => void = () => undefined;
  const next = new Promise<void>((resolve) => { release = resolve; });
  profileMutexes.set(profileRoot, prev.then(() => next));
  // Eagerly clean up the map entry when this entry is the LATEST one —
  // otherwise the map would grow unbounded with empty resolved promises.
  const guarded = (async () => {
    await prev;
    try {
      return await fn();
    } finally {
      release();
      // If our `next` is still the head, drop it so the map doesn't leak.
      if (profileMutexes.get(profileRoot) === prev.then(() => next)) {
        profileMutexes.delete(profileRoot);
      }
    }
  })();
  return guarded;
};

// Exposed for tests that need to assert serialization behavior end-to-end.
export const __getProfileMutexQueueDepth = (profileRoot: string): boolean =>
  profileMutexes.has(profileRoot);

/** Test surface: run an arbitrary async function under the per-profile-root
 *  mutex without spawning firefox. Phase Align Principle 8 uses this to
 *  prove the mutex serializes concurrent invocations against the same
 *  state root. NOT exported for production callers — only the runtime's
 *  own `runCamofoxArtifact` should drive the firefox pipeline. */
export const __acquireProfileMutexForTest = <T>(
  profileRoot: string,
  fn: () => Promise<T>,
): Promise<T> => acquireProfileMutex(profileRoot, fn);

// ── Playwright availability detection ──────────────────────────────
//
// We look up the `playwright` module without `await import()` because
// node_modules can be present without firefox having been downloaded — but
// for Camoufox we point `executablePath` at the Camoufox firefox binary, so
// the playwright-bundled firefox download (`bunx playwright install firefox`)
// is NOT needed. Existence of the `playwright` package manifest is sufficient.

let playwrightInstalledCache: boolean | null = null;
const isPlaywrightInstalled = (): boolean => {
  if (playwrightInstalledCache !== null) return playwrightInstalledCache;
  try {
    const candidates = [
      join(import.meta.dir, "..", "..", "node_modules", "playwright", "package.json"),
      join(import.meta.dir, "..", "..", "node_modules", "playwright-core", "package.json"),
    ];
    playwrightInstalledCache = candidates.some((p) => existsSync(p));
  } catch {
    playwrightInstalledCache = false;
  }
  return playwrightInstalledCache;
};

// ── Camoufox binary detection ──────────────────────────────────────
//
// Three-step chain. The override is honoured first so operators with custom
// install layouts (corp shares, build-from-source) can point at any path.
// The default locations match what `python -m camoufox fetch` writes — the
// canonical install recipe documented in docs/operator-install.md.

const camoufoxBinaryCandidates = (): string[] => {
  const home = homedir();
  return [
    // Linux fetch location (`python -m camoufox fetch` writes here on Linux).
    join(home, ".cache", "camoufox", "camoufox"),
    // macOS fetch location.
    join(home, "Library", "Caches", "camoufox", "camoufox"),
  ];
};

/** Resolve the camoufox binary path or return `null` when none of the
 *  candidate paths exist. Pure — no filesystem mutation.
 *
 *  CAMOUFOX_BINARY_PATH is authoritative when set: the operator explicitly
 *  pointed at a binary, so we honor their choice (existence-checked) without
 *  falling back to the cache locations. Falling back would silently mask a
 *  typo in the env var and surprise the operator. */
const resolveCamoufoxBinary = (): string | null => {
  const override = process.env.CAMOUFOX_BINARY_PATH;
  if (override !== undefined && override.length > 0) {
    try {
      return existsSync(override) ? override : null;
    } catch {
      return null;
    }
  }
  for (const candidate of camoufoxBinaryCandidates()) {
    try {
      if (existsSync(candidate)) return candidate;
    } catch { /* swallow */ }
  }
  return null;
};

// ── Result-parsing helpers (shared shape with bun/uv runtimes) ─────

const readStream = async (stream: ReadableStream<Uint8Array> | null): Promise<string> => {
  if (!stream) return "";
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) out += decoder.decode(value, { stream: true });
    }
    out += decoder.decode();
  } finally {
    try { reader.releaseLock(); } catch { /* swallow */ }
  }
  return out;
};

const parseResultLine = (stdout: string):
  | { ok: true; value: JsonValue }
  | { ok: false; reason: string } => {
  const lines = stdout.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const ln = lines[i]!;
    if (ln.startsWith(RESULT_PREFIX)) {
      const suffix = ln.slice(RESULT_PREFIX.length);
      try {
        return { ok: true, value: JSON.parse(suffix) as JsonValue };
      } catch (err) {
        return { ok: false, reason: `result_parse_failed:${(err as Error).message}` };
      }
    }
  }
  return { ok: false, reason: "result_marker_missing" };
};

const lastBytes = (s: string, n: number): string =>
  s.length <= n ? s : s.slice(s.length - n);

// ── Wrapper script generation ──────────────────────────────────────
//
// The wrapper imports playwright, points firefox at the Camoufox binary via
// `executablePath`, exposes a thin `session` facade matching the camofox API
// the seed artifacts use, runs the user body, and prints `@@RESULT@@ <json>`
// on exit. The user body is wrapped in an async IIFE so `await` works at the
// top level.
//
// Fingerprint env hints (CAMOUFOX_OS / CAMOUFOX_LOCALE / CAMOUFOX_HEADLESS)
// are surfaced to the launch options inside the wrapper — Camoufox itself
// reads several of these as launch-time env vars (e.g. CAMOUFOX_OS picks the
// fingerprint family), and we additionally thread `locale` and `headless`
// into playwright's `launchPersistentContext` options.

const wrapBrowserBody = (
  body: string,
  profileRoot: string,
  allowDomains: string[],
  camoufoxBinary: string,
): string => [
  "import { firefox } from 'playwright';",
  "const inputs = JSON.parse(process.env.ACC2_INPUTS ?? 'null');",
  `const __profileRoot = ${JSON.stringify(profileRoot)};`,
  `const __allowDomains = ${JSON.stringify(allowDomains)};`,
  `const __executablePath = ${JSON.stringify(camoufoxBinary)};`,
  "const __headless = (process.env.CAMOUFOX_HEADLESS ?? 'true') !== 'false';",
  "const __locale = process.env.CAMOUFOX_LOCALE ?? 'en-US';",
  "const __isAllowed = (url) => {",
  "  if (__allowDomains.length === 0) return true;",
  "  try { const u = new URL(url); return __allowDomains.some((d) => u.hostname === d || u.hostname.endsWith('.' + d)); }",
  "  catch { return false; }",
  "};",
  "const __ctx = await firefox.launchPersistentContext(__profileRoot, {",
  "  executablePath: __executablePath,",
  "  headless: __headless,",
  "  locale: __locale,",
  "});",
  "const __page = (await __ctx.pages())[0] ?? await __ctx.newPage();",
  "await __page.route('**/*', (route) => { __isAllowed(route.request().url()) ? route.continue() : route.abort(); });",
  "const session = {",
  "  page: __page,",
  "  goto: async (url) => { await __page.goto(url); },",
  "  fill: async (sel, text) => { await __page.fill(sel, text); },",
  "  click: async (sel) => { await __page.click(sel); },",
  "  text: async (sel) => __page.textContent(sel),",
  "  get url() { return __page.url(); },",
  "  screenshot: async () => __page.screenshot({ encoding: 'base64' }),",
  "  close: async () => { await __ctx.close(); },",
  "};",
  "let __result = null;",
  "let __resultEmitted = false;",
  "const __origLog = console.log.bind(console);",
  "console.log = (...args) => {",
  "  const first = args[0];",
  "  if (typeof first === 'string' && first.startsWith('@@RESULT@@ ')) __resultEmitted = true;",
  "  __origLog(...args);",
  "};",
  "try {",
  "  __result = await (async () => {",
  "    // --- begin artifact body ---",
  body,
  "    // --- end artifact body ---",
  "  })();",
  "} finally {",
  "  try { await __ctx.close(); } catch {}",
  "}",
  "if (!__resultEmitted) {",
  "  __origLog('@@RESULT@@ ' + JSON.stringify(__result ?? { ok: true }));",
  "}",
].join("\n");

const installHint =
  "camoufox binary not found — install via `pip install camoufox && python -m camoufox fetch` " +
  "(writes to ~/.cache/camoufox/camoufox), OR download from " +
  "https://github.com/daijro/camoufox/releases and set CAMOUFOX_BINARY_PATH=/path/to/camoufox. " +
  "Also ensure playwright is installed via `bun add playwright`.";

// ── Public runtime entry point ─────────────────────────────────────

export const runCamofoxArtifact = async (
  inv: CamofoxRuntimeInvocation,
): Promise<CamofoxRuntimeObservation> => {
  // Organism-alignment audit finding #1 (b3qc9ryzj, 2026-05-15): apply the
  // bun runtime's env_requires gate uniformly to camofox-browser. Missing
  // declared env vars now emit owner_input_required + refuse to invoke.
  const envRequires = inv.declaredSandbox.env_requires ?? [];
  const missingEnv = envRequires.filter((k) => !process.env[k] || process.env[k]!.length === 0);
  if (missingEnv.length > 0) {
    inv.emit?.({
      kind: "owner_input_required",
      substrate_origin: "substrate_auto",
      action_artifact_id: inv.artifactId,
      payload: {
        reason: "missing_env_credentials",
        missing_env_vars: missingEnv,
        artifact_id: inv.artifactId,
        runtime: "camofox-browser",
        instruction: `add ${missingEnv.join(", ")} to .env (or export in your shell), then retry.`,
      },
    });
    return {
      ok: false,
      error: `missing_env:${missingEnv.join(",")}`,
      irreversibleEffects: [],
      durationMs: 0,
      exitCode: -1,
      stderrTail: `acc2 camofox runtime: refusing to invoke — declared env_requires missing: ${missingEnv.join(", ")}`,
      sandboxWarnings: [],
      profileRoot: inv.declaredSandbox.browser_profile_root,
    };
  }

  const perm = buildCamofoxPermissionArgs(inv.declaredSandbox);
  const wallMs = inv.budget?.wallMs ?? inv.declaredSandbox.wall_ms;
  const memoryMb = inv.budget?.memoryMb ?? inv.declaredSandbox.memory_mb;
  const profileRoot = inv.declaredSandbox.browser_profile_root;
  const allowDomains = inv.declaredSandbox.browser_allow_domains;

  // Batch 1.α availability gate. We gate on TWO conditions:
  //   1. playwright JS driver installed (`bun add playwright`).
  //   2. camoufox binary present (override or default fetch location).
  // Either missing -> refuse cleanly with operator-install hint.
  if (!isPlaywrightInstalled()) {
    return {
      ok: false,
      error: "camofox_runtime_unavailable",
      irreversibleEffects: [],
      durationMs: 0,
      exitCode: -1,
      stderrTail: "",
      sandboxWarnings: perm.warnings.concat([
        "playwright not installed — run `bun add playwright` to enable camofox-browser execution",
        installHint,
      ]),
      profileRoot,
    };
  }

  const camoufoxBinary = resolveCamoufoxBinary();
  if (!camoufoxBinary) {
    return {
      ok: false,
      error: "camofox_runtime_unavailable",
      irreversibleEffects: [],
      durationMs: 0,
      exitCode: -1,
      stderrTail: "",
      sandboxWarnings: perm.warnings.concat([installHint]),
      profileRoot,
    };
  }

  return acquireProfileMutex(profileRoot, () => runCamofoxArtifactInner(
    inv,
    perm.warnings,
    perm.env,
    wallMs,
    memoryMb,
    profileRoot,
    allowDomains,
    camoufoxBinary,
  ));
};

const runCamofoxArtifactInner = async (
  inv: CamofoxRuntimeInvocation,
  baseWarnings: string[],
  permEnv: Record<string, string>,
  wallMs: number,
  memoryMb: number,
  profileRoot: string,
  allowDomains: string[],
  camoufoxBinary: string,
): Promise<CamofoxRuntimeObservation> => {
  const dir = mkdtempSync(join(tmpdir(), "acc2-camofox-"));
  const entryPath = join(dir, "entry.mjs");
  writeFileSync(entryPath, wrapBrowserBody(inv.body, profileRoot, allowDomains, camoufoxBinary), { mode: 0o600 });

  const env: Record<string, string> = {
    ...process.env,
    ...permEnv,
    ACC2_INPUTS: JSON.stringify(inv.inputs ?? null),
    ACC2_ARTIFACT_ID: inv.artifactId,
    ACC2_BUDGET_WALL_MS: String(wallMs),
    ACC2_BUDGET_MEMORY_MB: String(memoryMb),
    ACC2_BROWSER_PROFILE: profileRoot,
    ACC2_ALLOWED_DOMAINS: JSON.stringify(allowDomains),
    CAMOUFOX_BINARY_PATH: camoufoxBinary,
  };

  const startMs = Date.now();
  let proc: Subprocess<"ignore", "pipe", "pipe"> | null = null;
  let softTimer: ReturnType<typeof setTimeout> | null = null;
  let hardTimer: ReturnType<typeof setTimeout> | null = null;
  let softFired = false;
  let hardFired = false;

  try {
    // Use Bun.spawn with process.execPath ('bun') so the wrapper runs under
    // the same runtime as the daemon and can `import 'playwright'` from the
    // shared node_modules.
    proc = Bun.spawn({
      cmd: [process.execPath, "run", entryPath],
      cwd: dir,
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });

    inv.emit?.({
      kind: "artifact_invoked",
      substrate_origin: "substrate_auto",
      action_artifact_id: inv.artifactId,
      payload: {
        runtime: "camofox-browser",
        pid: proc.pid ?? null,
        wall_ms: wallMs,
        memory_mb: memoryMb,
        profile_root: profileRoot,
        allow_domains: allowDomains as unknown as JsonValue,
        camoufox_binary: camoufoxBinary,
      } as JsonValue,
    });

    // SIGTERM at wall_ms; SIGKILL escalation a fixed window later (independent
    // of wall_ms — firefox hung pages should hard-kill within a bounded
    // window, not after wall_ms × 2 + 1s).
    const escMs = SIGTERM_SIGKILL_ESCALATION_MS;
    softTimer = setTimeout(() => {
      softFired = true;
      try { proc?.kill("SIGTERM"); } catch (killErr) { void killErr; }
      hardTimer = setTimeout(() => {
        if (proc && proc.exitCode === null) {
          hardFired = true;
          try { proc.kill("SIGKILL"); } catch (killErr) { void killErr; }
          inv.emit?.({
            kind: "runtime_subprocess_killed",
            substrate_origin: "substrate_auto",
            action_artifact_id: inv.artifactId,
            payload: {
              runtime: "camofox-browser",
              reason: "sigterm_did_not_drain",
              escalation_ms: escMs,
              wall_ms: wallMs,
            } as JsonValue,
          });
        }
      }, escMs);
    }, Math.max(1, wallMs));

    const [stdoutText, stderrText, exitCode] = await Promise.all([
      readStream(proc.stdout),
      readStream(proc.stderr),
      proc.exited,
    ]);

    if (softTimer) clearTimeout(softTimer);
    if (hardTimer) clearTimeout(hardTimer);

    const durationMs = Date.now() - startMs;
    const stderrTail = lastBytes(stderrText, STDERR_TAIL_BYTES);

    if (softFired) {
      inv.emit?.({
        kind: "artifact_observed",
        substrate_origin: "substrate_auto",
        action_artifact_id: inv.artifactId,
        payload: { phase: "soft_timeout", signal: "SIGTERM", wall_ms: wallMs } as JsonValue,
      });
    }
    if (hardFired) {
      // Per §5.5: firefox hung-page recovery — if SIGKILL didn't drain,
      // mark the profile root quarantine_pending so the next invocation
      // gets a fresh context. We can't observe "didn't drain" reliably from
      // the parent without proc-tree probing, so we conservatively emit on
      // every hard-kill (a stricter test of "actually orphaned" lives in
      // the daemon's process-tree reaper).
      inv.emit?.({
        kind: "artifact_observed",
        substrate_origin: "substrate_auto",
        action_artifact_id: inv.artifactId,
        payload: {
          phase: "hard_kill",
          signal: "SIGKILL",
          wall_ms: wallMs,
          profile_quarantine_pending: true,
          profile_root: profileRoot,
        } as JsonValue,
      });
    }

    const irreversibleEffects = parseIrreversibleLines(stdoutText);

    if (exitCode !== 0) {
      return {
        ok: false,
        error: softFired || hardFired ? "wall_timeout" : `nonzero_exit:${exitCode}`,
        irreversibleEffects,
        durationMs,
        exitCode,
        stderrTail,
        sandboxWarnings: baseWarnings,
        profileRoot,
      };
    }

    const parsed = parseResultLine(stdoutText);
    if (!parsed.ok) {
      return {
        ok: false,
        error: parsed.reason,
        irreversibleEffects,
        durationMs,
        exitCode,
        stderrTail,
        sandboxWarnings: baseWarnings,
        profileRoot,
      };
    }

    inv.emit?.({
      kind: "artifact_observed",
      substrate_origin: "substrate_auto",
      action_artifact_id: inv.artifactId,
      payload: { phase: "completed", duration_ms: durationMs } as JsonValue,
    });

    return {
      ok: true,
      result: parsed.value,
      irreversibleEffects,
      durationMs,
      exitCode,
      stderrTail,
      sandboxWarnings: baseWarnings,
      profileRoot,
    };
  } catch (err) {
    if (softTimer) clearTimeout(softTimer);
    if (hardTimer) clearTimeout(hardTimer);
    const durationMs = Date.now() - startMs;
    return {
      ok: false,
      error: `runtime_spawn_failed:${(err as Error).message}`,
      irreversibleEffects: [],
      durationMs,
      exitCode: -1,
      stderrTail: "",
      sandboxWarnings: baseWarnings,
      profileRoot,
    };
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* swallow */ }
  }
};

// Exposed for tests — checks that the wrapper script generation is stable
// without spawning firefox.
export const __wrapBrowserBodyForTest = wrapBrowserBody;
export const __isPlaywrightInstalledForTest = isPlaywrightInstalled;
export const __resolveCamoufoxBinaryForTest = resolveCamoufoxBinary;
