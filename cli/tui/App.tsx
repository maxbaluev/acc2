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
  type DashboardSnapshot,
  type ToastEvent,
} from "./state/store";
import type { SubstrateClient } from "./transport/substrate-client";

const REFRESH_MS = 5_000;
const TOAST_MAX = 3;
const TOAST_TTL_MS = 12_000;

export type DrawerName = "events" | "health" | "lineage" | "profile" | "inbox" | "brain" | null;

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
          const toast = sseEventToToast(event);
          if (!toast) continue;
          // SSE reconnect can replay the same event_id; React's child-key
          // uniqueness check throws "Encountered two children with the same
          // key" if we don't dedupe at insertion. Drop duplicates by id.
          setToasts((prev) => {
            if (prev.some((t) => t.event_id === toast.event_id)) return prev;
            return [toast, ...prev].slice(0, TOAST_MAX);
          });
        }
      } catch {
        // SSE disconnect is benign; the next poll cycle re-establishes.
      }
    })();
    return () => { controller.abort(); };
  }, [pollDisabled, client]);

  useEffect(() => {
    if (toasts.length === 0) return;
    const id = setTimeout(() => { setToasts((prev) => prev.slice(0, -1)); }, TOAST_TTL_MS);
    return () => { clearTimeout(id); };
  }, [toasts]);

  const handleCommand = useCallback((intent: CommandIntent) => {
    if (intent.kind === "exit") { exit(); return; }
    if (intent.kind === "noop") return;
    setLastCommand(intent.raw);
    if (onCommand) { onCommand(intent); return; }
    void (async () => {
      const result = await dispatchShell(intent.argv);
      setLastResult(result);
      await refresh();
    })();
  }, [onCommand, exit, refresh]);

  useInput((input, key) => {
    if (paletteActive) {
      // Allow ESC to leave the palette and accept hotkeys; otherwise
      // CommandPalette consumes the keys.
      if (key.escape) { setPaletteActive(false); return; }
      return;
    }
    if (input === ":") { setPaletteActive(true); return; }
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
          arrows=focus  i=inbox  a=brain  p=profile  e=events  h=health  l=lineage  :=palette  q=quit
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
