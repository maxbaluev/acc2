// cli/tui/components/Pane.tsx — bordered panel wrapper.
//
// Encapsulates the bordered "box with title" pattern every dashboard panel
// uses. Focused panes get a brighter border color (cyan vs gray) so the
// keyboard focus is visible without disturbing the layout.

import React from "react";
import { Box, Text } from "ink";

export type PaneProps = {
  title: string;
  focused?: boolean;
  flexGrow?: number;
  width?: number | string;
  height?: number | string;
  children?: React.ReactNode;
};

export const Pane = ({ title, focused, flexGrow, width, height, children }: PaneProps): React.ReactElement => (
  <Box
    flexDirection="column"
    borderStyle="round"
    borderColor={focused ? "cyan" : "gray"}
    flexGrow={flexGrow ?? 1}
    width={width}
    height={height}
    paddingX={1}
  >
    <Box marginBottom={0}>
      <Text bold color={focused ? "cyan" : "white"}>{title}</Text>
    </Box>
    <Box flexDirection="column" flexGrow={1}>{children}</Box>
  </Box>
);
