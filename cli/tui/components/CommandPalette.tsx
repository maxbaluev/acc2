// cli/tui/components/CommandPalette.tsx — bottom command bar.
//
// The palette IS the CLI: every command typed here resolves to an
// `acc <words>` invocation spawned as a Bash subprocess. There is no
// parallel command vocabulary. Supported (whitelist):
//
//   task <words>      → acc task "<words>"
//   apply <id>        → acc apply <id>
//   decline <id>      → acc apply <id> --decline
//   whoami            → acc whoami
//   status            → acc status
//   directive <id>    → acc directive <id>
//   changes [7d|24h]  → acc changes [window]
//   pending           → acc admin pending-decisions
//   q | quit | exit   → exit the TUI
//
// Anything else is passed through verbatim as `acc <text>`. The output
// of the spawned process is captured into the toast queue so the
// operator sees the result without losing the TUI view.

import React, { useState } from "react";
import { Box, Text, useInput } from "ink";

export type CommandIntent =
  | { kind: "exit" }
  | { kind: "shell"; argv: string[]; raw: string }
  | { kind: "noop" };

/** Parse a command-palette line into a canonical acc invocation.
 *  Pure / no side effects so the test can assert behaviour without
 *  mocking process.spawn. */
export const parseCommand = (line: string): CommandIntent => {
  const trimmed = line.trim();
  if (trimmed.length === 0) return { kind: "noop" };
  if (trimmed === "q" || trimmed === "quit" || trimmed === "exit") return { kind: "exit" };
  // Strip a leading "acc " or "/" if the operator typed it; we always
  // dispatch via `acc`.
  const body = trimmed.replace(/^\/+/, "").replace(/^acc\s+/i, "");
  const parts = body.split(/\s+/);
  const head = parts[0]?.toLowerCase() ?? "";
  if (head === "task") {
    const words = body.slice(4).trim();
    return { kind: "shell", argv: ["task", words], raw: trimmed };
  }
  if (head === "apply" || head === "decline") {
    const id = parts[1] ?? "";
    const argv = head === "decline" ? ["apply", id, "--decline"] : ["apply", id];
    return { kind: "shell", argv, raw: trimmed };
  }
  if (head === "whoami") return { kind: "shell", argv: ["whoami"], raw: trimmed };
  if (head === "status") return { kind: "shell", argv: ["status"], raw: trimmed };
  if (head === "directive") return { kind: "shell", argv: ["directive", parts[1] ?? ""], raw: trimmed };
  if (head === "changes") return { kind: "shell", argv: ["changes", parts[1] ?? "24h"], raw: trimmed };
  if (head === "pending") return { kind: "shell", argv: ["admin", "pending-decisions"], raw: trimmed };
  // Unknown commands are intentionally NOT passed through. This palette
  // is a reviewed wrapper over the documented acc verbs above; widening
  // into a generic acc subprocess launcher is a bypass-risk surface for
  // operator commands not audited as part of acc watch (audit 6H587JE69X
  // — anchored_replace_v1_batch, watch-tui-command-palette-remove-
  // passthrough). If a new verb belongs in the palette, add it here
  // explicitly; everything else goes through plain `bun run acc ...`.
  return { kind: "noop" };
};

export type CommandPaletteProps = {
  active: boolean;
  hint?: string;
  onSubmit: (intent: CommandIntent) => void;
};

export const CommandPalette = ({ active, hint, onSubmit }: CommandPaletteProps): React.ReactElement => {
  const [buffer, setBuffer] = useState("");

  useInput((input, key) => {
    if (!active) return;
    if (key.return) {
      const intent = parseCommand(buffer);
      onSubmit(intent);
      setBuffer("");
      return;
    }
    if (key.backspace || key.delete) {
      setBuffer((b) => b.slice(0, -1));
      return;
    }
    if (key.escape) {
      setBuffer("");
      return;
    }
    if (input && !key.ctrl && !key.meta) {
      // Accept single characters AND larger pastes (ink-testing-library
      // delivers stdin writes as a single useInput event).
      // Strip embedded \r so the buffer doesn't accumulate the submit
      // newline before the key.return branch above handles it.
      const sanitized = input.replace(/[\r\n]/g, "");
      if (sanitized.length > 0) setBuffer((b) => b + sanitized);
    }
  }, { isActive: active });

  return (
    <Box borderStyle="single" borderColor={active ? "cyan" : "gray"} paddingX={1}>
      <Text color={active ? "cyan" : "gray"}>command: </Text>
      <Text>{buffer}</Text>
      {active ? <Text color="cyan">█</Text> : null}
      <Box flexGrow={1} />
      <Text dimColor>{hint ?? "task ⟨words⟩ · apply ⟨id⟩ · whoami · changes 24h · q to quit"}</Text>
    </Box>
  );
};
