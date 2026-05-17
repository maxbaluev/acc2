// cli/tui/App.tsx — root Ink component for `acc watch`.
//
// Responsibilities:
//   - Poll fetchDashboardSnapshot every REFRESH_MS so the six panels stay live.
//   - Subscribe to substrate SSE and project MIRROR_INLINE_EVENT_TYPES events
//     into a rolling toast banner (max 3 visible).
//   - Route keyboard input:
//       arrows  cycle focus through the six panels
//       Enter   no-op (placeholder for "zoom" if focus is on a panel)
//       e/h/l/p toggle drawers (events / health / lineage / profile)
//       i       toggle Inbox detail
//       :       jump cursor into the command palette
//       q       quit
//   - Forward palette intents to a Bash spawn that runs `acc <argv>`.
//     The spawned process inherits the parent shell's stdio so output
//     prints below the TUI on exit, and the TUI is restored on the next
//     repaint. (For `task` invocations the spawn is detached so the
//     brain run can continue across TUI restarts.)
//
// All state lives in React state — no module-level singletons — so the
// component is fully testable with ink-testing-library.

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import { spawn } from "node:child_process";
import { Dashboard, FOCUS_ORDER, type FocusName } from "./screens/Dashboard";
import { InboxScreen } from "./screens/Inbox";
import { ProfileScreen } from "./screens/Profile";
import { StatusLine } from "./components/StatusLine";
import { CommandPalette, type CommandIntent } from "./components/CommandPalette";
import {
  fetchDashboardSnapshot,
  initialSnapshot,
  sseEventToToast,
  sseEventToLive,
  reactiveSectionsFor,
  LIVE_TAIL_CAP,
  type DashboardSnapshot,
  type ToastEvent,
  type LiveEvent,
} from "./state/store";
import type { SubstrateClient } from "./transport/substrate-client";

const REFRESH_MS = 5_000;
const TOAST_MAX = 3;
const TOAST_TTL_MS = 12_000;

export type DrawerName = "events" | "health" | "lineage" | "profile" | "inbox" | "brain" | "tail" | "inspector" | null;

export type AppProps = {
  client: SubstrateClient;
  /** When set, replaces `bun run acc ...` with a callback. Useful in tests. */
  onCommand?: (intent: CommandIntent) => void;
  /** Disable polling/SSE for tests so the dashboard renders deterministically. */
  pollDisabled?: boolean;
  /** Pre-seeded snapshot (tests). */
  initial?: DashboardSnapshot;
  /** Open a drawer at mount (tests bypass the keypress dance). */
  initialDrawer?: DrawerName;
};

export type ShellResult = {
  ok: boolean;
  argv: string[];
  exit_code: number | null;
  summary: string;
};

// Spawn `bun run acc <argv>`, capturing stdout/stderr so the operator's
// raw-mode TUI display is never corrupted by inherited writes. Returns a
// one-line summary the caller pushes into the toast surface.
//
// For `task` (long-running brain dispatch) we detach + ignore so the brain
// keeps running across TUI restarts; the operator polls progress through
// dispatch_resolved_view, not stdout.
const dispatchShell = (argv: string[]): Promise<ShellResult> => {
  return new Promise((resolve) => {
    if (argv.length === 0) {
      resolve({ ok: false, argv, exit_code: null, summary: "(empty command)" });
      return;
    }
    const head = argv[0];
    if (head === "task") {
      // Detached, fire-and-forget; report dispatched.
      const child = spawn("bun", ["run", "acc", ...argv], { stdio: "ignore", detached: true });
      child.unref();
      resolve({ ok: true, argv, exit_code: null, summary: `task dispatched (background, pid=${child.pid ?? "?"})` });
      return;
    }
    const child = spawn("bun", ["run", "acc", ...argv], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.on("close", (code) => {
      const ok = code === 0;
      const out = (stdout + stderr).trim();
      const firstLine = out.split("\n").find((l) => l.trim().length > 0) ?? "";
      const summary = firstLine
        ? firstLine.length > 120 ? firstLine.slice(0, 119) + "…" : firstLine
        : ok ? `${head} ok (exit=${code})` : `${head} failed (exit=${code})`;
      resolve({ ok, argv, exit_code: code, summary });
    });
    child.on("error", (err) => {
      resolve({ ok: false, argv, exit_code: null, summary: `${head} spawn error: ${err.message}` });
    });
  });
};

export const App = ({ client, onCommand, pollDisabled, initial, initialDrawer }: AppProps): React.ReactElement => {
  const { exit } = useApp();
  const [snapshot, setSnapshot] = useState<DashboardSnapshot>(initial ?? initialSnapshot());
  const [focus, setFocus] = useState<FocusName>("inbox");
  const [drawer, setDrawer] = useState<DrawerName>(initialDrawer ?? null);
  const [paletteActive, setPaletteActive] = useState(initialDrawer ? false : true);
  const [toasts, setToasts] = useState<ToastEvent[]>([]);
  const [lastCommand, setLastCommand] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<ShellResult | null>(null);
  const [paletteBuffer, setPaletteBuffer] = useState("");
  // SSE-pushed live event ring buffer. Every SSE event is appended (cap
  // LIVE_TAIL_CAP) so the Live Tail drawer ('t') and Event Inspector
  // ('x') can render without an extra MCP round-trip. Reactivity:
  // events flow into the buffer in real time, and per-kind classification
  // triggers a section refresh (brain/dispatch/changes/inbox) so the
  // owner-visible counts update immediately instead of waiting for the
  // 5s poll backstop.
  const [liveEvents, setLiveEvents] = useState<LiveEvent[]>([]);
  // Event Inspector pinned event_id — when set, the inspector drawer
  // renders that specific event's full content.
  const [inspectorEventId, setInspectorEventId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const next = await fetchDashboardSnapshot(client);
      setSnapshot(next);
    } catch (err) {
      setSnapshot((prev) => ({ ...prev, loading: false, error: (err as Error).message }));
    }
  }, [client]);

  useEffect(() => {
    if (pollDisabled) return;
    let cancelled = false;
    const tick = async () => {
      if (cancelled) return;
      await refresh();
    };
    void tick();
    const id = setInterval(() => { void tick(); }, REFRESH_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [pollDisabled, refresh]);

  useEffect(() => {
    if (pollDisabled) return;
    const controller = new AbortController();
    (async () => {
      try {
        for await (const event of client.sseConnect({ signal: controller.signal })) {
          // 1) Mirror-inline events become toast banners (existing behavior).
          const toast = sseEventToToast(event);
          if (toast) {
            setToasts((prev) => {
              if (prev.some((t) => t.event_id === toast.event_id)) return prev;
              return [toast, ...prev].slice(0, TOAST_MAX);
            });
          }
          // 2) Every SSE event (any kind) lands in the live ring buffer so
          //    the Live Tail drawer and Event Inspector can render without
          //    extra MCP round-trips.
          const live = sseEventToLive(event);
          setLiveEvents((prev) => {
            if (prev.length > 0 && prev[0]?.event_id === live.event_id) return prev;
            const next = [live, ...prev];
            return next.length > LIVE_TAIL_CAP ? next.slice(0, LIVE_TAIL_CAP) : next;
          });
          // 3) Trigger per-section reactive refresh when the kind affects
          //    a specific dashboard panel. This is the push-based replacement
          //    for the 5s poll lag — counts/lists update as events land.
          const sections = reactiveSectionsFor(String(event.kind));
          if (sections.size > 0) {
            void refresh();
          }
        }
      } catch {
        // SSE disconnect is benign; the next poll cycle re-establishes.
      }
    })();
    return () => { controller.abort(); };
  }, [pollDisabled, client, refresh]);

  useEffect(() => {
    if (toasts.length === 0) return;
    const id = setTimeout(() => { setToasts((prev) => prev.slice(0, -1)); }, TOAST_TTL_MS);
    return () => { clearTimeout(id); };
  }, [toasts]);

  const handleCommand = useCallback((intent: CommandIntent) => {
    if (intent.kind === "exit") { exit(); return; }
    if (intent.kind === "noop") return;
    setLastCommand(intent.raw);
    // Local-only intents — `__tui__` sentinel argv handled WITHOUT
    // spawning a subprocess. Routes drawer toggles typed in the palette
    // (e.g. `tail`) directly into App state. Real shells (acc task,
    // acc apply, etc.) take the spawn path below.
    if (intent.kind === "shell" && intent.argv[0] === "__tui__") {
      const sub = intent.argv[1];
      if (sub === "tail") {
        setDrawer((d) => d === "tail" ? null : "tail");
      }
      return;
    }
    // `inspect <id>` short-circuits to pin the inspector drawer to that
    // event_id without spawning. The owner sees the live-buffer payload
    // immediately; the subprocess spawn still runs in parallel so MCP-
    // fetched detail is available if the event isn't in the buffer.
    if (intent.kind === "shell" && intent.argv[0] === "events" && intent.argv[1] === "--id" && intent.argv[2]) {
      setInspectorEventId(intent.argv[2]);
      setDrawer("inspector");
    }
    if (onCommand) { onCommand(intent); return; }
    void (async () => {
      const result = await dispatchShell(intent.argv);
      setLastResult(result);
      await refresh();
    })();
  }, [onCommand, exit, refresh]);

  useInput((input, key) => {
    // Key routing model:
    //   buffer has content  → palette owns ALL keys (typing into the
    //                         command line). ESC clears and exits palette.
    //   buffer is empty     → hotkey letters {i,a,p,e,h,l,q} + arrows +
    //                         ':' fire App-level handlers. Other letters
    //                         (typing the start of "task", "apply",
    //                         "whoami", "changes", "decline", "directive"
    //                         etc.) fall through so the palette accumulates
    //                         them — without requiring ESC first.
    const bufferEmpty = paletteBuffer.length === 0;
    if (!bufferEmpty) {
      if (key.escape) { setPaletteActive(false); setPaletteBuffer(""); return; }
      return;
    }
    if (key.escape && paletteActive) { setPaletteActive(false); return; }
    if (input === ":") { setPaletteActive(true); return; }
    // Single-letter hotkeys ONLY when buffer is empty. Any letter not in
    // this set falls through to the palette's useInput which appends it.
    if (input === "q") { exit(); return; }
    if (input === "e") { setDrawer((d) => d === "events" ? null : "events"); return; }
    if (input === "h") { setDrawer((d) => d === "health" ? null : "health"); return; }
    if (input === "l") { setDrawer((d) => d === "lineage" ? null : "lineage"); return; }
    if (input === "p") { setDrawer((d) => d === "profile" ? null : "profile"); return; }
    if (input === "i") { setDrawer((d) => d === "inbox" ? null : "inbox"); return; }
    if (input === "a") { setDrawer((d) => d === "brain" ? null : "brain"); return; }
    if (key.leftArrow || key.upArrow) {
      const idx = FOCUS_ORDER.indexOf(focus);
      setFocus(FOCUS_ORDER[(idx - 1 + FOCUS_ORDER.length) % FOCUS_ORDER.length]!);
      return;
    }
    if (key.rightArrow || key.downArrow || key.tab) {
      const idx = FOCUS_ORDER.indexOf(focus);
      setFocus(FOCUS_ORDER[(idx + 1) % FOCUS_ORDER.length]!);
      return;
    }
  });

  const ownerRenderProfile = useMemo(() => ({
    detected_language: snapshot.owner_profile.detected_language,
    preferred_terms: snapshot.owner_profile.preferred_terms,
    avoided_terms: snapshot.owner_profile.avoided_terms,
  }), [snapshot.owner_profile]);

  return (
    <Box flexDirection="column">
      <StatusLine
        detected_language={snapshot.owner_profile.detected_language ?? null}
        autonomy_score={snapshot.owner_profile.autonomy_score ?? null}
        autonomy_floor={snapshot.owner_profile.autonomy_score_floor ?? null}
        health={snapshot.health}
        ownerProfile={ownerRenderProfile}
      />

      {drawer === null ? (
        <Dashboard snapshot={snapshot} focus={focus} />
      ) : drawer === "inbox" ? (
        <InboxScreen rows={snapshot.pending_decisions} total={snapshot.pending_decisions_total} />
      ) : drawer === "profile" ? (
        <ProfileScreen profile={snapshot.owner_profile} />
      ) : drawer === "events" ? (
        <Box borderStyle="round" borderColor="cyan" flexDirection="column" paddingX={1}>
          <Text bold color="cyan">recent mirror-inline events (e to close)</Text>
          {toasts.length === 0 ? (
            <Text dimColor>(no recent mirror-inline events yet)</Text>
          ) : (
            toasts.map((t) => (
              <Box key={t.event_id}>
                <Text color="yellow">{t.kind}</Text>
                <Text dimColor> </Text>
                <Text dimColor>{t.ts}</Text>
                <Text> </Text>
                <Text>{t.summary}</Text>
              </Box>
            ))
          )}
        </Box>
      ) : drawer === "health" ? (
        <Box borderStyle="round" borderColor="cyan" flexDirection="column" paddingX={1}>
          <Text bold color="cyan">substrate health (h to close)</Text>
          <Text>daemon_status={snapshot.health.daemon_status}</Text>
          <Text>verdict={snapshot.health.verdict}</Text>
          <Text>uptime_s={snapshot.health.uptime_s ?? "?"}</Text>
          <Text>events_count={snapshot.health.events_count ?? "?"}</Text>
          <Text>bridge_failures_1h={snapshot.health.bridge_recent_failures}</Text>
          <Text>bridge_completions_1h={snapshot.health.bridge_recent_completions}</Text>
        </Box>
      ) : drawer === "brain" ? (
        <Box borderStyle="round" borderColor="magenta" flexDirection="column" paddingX={1}>
          <Text bold color="magenta">BRAIN ACTIVITY (a to close) — pending amendments: {snapshot.brain_activity.pending_amendment_count}</Text>
          <Text dimColor>recent contract amendments (newest first, ✓=applied)</Text>
          {snapshot.brain_activity.amendments.length === 0 ? (
            <Text dimColor>(none in last 30 events)</Text>
          ) : (
            snapshot.brain_activity.amendments.map((a) => (
              <Box key={a.event_id} flexDirection="column">
                <Text>
                  <Text color={a.applied ? "green" : a.has_diff ? "yellow" : "red"}>
                    {a.applied ? "✓" : a.has_diff ? "·" : "✗"}
                  </Text>
                  <Text color="yellow"> {a.event_id.slice(0, 12)}</Text>
                  <Text dimColor> {a.ts.slice(11, 19)}</Text>
                  <Text> {a.target.slice(0, 36)}</Text>
                  {!a.has_diff ? <Text color="red"> (described-only)</Text> : null}
                </Text>
                {a.anchor ? <Text dimColor>    anchor={a.anchor.slice(0, 70)}</Text> : null}
              </Box>
            ))
          )}
          <Text> </Text>
          <Text dimColor>recent lessons (newest first)</Text>
          {snapshot.brain_activity.lessons.length === 0 ? (
            <Text dimColor>(none)</Text>
          ) : (
            snapshot.brain_activity.lessons.slice(0, 4).map((l) => (
              <Text key={l.event_id}>
                <Text dimColor>{l.ts.slice(11, 19)} </Text>
                <Text>{l.summary}</Text>
              </Text>
            ))
          )}
          <Text> </Text>
          <Text dimColor>recent knowledge candidates (newest first)</Text>
          {snapshot.brain_activity.knowledge.length === 0 ? (
            <Text dimColor>(none)</Text>
          ) : (
            snapshot.brain_activity.knowledge.slice(0, 4).map((k) => (
              <Text key={k.event_id}>
                <Text dimColor>{k.ts.slice(11, 19)} </Text>
                <Text>{k.claim}</Text>
              </Text>
            ))
          )}
          <Box marginTop={1}>
            <Text dimColor>type </Text>
            <Text color="green">apply ⟨event_id⟩</Text>
            <Text dimColor> in the command palette to apply an amendment</Text>
          </Box>
        </Box>
      ) : drawer === "tail" ? (
        <Box borderStyle="round" borderColor="green" flexDirection="column" paddingX={1}>
          <Text bold color="green">LIVE TAIL (t to close) — last {Math.min(liveEvents.length, 24)} of {liveEvents.length} events (push, SSE)</Text>
          {liveEvents.length === 0 ? (
            <Text dimColor>(no SSE events received yet — waiting for daemon stream)</Text>
          ) : (
            liveEvents.slice(0, 24).map((e) => {
              const dir = (e.directive_id ?? "-").slice(0, 10);
              const task = (e.task_id ?? "-").slice(0, 10);
              const origin = (e.substrate_origin ?? "?").slice(0, 14);
              return (
                <Text key={e.event_id}>
                  <Text dimColor>{e.ts.slice(11, 19)} </Text>
                  <Text color="yellow">{e.event_id.slice(0, 12)} </Text>
                  <Text color="cyan">{e.kind.padEnd(30).slice(0, 30)} </Text>
                  <Text dimColor>dir={dir} task={task} origin={origin}</Text>
                </Text>
              );
            })
          )}
          <Box marginTop={1}>
            <Text dimColor>press </Text>
            <Text color="yellow">x</Text>
            <Text dimColor> + type any event_id from this list to open Event Inspector for full payload</Text>
          </Box>
        </Box>
      ) : drawer === "inspector" ? (
        <Box borderStyle="round" borderColor="cyan" flexDirection="column" paddingX={1}>
          <Text bold color="cyan">EVENT INSPECTOR (x to close) — id: {inspectorEventId ?? "(none — type 'inspect &lt;id&gt;' in palette)"}</Text>
          {(() => {
            if (!inspectorEventId) return <Text dimColor>(no event pinned — most-recent SSE event will load on next 'x')</Text>;
            const ev = liveEvents.find((e) => e.event_id === inspectorEventId || e.event_id.startsWith(inspectorEventId));
            if (!ev) return <Text color="yellow">event id {inspectorEventId} not in live buffer — run `acc inspect {inspectorEventId}` in palette to load via MCP</Text>;
            const payloadText = (() => {
              try { return JSON.stringify(ev.payload, null, 2); }
              catch { return String(ev.payload); }
            })();
            const lines = payloadText.split("\n").slice(0, 24);
            return (
              <>
                <Text>
                  <Text dimColor>kind=</Text><Text color="cyan">{ev.kind}</Text>
                  <Text dimColor> ts=</Text><Text>{ev.ts}</Text>
                </Text>
                <Text>
                  <Text dimColor>directive=</Text><Text>{ev.directive_id ?? "-"}</Text>
                  <Text dimColor> task=</Text><Text>{ev.task_id ?? "-"}</Text>
                  <Text dimColor> origin=</Text><Text>{ev.substrate_origin ?? "-"}</Text>
                </Text>
                {ev.context_refs.length > 0 ? (
                  <Text>
                    <Text dimColor>context_refs ({ev.context_refs.length}): </Text>
                    <Text color="yellow">{ev.context_refs.slice(0, 4).map((r) => r.slice(0, 12)).join(", ")}</Text>
                    {ev.context_refs.length > 4 ? <Text dimColor> +{ev.context_refs.length - 4}</Text> : null}
                  </Text>
                ) : null}
                <Text dimColor>──── payload ────</Text>
                {lines.map((l, i) => <Text key={`${ev.event_id}-${i}`}>{l.slice(0, 180)}</Text>)}
                {payloadText.split("\n").length > 24 ? <Text dimColor>… (+{payloadText.split("\n").length - 24} more lines truncated)</Text> : null}
              </>
            );
          })()}
        </Box>
      ) : drawer === "lineage" ? (
        <Box borderStyle="round" borderColor="cyan" flexDirection="column" paddingX={1}>
          <Text bold color="cyan">lineage walker (l to close)</Text>
          <Text dimColor>type</Text>
          <Text> directive ⟨id⟩</Text>
          <Text dimColor> in the command palette to walk a directive's task graph</Text>
        </Box>
      ) : null}

      {drawer === null && toasts.length > 0 ? (
        <Box borderStyle="single" borderColor="yellow" flexDirection="column" paddingX={1}>
          <Text bold color="yellow">mirror-inline:</Text>
          {toasts.slice(0, 2).map((t) => (
            <Box key={t.event_id}>
              <Text color="yellow">{t.kind}</Text>
              <Text> </Text>
              <Text>{t.summary}</Text>
            </Box>
          ))}
        </Box>
      ) : null}

      <CommandPalette
        active={paletteActive}
        hint={lastCommand ? `last: ${lastCommand}` : undefined}
        onSubmit={handleCommand}
        buffer={paletteBuffer}
        onBufferChange={setPaletteBuffer}
      />

      {lastResult ? (
        <Box paddingX={1}>
          <Text color={lastResult.ok ? "green" : "red"}>
            {lastResult.ok ? "✓" : "✗"} {lastResult.argv.join(" ")}:
          </Text>
          <Text> </Text>
          <Text>{lastResult.summary}</Text>
        </Box>
      ) : null}

      <Box paddingX={1}>
        <Text dimColor>
          arrows=focus  i=inbox  a=brain  p=profile  e=events  h=health  l=lineage  q=quit  •  type `tail` / `inspect ⟨id⟩` for drawers
        </Text>
      </Box>

      {snapshot.error ? (
        <Box paddingX={1}>
          <Text color="red">error: {snapshot.error}</Text>
        </Box>
      ) : null}
    </Box>
  );
};
