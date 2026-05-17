// cli/tui/screens/Inbox.tsx — full-screen pending-decisions detail.
// Mirrors the rendering shape of `acc admin pending-decisions` (ranked,
// duplicate-collapsed, decline-marker exposed) but in interactive form
// for keyboard scrolling.

import React from "react";
import { Box, Text } from "ink";
import { Pane } from "../components/Pane";
import type { PendingDecisionRow } from "../state/store";

export type InboxProps = {
  rows: PendingDecisionRow[];
  total: number;
};

const fmtAge = (iso: string): string => {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return "?";
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
};

export const InboxScreen = ({ rows, total }: InboxProps): React.ReactElement => (
  <Pane title={`pending_owner_decision_queue_view (showing ${rows.length}/${total})`} focused={true}>
    {rows.length === 0 ? (
      <Text dimColor>no pending owner decisions — substrate inbox is clear</Text>
    ) : (
      <>
        <Box>
          <Text dimColor>rank  age   dup  event_id      target                                       reason</Text>
        </Box>
        {rows.map((r) => (
          <Box key={r.group_key} flexDirection="column">
            <Box>
              <Text color="cyan">{r.decision_rank.toFixed(2)}</Text>
              <Text>  </Text>
              <Text>{fmtAge(r.newest_ts).padEnd(5)}</Text>
              <Text> </Text>
              <Text>{String(r.duplicate_count).padStart(3)}</Text>
              <Text>  </Text>
              <Text color="yellow">{(r.representative_event_id ?? "(no_event_id)").slice(0, 12).padEnd(12)}</Text>
              <Text> </Text>
              <Text>{(r.target ?? "?").slice(0, 44).padEnd(44)}</Text>
              <Text> </Text>
              {r.group_decline_reason ? (
                <Text color="red">decline:{r.group_decline_reason}</Text>
              ) : (
                <Text color="green">apply-ready</Text>
              )}
            </Box>
            <Box paddingLeft={6}>
              <Text dimColor>anchor=</Text>
              <Text dimColor>{(r.anchor ?? "-").slice(0, 60)}</Text>
              <Text dimColor> risk=</Text>
              <Text color={r.target_risk_score >= 0.85 ? "red" : r.target_risk_score >= 0.5 ? "yellow" : "white"}>
                {r.target_risk_score.toFixed(2)}
              </Text>
              <Text dimColor> shape=</Text>
              <Text>{r.shape_quality_score.toFixed(2)}</Text>
            </Box>
          </Box>
        ))}
        <Box marginTop={1}>
          <Text dimColor>type </Text>
          <Text color="green">apply ⟨event_id⟩</Text>
          <Text dimColor> or </Text>
          <Text color="red">decline ⟨event_id⟩</Text>
          <Text dimColor> in the command palette (the yellow column is the event_id)</Text>
        </Box>
      </>
    )}
  </Pane>
);
