// cli/tui/screens/Profile.tsx — owner profile drawer (toggle 'p').
//
// Renders the same data `acc whoami` exposes, but through Ink so the
// owner can see the live profile state alongside the dashboard.
// Prose is filtered through owner_profile_renderer; canonical keys
// (autonomy_score, preferred_terms, …) stay literal.

import React from "react";
import { Box, Text } from "ink";
import { Pane } from "../components/Pane";
import { renderOwnerString, type OwnerProfileCard } from "../../owner_profile_renderer";

export type ProfileScreenProps = {
  profile: OwnerProfileCard & { source_event_id?: string; source_ts?: string };
};

const fmtNum = (n: number | null | undefined): string =>
  typeof n === "number" && Number.isFinite(n) ? n.toFixed(2) : "unset";

const topSignals = (signals: Record<string, number> | undefined, limit = 5): Array<[string, number]> => {
  if (!signals) return [];
  return Object.entries(signals)
    .filter((e): e is [string, number] => typeof e[1] === "number" && Number.isFinite(e[1]))
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit);
};

const list = (xs: string[] | undefined): string =>
  xs && xs.length > 0 ? xs.join(", ") : "none";

export const ProfileScreen = ({ profile }: ProfileScreenProps): React.ReactElement => {
  const renderProfile = { detected_language: profile.detected_language, preferred_terms: profile.preferred_terms, avoided_terms: profile.avoided_terms };
  const rendering = topSignals(profile.rendering_signals);
  return (
    <Pane title="owner profile (owner_profile_view)" focused={true}>
      <Box>
        <Text dimColor>source=</Text>
        <Text>{profile.source_event_id ?? "fresh_default"}</Text>
        <Text dimColor> ts=</Text>
        <Text>{profile.source_ts ?? "unset"}</Text>
      </Box>
      <Box marginTop={1}>
        <Text bold>{renderOwnerString("identity", renderProfile)}</Text>
      </Box>
      <Box>
        <Text>detected_language=</Text>
        <Text color="cyan">{profile.detected_language ?? "unset"}</Text>
        <Text>  autonomy_score=</Text>
        <Text color="cyan">{fmtNum(profile.autonomy_score)}</Text>
        <Text>/</Text>
        <Text dimColor>{fmtNum(profile.autonomy_score_floor)}</Text>
      </Box>
      <Box marginTop={1}>
        <Text bold>{renderOwnerString("vocabulary", renderProfile)}</Text>
      </Box>
      <Box>
        <Text>preferred_terms=</Text>
        <Text>{list(profile.preferred_terms)}</Text>
      </Box>
      <Box>
        <Text>avoided_terms=</Text>
        <Text>{list(profile.avoided_terms)}</Text>
      </Box>
      <Box marginTop={1}>
        <Text bold>top rendering_signals</Text>
      </Box>
      {rendering.length === 0 ? (
        <Text dimColor>(none)</Text>
      ) : (
        rendering.map(([k, v]) => (
          <Box key={k}>
            <Text dimColor>  </Text>
            <Text>{k}=</Text>
            <Text color="cyan">{v.toFixed(2)}</Text>
          </Box>
        ))
      )}
      <Box marginTop={1}>
        <Text bold>guardrails</Text>
      </Box>
      <Box>
        <Text>things_to_never_do=</Text>
        <Text color="red">{list(profile.things_to_never_do)}</Text>
      </Box>
      <Box>
        <Text>hot_topics=</Text>
        <Text>{list(profile.hot_topics)}</Text>
      </Box>
    </Pane>
  );
};
