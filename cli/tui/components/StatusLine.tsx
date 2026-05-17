// cli/tui/components/StatusLine.tsx — top bar with owner identity, autonomy,
// detected language, uptime, and health verdict. Renders owner-facing prose
// through owner_profile_renderer so language/terms apply, but keeps
// canonical tokens (verdict literals, status strings) intact.

import React from "react";
import { Box, Text } from "ink";
import { renderOwnerString, type OwnerRenderProfile } from "../../owner_profile_renderer";
import type { HealthSnapshot } from "../state/store";

export type StatusLineProps = {
  detected_language: string | null;
  autonomy_score: number | null;
  autonomy_floor: number | null;
  health: HealthSnapshot;
  ownerProfile: OwnerRenderProfile;
};

const fmt = (n: number | null | undefined): string =>
  typeof n === "number" && Number.isFinite(n) ? n.toFixed(2) : "unset";

const fmtUptime = (s: number | null): string => {
  if (typeof s !== "number" || !Number.isFinite(s)) return "?";
  if (s < 60) return `${Math.round(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}h${m}m`;
};

const verdictColor = (v: HealthSnapshot["verdict"]): string =>
  v === "ALIVE" ? "green" : v === "DEGRADED" ? "yellow" : "red";

export const StatusLine = ({
  detected_language,
  autonomy_score,
  autonomy_floor,
  health,
  ownerProfile,
}: StatusLineProps): React.ReactElement => {
  const ownerWord = renderOwnerString("owner", ownerProfile);
  return (
    <Box borderStyle="single" borderColor="gray" paddingX={1}>
      <Box flexGrow={1}>
        <Text>
          <Text bold>{ownerWord}</Text>
          <Text>: lang=</Text>
          <Text color="cyan">{detected_language ?? "unset"}</Text>
          <Text>{" autonomy="}</Text>
          <Text color="cyan">{`${fmt(autonomy_score)}/${fmt(autonomy_floor)}`}</Text>
          <Text>{" uptime="}</Text>
          <Text color="cyan">{fmtUptime(health.uptime_s)}</Text>
          <Text>{" events="}</Text>
          <Text color="cyan">{String(health.events_count ?? "?")}</Text>
        </Text>
      </Box>
      <Text>
        <Text>health=</Text>
        <Text bold color={verdictColor(health.verdict)}>{health.verdict}</Text>
      </Text>
    </Box>
  );
};
