// acc2 TUI — substrate-content-first realtime view.
//
// Rewrite per brain design D9TBCHADS97DHAMNBC686HE3P0 (2026-05-17),
// residual=0.16. Owner frustration text (XR3REA7Q7X197AASRH3QXNFF84):
// "we have complicated CLI where we cant understand substrate and DAG
//  situation and whats happened. We see a lot of IDs without actual
//  knowledge what happened, we need dramatically better understanding
//  of SUBSTRATE in realtime without complexity, we need content and
//  whats happened and how."
//
// One screen. One stream. One drilldown. IDs are never the primary
// display surface — the substrate_narrative_recent_view projects each
// event to its human_summary content (claim, summary, intent, goal,
// reason, etc.) and this component renders that. IDs surface only in
// the Enter-key drilldown overlay.
//
// Layout (terminal width-adaptive):
//   header (1 line, daemon/in-flight/clock)
//   ────────────────────────────────────────────────
//   EVENTS pane (most height, scrollable)  ┃ ACTIVE
//   ────────────────────────────────────────────────
//   DECISIONS strip (1-4 lines)
//   ────────────────────────────────────────────────
//   footer: daemon health + key hints
//
// Keyboard:
//   j / ↓        next row
//   k / ↑        previous row
//   PgDn / PgUp  page
//   Enter        drilldown overlay for selected row
//   d            toggle "critical + high" filter (suppress noise)
//   r            force refresh now
//   q / Ctrl+C   quit

import React, { useEffect, useState, useMemo, useCallback } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import type { SubstrateClient } from "./transport/substrate-client";
import type { OwnerPlainStatusRow, SubstrateNarrativeRow } from "../../substrate/views";
import {
  formatRelativeTs,
  importanceIcon,
  importanceColor,
  formatPayloadLines,
} from "./format";

type DispatchSummary = {
  directive_id: string;
  root_task_id?: string;
  lifecycle_status?: string;
  status?: string;
  residual?: number | null;
  latest_ts?: string;
  terminal_kind?: string | null;
};

// pending_owner_decision_queue_view row shape — see substrate/views.ts
// PendingOwnerDecisionRow. The TUI shows target + gate_source +
// duplicate_count inline so the operator sees provenance at a glance.
type DecisionRow = {
  group_key?: string;
  target?: string | null;
  anchor?: string | null;
  duplicate_count?: number;
  gate_source?: "owner_consent_explicit" | "manual_review_implicit";
  representative_event_id?: string;
  oldest_ts?: string;
  newest_ts?: string;
  decision_rank?: number;
  group_decline_reason?: string | null;
  // Fallback fields if the upstream view returns a different shape.
  event_id?: string;
  kind?: string;
  ts?: string;
  payload?: Record<string, unknown>;
  human_summary?: string | null;
};

type HealthSnapshot = {
  ok: boolean;
  status: string;
  pid?: unknown;
  events_count?: unknown;
  uptime_s?: number;
};

export const App: React.FC<{ client: SubstrateClient }> = ({ client }) => {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [rows, setRows] = useState<SubstrateNarrativeRow[]>([]);
  const [dispatches, setDispatches] = useState<DispatchSummary[]>([]);
  const [decisions, setDecisions] = useState<DecisionRow[]>([]);
  const [health, setHealth] = useState<HealthSnapshot>({ ok: false, status: "loading" });
  const [selected, setSelected] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [filterImportance, setFilterImportance] = useState<Array<"critical" | "high" | "medium" | "low">>([]);
  const [drilldown, setDrilldown] = useState<SubstrateNarrativeRow | null>(null);
  const [nowMs, setNowMs] = useState(Date.now());
  // Plain-language mode (brain contract Q471RAN88X0H513V8BC3BTW0AW):
  // press `p` to swap the primary surface from substrate vocabulary
  // (event kinds, IDs, residuals) to owner_plain_status_view cards —
  // "Working on it now." / "Waiting for your input." / "Completed and
  // closed." rather than `task_committed 4FYERR1Y…`. Detail drawer
  // (Enter) stays technical so engineers can still drilldown.
  const [plainMode, setPlainMode] = useState(false);
  const [plainStatus, setPlainStatus] = useState<OwnerPlainStatusRow[]>([]);

  const width = stdout?.columns ?? 100;
  const height = stdout?.rows ?? 30;

  const refresh = useCallback(async () => {
    const env = await client.read<SubstrateNarrativeRow[]>("substrate_narrative_recent_view", {
      limit: 200,
      importance_in: filterImportance.length > 0 ? filterImportance : undefined,
    });
    if (env.ok) setRows(env.result);
    const dispEnv = await client.read<DispatchSummary[]>("dispatch_resolved_view", { include_recent_terminal: true });
    if (dispEnv.ok) setDispatches((dispEnv.result ?? []).slice(0, 8));
    const decEnv = await client.read<DecisionRow[]>("pending_owner_decision_queue_view", { limit: 6 });
    if (decEnv.ok) setDecisions(decEnv.result ?? []);
    // Plain-language status cards (brain contract Q471RAN88X0H513V8BC3BTW0AW)
    // — populated unconditionally so the `p` toggle is instant. Cheap one-row-
    // per-active-directive read.
    const plainEnv = await client.read<OwnerPlainStatusRow[]>("owner_plain_status_view", { limit: 20 });
    if (plainEnv.ok) setPlainStatus(plainEnv.result ?? []);
    const h = await client.health();
    setHealth(h);
    setNowMs(Date.now());
  }, [client, filterImportance]);

  // Re-read on a 1.5s cadence + immediately when SSE fires below.
  useEffect(() => {
    void refresh();
    const interval = setInterval(() => void refresh(), 1500);
    return () => clearInterval(interval);
  }, [refresh]);

  // SSE invalidation — each daemon event triggers an immediate
  // re-query of the narrative view. Cheaper than tight polling and
  // keeps the screen visibly reactive.
  useEffect(() => {
    const ac = new AbortController();
    (async () => {
      try {
        for await (const _ev of client.sseConnect({ signal: ac.signal })) {
          void _ev;
          void refresh();
        }
      } catch { /* abort */ }
    })();
    return () => ac.abort();
  }, [client, refresh]);

  // Tick relative-timestamp display once per second.
  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  useInput((input, key) => {
    if (drilldown) {
      if (key.escape || input === "q") setDrilldown(null);
      return;
    }
    if (input === "q" || (key.ctrl && input === "c")) {
      exit();
      return;
    }
    if (key.downArrow || input === "j") {
      setSelected((s) => Math.min(Math.max(0, rows.length - 1), s + 1));
      return;
    }
    if (key.upArrow || input === "k") {
      setSelected((s) => Math.max(0, s - 1));
      return;
    }
    if (key.pageDown) {
      setSelected((s) => Math.min(Math.max(0, rows.length - 1), s + 10));
      return;
    }
    if (key.pageUp) {
      setSelected((s) => Math.max(0, s - 10));
      return;
    }
    if (key.return) {
      if (rows[selected]) setDrilldown(rows[selected]);
      return;
    }
    if (input === "d") {
      setFilterImportance((f) => (f.length === 0 ? ["critical", "high"] : []));
      setSelected(0);
      return;
    }
    if (input === "r") {
      void refresh();
      return;
    }
    if (input === "p") {
      // Plain-language toggle — primary surface swaps between technical
      // (substrate kinds, IDs, residuals) and owner-plain (per
      // owner_plain_status_view: "Working on it now." / "Waiting for
      // your input." / etc.).
      setPlainMode((prev) => !prev);
      setSelected(0);
      return;
    }
  });

  // Events pane height = total height − chrome (header + divider +
  // decisions + footer ≈ 6 lines).
  const eventsHeight = Math.max(6, height - 8);
  useEffect(() => {
    if (selected < scrollTop) setScrollTop(selected);
    else if (selected >= scrollTop + eventsHeight) setScrollTop(selected - eventsHeight + 1);
  }, [selected, scrollTop, eventsHeight]);

  const visibleRows = useMemo(
    () => rows.slice(scrollTop, scrollTop + eventsHeight),
    [rows, scrollTop, eventsHeight],
  );

  // ── Drilldown overlay ─────────────────────────────────────────
  if (drilldown) {
    const payloadLines = formatPayloadLines(drilldown.payload, width - 4);
    return (
      <Box flexDirection="column" width={width} height={height}>
        <Box borderStyle="round" borderColor={importanceColor(drilldown.importance)} flexDirection="column" paddingX={1}>
          <Text bold>
            <Text color={importanceColor(drilldown.importance)}>{importanceIcon(drilldown.importance)}</Text>
            {" "}{drilldown.kind}  <Text dimColor>{drilldown.event_id}</Text>
          </Text>
          <Text dimColor>
            {drilldown.ts}  directive={drilldown.directive_id ?? "—"}  task={drilldown.task_id ?? "—"}
            {drilldown.residual != null ? `  residual=${drilldown.residual.toFixed(3)}` : ""}
          </Text>
          <Text> </Text>
          {drilldown.human_summary ? <Text bold>{drilldown.human_summary}</Text> : null}
          <Text> </Text>
          {payloadLines.slice(0, Math.max(2, height - 10)).map((line, i) => (
            <Text key={i}>{line}</Text>
          ))}
          {drilldown.cited_refs.length > 0 ? (
            <Text dimColor>cited_refs: {drilldown.cited_refs.join(", ")}</Text>
          ) : null}
        </Box>
        <Box paddingX={1}>
          <Text dimColor>Esc or q to close</Text>
        </Box>
      </Box>
    );
  }

  // ── Main screen ───────────────────────────────────────────────
  const liveCount = dispatches.filter((d) => (d.lifecycle_status ?? d.status) === "live").length;
  const inProgressCount = plainStatus.filter((s) => s.latest_state_kind === "in_progress").length;
  const awaitingCount = plainStatus.filter((s) => s.latest_state_kind === "awaiting_owner").length;
  // Plain-mode header speaks the owner's vocabulary; technical mode
  // shows substrate counts. The toggle is intentionally a single letter
  // so the operator can flip mid-debug without leaving the keyboard.
  const headerLine = plainMode
    ? `Your work · ${plainStatus.length} active · ${inProgressCount} in progress${awaitingCount > 0 ? ` · ${awaitingCount} waiting on you` : ""} · ${health.ok ? "system ok" : "system down"} · ${new Date(nowMs).toISOString().slice(11, 16)}`
    : `acc2 substrate · ${health.ok ? "ok" : "DOWN"} · ${liveCount} in-flight · ${rows.length} events · ${new Date(nowMs).toISOString().slice(11, 19)}`;
  const footerLine = !health.ok
    ? (plainMode ? "Something is wrong with the system. Type `q` to quit, then run `acc daemon start`." : `daemon DOWN: ${health.status} · run \`acc daemon start\``)
    : plainMode
      ? `Plain view · j/k to move · Enter for technical details · p back to technical view · q quit`
      : `daemon ${health.status} · pid ${String(health.pid ?? "?")} · events ${String(health.events_count ?? "?")} · uptime ${health.uptime_s ?? "?"}s · j/k scroll · Enter drilldown · p plain view · d filter · r refresh · q quit`;

  const dispatchPaneWidth = Math.max(24, Math.min(40, Math.floor(width * 0.32)));
  const eventsPaneWidth = Math.max(40, width - dispatchPaneWidth - 3);
  const filterLabel = filterImportance.length > 0 ? ` [filter: ${filterImportance.join("+")}]` : "";

  // ── Plain-language primary surface (brain contract Q471RAN88X0H513V8BC3BTW0AW) ──
  // Renders owner_plain_status_view cards instead of substrate event rows.
  // Press `p` to flip back to technical mode. Enter still drilldowns into
  // raw payloads for engineers — drawer audience, not primary.
  if (plainMode) {
    const cardHeight = Math.max(4, height - 6);
    return (
      <Box flexDirection="column" width={width} height={height}>
        {/* Header */}
        <Box paddingX={1}>
          <Text bold color={health.ok ? "green" : "red"}>{headerLine}</Text>
        </Box>

        {/* Main body: plain status cards (one per active directive) */}
        <Box flexDirection="column" flexGrow={1} paddingX={1}>
          {plainStatus.length === 0 ? (
            <Text dimColor>(nothing active right now — when you ask for something, it will appear here)</Text>
          ) : (
            plainStatus.slice(0, cardHeight).map((card) => {
              const stateColor =
                card.latest_state_kind === "awaiting_owner" ? "yellow"
                : card.latest_state_kind === "failed" ? "red"
                : card.latest_state_kind === "completed" ? "green"
                : card.latest_state_kind === "in_progress" ? "cyan"
                : "gray";
              const titleText = card.opened_text
                ? card.opened_text.length > width - 12
                  ? card.opened_text.slice(0, width - 13) + "…"
                  : card.opened_text
                : "(no description on file)";
              return (
                <Box key={card.directive_id} flexDirection="column" paddingBottom={1}>
                  <Text bold color={stateColor}>• {titleText}</Text>
                  <Text>   {card.latest_state}</Text>
                  {card.next_owner_action ? (
                    <Text color="yellow" bold>   → {card.next_owner_action}</Text>
                  ) : null}
                  {card.risk_note ? (
                    <Text color="red">   ⚠ {card.risk_note}</Text>
                  ) : null}
                </Box>
              );
            })
          )}
        </Box>

        {/* Owner-decision strip (plain-mode framing) */}
        {decisions.length > 0 ? (
          <Box paddingX={1}>
            <Text color="yellow">
              {decisions.length === 1
                ? "There is 1 thing waiting for your decision (press Enter for details)."
                : `There are ${decisions.length} things waiting for your decision (press Enter for details).`}
            </Text>
          </Box>
        ) : null}

        {/* Footer */}
        <Box paddingX={1}>
          <Text dimColor>{footerLine}</Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" width={width} height={height}>
      {/* Header */}
      <Box paddingX={1}>
        <Text bold color={health.ok ? "green" : "red"}>{headerLine}</Text>
      </Box>

      {/* Main row: events pane + dispatch pane */}
      <Box flexDirection="row" flexGrow={1}>
        <Box flexDirection="column" width={eventsPaneWidth} paddingX={1}>
          <Text bold>EVENTS{filterLabel} ({rows.length})</Text>
          {visibleRows.length === 0 ? (
            <Text dimColor>(no events match the current filter — press d to clear)</Text>
          ) : (
            visibleRows.map((r, i) => {
              const absIdx = scrollTop + i;
              const isSelected = absIdx === selected;
              const ts = formatRelativeTs(r.ts, nowMs).padStart(4, " ");
              const icon = importanceIcon(r.importance);
              const kindShort = r.kind.length > 26 ? r.kind.slice(0, 25) + "…" : r.kind;
              const summary = r.human_summary ?? `(payload keys: ${Object.keys(r.payload).slice(0, 3).join(",")})`;
              const remaining = Math.max(20, eventsPaneWidth - ts.length - kindShort.length - 8);
              const trimmed = summary.replace(/\s+/g, " ").slice(0, remaining);
              return (
                <Box key={r.event_id} flexDirection="row">
                  <Text
                    color={isSelected ? "black" : importanceColor(r.importance)}
                    backgroundColor={isSelected ? "cyan" : undefined}
                  >
                    {ts} {icon} {kindShort.padEnd(26, " ")} {" "}
                  </Text>
                  <Text color={isSelected ? "black" : undefined} backgroundColor={isSelected ? "cyan" : undefined}>
                    {trimmed}
                  </Text>
                </Box>
              );
            })
          )}
        </Box>

        <Box flexDirection="column" width={dispatchPaneWidth} paddingX={1}>
          <Text bold>ACTIVE ({dispatches.length})</Text>
          {dispatches.length === 0 ? (
            <Text dimColor>(none)</Text>
          ) : (
            dispatches.map((d) => {
              const status = d.lifecycle_status ?? d.status ?? "?";
              const ts = formatRelativeTs(d.latest_ts ?? "", nowMs).padStart(4, " ");
              const r = d.residual == null ? "  —" : d.residual.toFixed(2);
              const color =
                status === "live" ? "yellow"
                : status === "live_amended" ? "cyan"
                : status === "completed" ? "green"
                : status === "failed" ? "red"
                : "gray";
              return (
                <Text key={d.directive_id} color={color}>
                  {ts}  {status.padEnd(10, " ")}  r={r}  {d.directive_id.slice(0, 8)}
                </Text>
              );
            })
          )}
        </Box>
      </Box>

      {/* Decisions strip */}
      <Box paddingX={1} flexDirection="column">
        <Text bold color={decisions.length > 0 ? "yellow" : undefined}>
          DECISIONS: {decisions.length === 0 ? "0 pending" : `${decisions.length} pending`}
        </Text>
        {decisions.slice(0, 3).map((d, i) => {
          // Two shapes: the new pending_owner_decision_queue_view row
          // carries target + gate_source + duplicate_count; legacy
          // fallback uses kind + human_summary.
          const isQueueRow = d.target !== undefined || d.gate_source !== undefined;
          const target = (d.target ?? "(no target)").slice(0, 56);
          const gateBadge = d.gate_source === "owner_consent_explicit" ? "[OWNER]"
            : d.gate_source === "manual_review_implicit" ? "[review]"
            : "";
          const dup = (d.duplicate_count ?? 1) > 1 ? ` ×${d.duplicate_count}` : "";
          const declineNote = d.group_decline_reason ? ` decline?:${d.group_decline_reason}` : "";
          return (
            <Text key={d.group_key ?? d.event_id ?? i} color="yellow">
              {"  "}{isQueueRow ? `${gateBadge} ${target}${dup}${declineNote}` : `${d.kind ?? "?"}  ${d.human_summary ?? "(see drilldown)"}`}
            </Text>
          );
        })}
      </Box>

      {/* Footer */}
      <Box paddingX={1}>
        <Text dimColor>{footerLine}</Text>
      </Box>
    </Box>
  );
};
