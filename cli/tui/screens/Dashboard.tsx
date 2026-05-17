// cli/tui/screens/Dashboard.tsx — main six-panel render of the seven-question
// framework.
//
//   Inbox            ← pending_owner_decision_queue_view  (question 2)
//   Dispatch Truth   ← dispatch_resolved_view              (question 1)
//   DAG              ← current directive task graph        (question 1, deep)
//   Learning         ← promoted + contradictory + recipes   (question 4)
//   Next             ← ready + active + conflicts + rolling (question 7)
//   Changes          ← applied_change_committed + irreversible + closures
//                                                          (question 5)
//
// Lifecycle vocabulary (live/queued_at_cap/completed/failed/zombie) is
// rendered EXACTLY — no friendly relabel. Closure residual prints next to
// the lifecycle status. Refinement edges in the DAG list use a distinct
// glyph + color (yellow "↻") from requires (green "→") and watches
// (cyan "👁") — the cycle-1-only falsifiability proof.

import React from "react";
import { Box, Text } from "ink";
import { Pane } from "../components/Pane";
import type {
  DashboardSnapshot,
  DispatchRow,
  PendingDecisionRow,
  Lifecycle,
  DagTopology,
} from "../state/store";
import { renderOwnerString, type OwnerRenderProfile } from "../../owner_profile_renderer";

export type FocusName =
  | "inbox"
  | "dispatch"
  | "dag"
  | "learning"
  | "next"
  | "changes";

export const FOCUS_ORDER: FocusName[] = ["inbox", "dispatch", "dag", "learning", "next", "changes"];

const lifecycleGlyph = (s: Lifecycle): string => ({
  live: "→",
  queued_at_cap: "⏸",
  completed: "✓",
  failed: "✗",
  zombie: "💀",
}[s]);

const lifecycleColor = (s: Lifecycle): string => ({
  live: "yellow",
  queued_at_cap: "magenta",
  completed: "green",
  failed: "red",
  zombie: "red",
}[s]);

const shortId = (id: string | null | undefined, n = 8): string => {
  if (!id) return "-";
  return id.length > n ? id.slice(0, n) : id;
};

const fmtResidual = (r: number | null): string =>
  r === null || !Number.isFinite(r) ? "?" : r.toFixed(2);

const InboxPanel = ({
  rows,
  total,
  focused,
  profile,
}: {
  rows: PendingDecisionRow[];
  total: number;
  focused: boolean;
  profile: OwnerRenderProfile;
}): React.ReactElement => (
  <Pane title={`INBOX (pending decisions: ${total})`} focused={focused}>
    {rows.length === 0 ? (
      <Text dimColor>{renderOwnerString("no pending owner decisions", profile)}</Text>
    ) : (
      <>
        <Text dimColor>rank dup risk event_id     target / anchor</Text>
        {rows.map((r) => (
          <Box key={r.group_key} flexDirection="column">
            <Text>
              <Text color="cyan">{r.decision_rank.toFixed(2)}</Text>
              {" "}
              <Text>{String(r.duplicate_count).padStart(2)}</Text>
              {" "}
              <Text color={r.target_risk_score >= 0.85 ? "red" : r.target_risk_score >= 0.5 ? "yellow" : "white"}>{r.target_risk_score.toFixed(2)}</Text>
              {" "}
              <Text color="yellow">{(r.representative_event_id ?? "-").slice(0, 12)}</Text>
              {" "}
              <Text>{(r.target ?? "?").slice(0, 28)}</Text>
            </Text>
            <Text>
              <Text dimColor>  anchor=</Text>
              <Text dimColor>{(r.anchor ?? "-").slice(0, 26)}</Text>
              {" "}
              {r.group_decline_reason ? (
                <Text color="red">decline:{r.group_decline_reason}</Text>
              ) : (
                <Text color="green">apply-ready</Text>
              )}
            </Text>
          </Box>
        ))}
      </>
    )}
  </Pane>
);

const DispatchTruthPanel = ({
  rows,
  focused,
}: {
  rows: DispatchRow[];
  focused: boolean;
}): React.ReactElement => {
  const live = rows.filter((r) => r.lifecycle_status === "live");
  const queued = rows.filter((r) => r.lifecycle_status === "queued_at_cap");
  const completed = rows.filter((r) => r.lifecycle_status === "completed");
  const failed = rows.filter((r) => r.lifecycle_status === "failed");
  const zombie = rows.filter((r) => r.lifecycle_status === "zombie");
  // Filter to the last 24h before counting and rendering — dispatch_resolved_view
  // returns the entire historical projection (including hundreds of legacy
  // zombies from prior session generations); the dashboard surfaces
  // operational state, not the archive. The full archive is reachable via
  // `acc admin dispatch-status` for forensic queries.
  const RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;
  const recentCutoff = Date.now() - RECENT_WINDOW_MS;
  const isRecent = (r: DispatchRow): boolean => {
    if (!r.latest_signal_at) return r.lifecycle_status === "live" || r.lifecycle_status === "queued_at_cap";
    const ts = Date.parse(r.latest_signal_at);
    return Number.isFinite(ts) ? ts >= recentCutoff : true;
  };
  const recentLive = live.filter(isRecent);
  const recentQueued = queued.filter(isRecent);
  const recentFailed = failed.filter(isRecent);
  const recentZombie = zombie.filter(isRecent);
  const recentCompleted = completed.filter(isRecent);
  const shown = [...recentLive, ...recentQueued, ...recentFailed.slice(0, 2), ...recentZombie.slice(0, 2), ...recentCompleted.slice(0, 2)].slice(0, 6);
  return (
    <Pane title="DISPATCH TRUTH (last 24h)" focused={focused}>
      <Text>
        <Text color="yellow">live={recentLive.length}</Text>
        {" "}
        <Text color="magenta">queued_at_cap={recentQueued.length}</Text>
        {" "}
        <Text color="green">completed={recentCompleted.length}</Text>
        {" "}
        <Text color="red">failed={recentFailed.length}</Text>
        {" "}
        <Text color="red">zombie={recentZombie.length}</Text>
      </Text>
      <Text dimColor>(historical totals: live={live.length} queued={queued.length} completed={completed.length} failed={failed.length} zombie={zombie.length})</Text>
      {shown.length === 0 ? <Text dimColor>(no recent dispatches)</Text> : null}
      {shown.map((r) => {
        // residual only exists on terminal events (task_committed / task_failed).
        // For live/queued/zombie rows it is null by construction — rendering
        // "residual=?" is noise; show the substrate-owned status_reason
        // instead so the operator sees the actual in-flight signal
        // (brain_dispatch_open, refinement_dispatch_open, queued_at_cap,
        // open_dispatch_zombie, etc.).
        const showResidual = r.terminal_kind === "task_committed" || r.terminal_kind === "task_failed";
        return (
          <Box key={`${r.directive_id}/${r.root_task_id}`} flexDirection="column">
            <Text>
              <Text color={lifecycleColor(r.lifecycle_status)}>{lifecycleGlyph(r.lifecycle_status)} {r.lifecycle_status}</Text>
              {showResidual ? (
                <>
                  <Text dimColor> residual=</Text>
                  <Text>{fmtResidual(r.residual)}</Text>
                </>
              ) : r.status_reason ? (
                <>
                  <Text dimColor> reason=</Text>
                  <Text>{r.status_reason}</Text>
                </>
              ) : null}
            </Text>
            <Text dimColor>  dir={shortId(r.directive_id, 10)} root={shortId(r.root_task_id, 8)}{r.terminal_kind ? ` terminal=${r.terminal_kind}` : ""}{r.evidence_event_id ? ` evidence=${shortId(r.evidence_event_id, 8)}` : ""}</Text>
          </Box>
        );
      })}
    </Pane>
  );
};

const edgeGlyph = (kind: string): { glyph: string; color: string } => {
  if (kind === "requires") return { glyph: "→", color: "green" };
  if (kind === "refines") return { glyph: "↻", color: "yellow" };
  if (kind === "watches") return { glyph: "👁", color: "cyan" };
  return { glyph: "?", color: "white" };
};

const DagPanel = ({
  dispatch,
  dag,
  focused,
}: {
  dispatch: DispatchRow[];
  dag: DagTopology | null;
  focused: boolean;
}): React.ReactElement => {
  const focusDispatch = dispatch.find((r) => r.lifecycle_status === "live")
    ?? dispatch.find((r) => r.lifecycle_status === "queued_at_cap")
    ?? dispatch[0];
  // Cap render rows so a wide DAG can't overflow the panel.
  const NODE_LIMIT = 6;
  const EDGE_LIMIT = 8;
  const nodes = dag?.nodes ?? [];
  const edges = dag?.edges ?? [];
  return (
    <Pane title="DAG (current directive)" focused={focused}>
      {!focusDispatch ? (
        <Text dimColor>(no active directive)</Text>
      ) : (
        <>
          <Text>
            <Text color="cyan">▸ root </Text>
            <Text dimColor>dir={shortId(focusDispatch.directive_id, 10)} root={shortId(focusDispatch.root_task_id, 8)} lifecycle=</Text>
            <Text color={lifecycleColor(focusDispatch.lifecycle_status)}>{focusDispatch.lifecycle_status}</Text>
          </Text>
          <Text>
            <Text dimColor>legend: </Text>
            <Text color="green">→ requires</Text>
            <Text dimColor> | </Text>
            <Text color="yellow">↻ refines</Text>
            <Text dimColor> | </Text>
            <Text color="cyan">👁 watches</Text>
          </Text>
          {!dag ? (
            <Text dimColor>(task_graph_view unreachable)</Text>
          ) : nodes.length === 0 && edges.length === 0 ? (
            <Text dimColor>(no task_graph_view rows for directive {shortId(focusDispatch.directive_id, 10)})</Text>
          ) : (
            <>
              <Text dimColor>nodes ({nodes.length}):</Text>
              {nodes.slice(0, NODE_LIMIT).map((n) => (
                <Text key={`n-${n.task_id}`}>
                  <Text color="cyan">  {shortId(n.task_id, 8)}</Text>
                  {n.goal ? <Text dimColor> {n.goal.slice(0, 50)}</Text> : null}
                </Text>
              ))}
              {nodes.length > NODE_LIMIT ? <Text dimColor>  …+{nodes.length - NODE_LIMIT} more</Text> : null}
              <Text dimColor>edges ({edges.length}):</Text>
              {edges.slice(0, EDGE_LIMIT).map((e, i) => {
                const g = edgeGlyph(e.kind);
                return (
                  <Text key={`e-${i}-${e.from_task}-${e.to_task}`}>
                    <Text dimColor>  {shortId(e.from_task, 8)}</Text>
                    <Text color={g.color}> {g.glyph} </Text>
                    <Text dimColor>{shortId(e.to_task, 8)}</Text>
                  </Text>
                );
              })}
              {edges.length > EDGE_LIMIT ? <Text dimColor>  …+{edges.length - EDGE_LIMIT} more</Text> : null}
            </>
          )}
        </>
      )}
    </Pane>
  );
};

const LearningPanel = ({
  learning,
  focused,
}: {
  learning: DashboardSnapshot["learning"];
  focused: boolean;
}): React.ReactElement => (
  <Pane title="LEARNING" focused={focused}>
    <Text>
      <Text color="green">+{learning.knowledge_total}</Text>
      <Text dimColor> promoted (+{learning.knowledge_24h}/24h)</Text>
    </Text>
    <Text>
      <Text color="red">x{learning.contradictions}</Text>
      <Text dimColor> contradictory candidates</Text>
    </Text>
    <Text>
      <Text color="cyan">r{learning.recipes_recent}</Text>
      <Text dimColor> recipes extracted (24h)</Text>
    </Text>
    <Text>
      <Text color="cyan">a{learning.artifacts_recent}</Text>
      <Text dimColor> code_artifacts (24h)</Text>
    </Text>
  </Pane>
);

const NextPanel = ({
  next,
  focused,
}: {
  next: DashboardSnapshot["next"];
  focused: boolean;
}): React.ReactElement => (
  <Pane title="NEXT (if I do nothing)" focused={focused}>
    <Text>
      <Text dimColor>ready: </Text>
      <Text color={next.ready_count > 0 ? "green" : "white"}>{next.ready_count}</Text>
      <Text dimColor> tasks pending</Text>
    </Text>
    <Text>
      <Text dimColor>active objectives: </Text>
      <Text>{next.active_objectives}</Text>
    </Text>
    <Text>
      <Text dimColor>conflicts: </Text>
      <Text color={next.conflicts > 0 ? "yellow" : "white"}>{next.conflicts}</Text>
      <Text dimColor> interference edges</Text>
    </Text>
    <Text>
      <Text dimColor>rolling review due: </Text>
      <Text color={next.rolling_review_due > 0 ? "yellow" : "white"}>{next.rolling_review_due}</Text>
    </Text>
  </Pane>
);

const ChangesPanel = ({
  changes,
  focused,
}: {
  changes: DashboardSnapshot["changes"];
  focused: boolean;
}): React.ReactElement => (
  <Pane title="CHANGES (last 24h)" focused={focused}>
    <Text>
      <Text color="green">+{changes.applied_24h}</Text>
      <Text dimColor> applied | </Text>
      <Text color="red">x{changes.failed_24h}</Text>
      <Text dimColor> failed/refused</Text>
    </Text>
    <Text>
      <Text color="yellow">!{changes.irreversible_24h}</Text>
      <Text dimColor> irreversible effects</Text>
    </Text>
    <Text>
      <Text color="green">c{changes.closed_directives.length}</Text>
      <Text dimColor> directives closed (closure_residual: {changes.closed_directives.length === 0 ? "-" : changes.closed_directives.map((d) => (d.closure_residual === null ? "?" : d.closure_residual.toFixed(2))).slice(0, 3).join(", ")})</Text>
    </Text>
  </Pane>
);

export type DashboardProps = {
  snapshot: DashboardSnapshot;
  focus: FocusName;
};

export const Dashboard = ({ snapshot, focus }: DashboardProps): React.ReactElement => {
  const profile: OwnerRenderProfile = {
    detected_language: snapshot.owner_profile.detected_language,
    preferred_terms: snapshot.owner_profile.preferred_terms,
    avoided_terms: snapshot.owner_profile.avoided_terms,
  };
  return (
    <Box flexDirection="column" flexGrow={1}>
      <Box flexDirection="row" flexGrow={1}>
        <InboxPanel rows={snapshot.pending_decisions} total={snapshot.pending_decisions_total} focused={focus === "inbox"} profile={profile} />
        <DispatchTruthPanel rows={snapshot.dispatch} focused={focus === "dispatch"} />
      </Box>
      <Box flexDirection="row" flexGrow={1}>
        <DagPanel dispatch={snapshot.dispatch} dag={snapshot.dag} focused={focus === "dag"} />
        <LearningPanel learning={snapshot.learning} focused={focus === "learning"} />
      </Box>
      <Box flexDirection="row" flexGrow={1}>
        <NextPanel next={snapshot.next} focused={focus === "next"} />
        <ChangesPanel changes={snapshot.changes} focused={focus === "changes"} />
      </Box>
    </Box>
  );
};
