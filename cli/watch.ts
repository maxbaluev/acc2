#!/usr/bin/env bun
// `acc watch` — Bun-native ANSI TUI subscribing to the daemon's SSE event
// stream. Per v2-design.md §21, the v2 watch surface subscribes to the
// daemon's event stream instead of polling SQLite. Regions (top-to-bottom,
// columns inferred at render time from process.stdout.columns):
//
//   • Active Directives (top, ~5 lines) — last N rolling-active or recently
//     opened directives.
//   • Recent Events (middle, ~20 lines) — tail of the last 30 events as they
//     stream in via SSE.
//   • Ready Tasks / Artifact Leaderboard (right column) — refreshed every
//     2s by polling substrate.read views.
//   • Daemon Health (bottom, 2 lines) — pid, uptime, events_count, ports.
//
// Keystrokes (raw mode):
//   q / Ctrl-C → exit cleanly (restore cursor + alt-buffer mode).
//   r → force a full re-render against fresh substrate reads.
//
// Implementation notes:
//   - No external TUI deps. Plain ANSI escape codes via the constants below.
//   - The alt-buffer (CSI ?1049 h/l) is entered on startup and exited on
//     teardown so the operator's existing shell scrollback is preserved.
//   - Cursor is hidden during runtime and restored on exit.
//   - Initial buffer fill via runtime.recent_events; SSE keeps it warm.
//   - Polling for the side regions runs on a 2s setInterval; the timer is
//     cleared on shutdown so the process exits cleanly.

import { mcpCall, sseConnect, type SseEvent, requireAux, rpcGet } from "./rpc";

// ── ANSI codes ─────────────────────────────────────────────────────

const CSI = "\x1b[";
const CLEAR_SCREEN = `${CSI}2J`;
const HOME = `${CSI}H`;
const HIDE_CURSOR = `${CSI}?25l`;
const SHOW_CURSOR = `${CSI}?25h`;
const ALT_ENTER = `${CSI}?1049h`;
const ALT_EXIT = `${CSI}?1049l`;
const RESET = `${CSI}0m`;
const BOLD = `${CSI}1m`;
const DIM = `${CSI}2m`;
const CYAN = `${CSI}36m`;
const GREEN = `${CSI}32m`;
const YELLOW = `${CSI}33m`;
const MAGENTA = `${CSI}35m`;

const moveTo = (row: number, col: number): string => `${CSI}${row};${col}H`;

// ── Types ──────────────────────────────────────────────────────────

type ActiveDirective = {
  directive_id: string;
  opened_ts: string;
  text: string;
  lifecycle: string;
};

type ReadyTask = {
  task_id: string;
  directive_id: string;
  goal: string;
};

type ArtifactRow = {
  id: string;
  runtime: string;
  score: number;
  status: string;
  name: string | null;
};

type DaemonHealth = {
  pid?: number;
  uptime_ms?: number;
  events_count?: number;
  mcp_port?: number;
  aux_port?: number;
};

type EventRow = {
  event_id: string;
  ts: string;
  kind: string;
  directive_id?: string;
  task_id?: string;
  payload?: unknown;
};

export type WatchState = {
  events: EventRow[]; // ts-ASC, max length = MAX_EVENTS
  active: ActiveDirective[];
  ready: ReadyTask[];
  artifacts: ArtifactRow[];
  health: DaemonHealth;
};

const MAX_EVENTS = 30;
const MAX_ACTIVE = 5;
const MAX_READY = 10;
const MAX_ARTIFACTS = 10;

// ── State helpers ──────────────────────────────────────────────────

const emptyState = (): WatchState => ({
  events: [],
  active: [],
  ready: [],
  artifacts: [],
  health: {},
});

const truncate = (s: string, max: number): string => {
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 1)) + "…";
};

const pad = (s: string, width: number): string => {
  if (s.length >= width) return s.slice(0, width);
  return s + " ".repeat(width - s.length);
};

// ── Substrate reads ─────────────────────────────────────────────────

const readActiveDirectives = async (): Promise<ActiveDirective[]> => {
  try {
    const env = await mcpCall("substrate.read", { view_name: "active_objectives_view" });
    if (!env.ok) return [];
    const rows = (env.result as Array<Record<string, unknown>>).slice(0, MAX_ACTIVE);
    return rows.map((r) => {
      const payload = (r.payload ?? {}) as Record<string, unknown>;
      const text =
        typeof payload.text === "string" ? payload.text :
        typeof payload.directive_text === "string" ? payload.directive_text :
        typeof payload.goal === "string" ? payload.goal :
        "(no text)";
      const lifecycle =
        typeof payload.lifecycle === "string" ? payload.lifecycle : "finite";
      return {
        directive_id: r.directive_id as string,
        opened_ts: r.opened_ts as string,
        text,
        lifecycle,
      };
    });
  } catch { return []; }
};

const readReadyTasks = async (): Promise<ReadyTask[]> => {
  try {
    const env = await mcpCall("substrate.read", { view_name: "ready_tasks_view", args: { limit: MAX_READY } });
    if (!env.ok) return [];
    const rows = (env.result as Array<Record<string, unknown>>).slice(0, MAX_READY);
    return rows.map((r) => {
      const payload = (r.payload ?? {}) as Record<string, unknown>;
      const goal = typeof payload.goal === "string" ? payload.goal : "(no goal)";
      return {
        task_id: r.task_id as string,
        directive_id: r.directive_id as string,
        goal,
      };
    });
  } catch { return []; }
};

const readArtifactLeaderboard = async (): Promise<ArtifactRow[]> => {
  try {
    const env = await mcpCall("substrate.read", { view_name: "code_artifact_registry_view" });
    if (!env.ok) return [];
    const rows = (env.result as Array<Record<string, unknown>>).slice(0, MAX_ARTIFACTS);
    return rows.map((r) => ({
      id: r.id as string,
      runtime: r.runtime as string,
      score: typeof r.score === "number" ? r.score : 0,
      status: (r.status as string) ?? "unknown",
      name: (r.name as string | null) ?? null,
    }));
  } catch { return []; }
};

const readHealth = async (): Promise<DaemonHealth> => {
  try {
    const base = requireAux();
    return await rpcGet<DaemonHealth>(`${base}/health`);
  } catch { return {}; }
};

const readRecentEvents = async (): Promise<EventRow[]> => {
  try {
    const env = await mcpCall("runtime.recent_events", { k: MAX_EVENTS });
    if (!env.ok) return [];
    const data = env.result as { events?: Array<Record<string, unknown>> };
    const evs = data.events ?? [];
    return evs.map((e) => ({
      event_id: e.event_id as string,
      ts: e.ts as string,
      kind: e.kind as string,
      directive_id: e.directive_id as string | undefined,
      task_id: e.task_id as string | undefined,
      payload: e.payload,
    }));
  } catch { return []; }
};

// ── Rendering ──────────────────────────────────────────────────────

const formatPayloadPreview = (payload: unknown): string => {
  if (payload === null || payload === undefined) return "";
  try {
    const s = typeof payload === "string" ? payload : JSON.stringify(payload);
    return truncate(s.replace(/\s+/g, " "), 60);
  } catch { return ""; }
};

const shortId = (s: string | undefined): string => {
  if (!s) return "—".padEnd(12);
  return s.slice(0, 12).padEnd(12);
};

/** Render the full screen as one string. Pure function over state + screen
 *  dimensions; tests drive this directly so the TUI is verifiable without a
 *  real TTY. */
export const renderFrame = (
  state: WatchState,
  cols: number,
  rows: number,
): string => {
  const parts: string[] = [];
  parts.push(CLEAR_SCREEN);
  parts.push(HOME);

  const safeCols = Math.max(40, cols);
  const safeRows = Math.max(20, rows);

  // Layout: split right column 40 cols at col=safeCols-39, main area to the left.
  const rightWidth = Math.min(45, Math.floor(safeCols / 2.5));
  const leftWidth = safeCols - rightWidth - 1;

  // Row 1: header.
  parts.push(moveTo(1, 1));
  parts.push(`${BOLD}${CYAN}acc watch${RESET}  ${DIM}q=quit  r=refresh${RESET}`);

  // Row 3-7: Active Directives (5 lines visible)
  parts.push(moveTo(3, 1));
  parts.push(`${BOLD}Active Directives${RESET}`);
  for (let i = 0; i < MAX_ACTIVE; i++) {
    parts.push(moveTo(4 + i, 1));
    const d = state.active[i];
    if (!d) {
      parts.push(pad("", leftWidth));
      continue;
    }
    const tag = d.lifecycle === "rolling_active" ? `${MAGENTA}[rolling]${RESET}` : `${DIM}[finite] ${RESET}`;
    const line = `${tag} ${shortId(d.directive_id)} ${truncate(d.text, Math.max(20, leftWidth - 28))}`;
    parts.push(pad(line, leftWidth));
  }

  // Row 9: Recent Events header.
  const eventsTopRow = 9;
  parts.push(moveTo(eventsTopRow, 1));
  parts.push(`${BOLD}Recent Events${RESET} ${DIM}(${state.events.length}/${MAX_EVENTS})${RESET}`);
  const maxEventRows = Math.max(5, safeRows - eventsTopRow - 3);
  // Show the LAST `maxEventRows` events; if fewer, leave blank lines.
  const start = Math.max(0, state.events.length - maxEventRows);
  for (let i = 0; i < maxEventRows; i++) {
    const r = eventsTopRow + 1 + i;
    parts.push(moveTo(r, 1));
    const ev = state.events[start + i];
    if (!ev) { parts.push(pad("", leftWidth)); continue; }
    const ts = ev.ts.slice(11, 19); // HH:MM:SS
    const kind = pad(truncate(ev.kind, 28), 28);
    const did = shortId(ev.directive_id);
    const preview = formatPayloadPreview(ev.payload);
    const line = `${DIM}${ts}${RESET}  ${kind}  ${did}  ${preview}`;
    parts.push(pad(line, leftWidth));
  }

  // Right column: Ready Tasks (top half) + Artifacts (bottom half).
  const rightCol = leftWidth + 2;
  parts.push(moveTo(3, rightCol));
  parts.push(`${BOLD}Ready Tasks${RESET} ${DIM}(${state.ready.length})${RESET}`);
  for (let i = 0; i < MAX_READY; i++) {
    parts.push(moveTo(4 + i, rightCol));
    const t = state.ready[i];
    if (!t) { parts.push(pad("", rightWidth)); continue; }
    const line = `${GREEN}${shortId(t.task_id)}${RESET} ${truncate(t.goal, Math.max(8, rightWidth - 14))}`;
    parts.push(pad(line, rightWidth));
  }

  const artRow = 4 + MAX_READY + 1;
  parts.push(moveTo(artRow, rightCol));
  parts.push(`${BOLD}Top Artifacts${RESET} ${DIM}(score)${RESET}`);
  for (let i = 0; i < MAX_ARTIFACTS; i++) {
    parts.push(moveTo(artRow + 1 + i, rightCol));
    const a = state.artifacts[i];
    if (!a) { parts.push(pad("", rightWidth)); continue; }
    const scoreStr = a.score.toFixed(2);
    const label = a.name ?? a.id;
    const line = `${YELLOW}${scoreStr}${RESET} ${pad(a.runtime, 8)} ${truncate(label, Math.max(8, rightWidth - 16))}`;
    parts.push(pad(line, rightWidth));
  }

  // Bottom 2 lines: Daemon Health.
  const hRow = safeRows - 1;
  parts.push(moveTo(hRow, 1));
  parts.push(`${BOLD}Daemon${RESET}`);
  parts.push(moveTo(hRow + 1, 1));
  const h = state.health;
  const healthLine = `pid=${h.pid ?? "?"}  uptime_ms=${h.uptime_ms ?? 0}  events=${h.events_count ?? 0}  mcp=${h.mcp_port ?? "?"}  aux=${h.aux_port ?? "?"}`;
  parts.push(truncate(healthLine, safeCols));

  return parts.join("");
};

// ── Run loop ───────────────────────────────────────────────────────

const POLL_INTERVAL_MS = 2000;

export type RunWatchOpts = {
  /** Stop after this many ms — used by tests. Default: run until signal/key. */
  durationMs?: number;
  /** Write rendered frames here instead of process.stdout. */
  writer?: (s: string) => void;
  /** Override poll interval (ms). Default: 2000. */
  pollIntervalMs?: number;
  /** Cancel from outside. */
  signal?: AbortSignal;
  /** Skip the SSE subscription (tests can feed events directly via injected
   *  recent-events polling). Default false. */
  disableSse?: boolean;
};

const refreshAll = async (state: WatchState): Promise<void> => {
  const [active, ready, artifacts, health, events] = await Promise.all([
    readActiveDirectives(),
    readReadyTasks(),
    readArtifactLeaderboard(),
    readHealth(),
    state.events.length === 0 ? readRecentEvents() : Promise.resolve(state.events),
  ]);
  state.active = active;
  state.ready = ready;
  state.artifacts = artifacts;
  state.health = health;
  state.events = events;
};

const refreshSideRegions = async (state: WatchState): Promise<void> => {
  const [active, ready, artifacts, health] = await Promise.all([
    readActiveDirectives(),
    readReadyTasks(),
    readArtifactLeaderboard(),
    readHealth(),
  ]);
  state.active = active;
  state.ready = ready;
  state.artifacts = artifacts;
  state.health = health;
};

const appendEvent = (state: WatchState, ev: SseEvent): void => {
  state.events.push({
    event_id: ev.event_id,
    ts: ev.ts,
    kind: ev.kind,
    directive_id: ev.directive_id,
    task_id: ev.task_id,
    payload: ev.payload,
  });
  if (state.events.length > MAX_EVENTS) {
    state.events.splice(0, state.events.length - MAX_EVENTS);
  }
};

const screenDims = (): { cols: number; rows: number } => {
  const cols = (process.stdout as { columns?: number }).columns ?? 120;
  const rows = (process.stdout as { rows?: number }).rows ?? 40;
  return { cols, rows };
};

/** Programmatic entry — driven by tests and by the CLI dispatcher. Returns
 *  the process exit code (0 on clean exit). */
export const runWatch = async (argv: string[], opts: RunWatchOpts = {}): Promise<number> => {
  void argv; // no flags in 1.β
  const writer = opts.writer ?? ((s: string) => { process.stdout.write(s); });
  const pollMs = opts.pollIntervalMs ?? POLL_INTERVAL_MS;
  const state = emptyState();
  const isInteractive = !opts.writer && !!process.stdout.isTTY;

  // Initial full read so the first frame shows something.
  await refreshAll(state);
  const initial = screenDims();
  if (isInteractive) writer(ALT_ENTER + HIDE_CURSOR);
  writer(renderFrame(state, initial.cols, initial.rows));

  // SSE subscription — events go through appendEvent + re-render.
  const sseAbort = new AbortController();
  const onAbort = () => sseAbort.abort();
  opts.signal?.addEventListener("abort", onAbort, { once: true });

  const renderTick = (): void => {
    const dims = screenDims();
    writer(renderFrame(state, dims.cols, dims.rows));
  };

  const sseLoop = async (): Promise<void> => {
    if (opts.disableSse) return;
    try {
      for await (const ev of sseConnect({ signal: sseAbort.signal })) {
        appendEvent(state, ev);
        renderTick();
      }
    } catch { /* swallow — backoff loop handles disconnect */ }
  };

  const ssePromise = sseLoop();

  const pollTimer = setInterval(() => {
    void refreshSideRegions(state).then(renderTick).catch(() => { /* swallow */ });
  }, pollMs);

  // Raw-mode keystroke handling — only when running on a real TTY and no
  // custom writer was supplied. Tests drive the loop programmatically.
  const stdin = process.stdin as NodeJS.ReadStream & { setRawMode?: (b: boolean) => void };
  const wasRaw = stdin.isRaw;
  let exitCode = 0;
  const keyResolver: { resolve: ((v: void) => void) | null } = { resolve: null };
  const keyPromise = new Promise<void>((resolve) => { keyResolver.resolve = resolve; });
  let keyHandler: ((chunk: Buffer | string) => void) | null = null;
  if (isInteractive && typeof stdin.setRawMode === "function") {
    stdin.setRawMode(true);
    stdin.resume();
    keyHandler = (chunk: Buffer | string) => {
      const str = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      if (str === "q" || str === "Q" || str === "") {
        keyResolver.resolve?.();
        return;
      }
      if (str === "r" || str === "R") {
        void refreshAll(state).then(renderTick).catch(() => { /* swallow */ });
      }
    };
    stdin.on("data", keyHandler);
  }

  // Duration-bounded run (tests). On signal abort or duration timeout, exit.
  const durationPromise = opts.durationMs
    ? new Promise<void>((resolve) => { setTimeout(() => resolve(), opts.durationMs); })
    : new Promise<void>(() => { /* never */ });
  const signalPromise = new Promise<void>((resolve) => {
    if (opts.signal?.aborted) { resolve(); return; }
    opts.signal?.addEventListener("abort", () => resolve(), { once: true });
  });

  // SIGINT — wire only when interactive so tests don't fight signal handlers.
  const sigintHandler = (): void => { keyResolver.resolve?.(); };
  if (isInteractive) process.once("SIGINT", sigintHandler);

  try {
    await Promise.race([keyPromise, durationPromise, signalPromise]);
  } finally {
    clearInterval(pollTimer);
    sseAbort.abort();
    if (keyHandler) stdin.off("data", keyHandler);
    if (isInteractive && typeof stdin.setRawMode === "function") {
      stdin.setRawMode(!!wasRaw);
      stdin.pause();
    }
    if (isInteractive) {
      writer(SHOW_CURSOR + ALT_EXIT + RESET);
      try { process.off("SIGINT", sigintHandler); } catch { /* swallow */ }
    }
    opts.signal?.removeEventListener("abort", onAbort);
    try { await ssePromise; } catch { /* swallow */ }
  }
  return exitCode;
};

if (import.meta.main) {
  void runWatch(process.argv.slice(2)).then((code) => process.exit(code));
}
