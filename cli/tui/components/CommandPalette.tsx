// cli/tui/components/CommandPalette.tsx — bottom command bar.
//
// The palette IS the CLI: every command typed here resolves to an
// `acc <words>` invocation spawned as a Bash subprocess. There is no
// parallel command vocabulary. Supported (whitelist):
//
//   task <words>          → acc task "<words>"
//   apply <id>            → acc apply <id>
//   decline <id>          → acc apply <id> --decline
//   observe <id> <v> [r]  → acc observe <id> --verdict <v> --reason <r>
//   whoami                → acc whoami
//   status                → acc status
//   directive <id>        → acc directive <id>
//   changes [7d|24h]      → acc changes [window]
//   pending               → acc admin pending-decisions
//   q | quit | exit       → exit the TUI
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
  if (head === "observe") {
    // observe <event_id> <verdict> [reason...]
    const id = parts[1] ?? "";
    const verdict = (parts[2] ?? "").toLowerCase();
    const reason = parts.slice(3).join(" ").trim();
    const argv = ["observe", id, "--verdict", verdict];
    if (reason.length > 0) argv.push("--reason", reason);
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
  /** Controlled buffer so the App-level useInput can decide whether a
   *  keystroke is a hotkey (buffer empty) or palette input (buffer
   *  has content). The unkeyed default (buffer="") makes single-key
   *  hotkeys reachable even while the palette has focus. */
  buffer: string;
  onBufferChange: (next: string) => void;
};

export const CommandPalette = ({ active, hint, onSubmit, buffer, onBufferChange }: CommandPaletteProps): React.ReactElement => {
  useInput((input, key) => {
    if (!active) return;
    if (key.return) {
      const intent = parseCommand(buffer);
      onSubmit(intent);
      onBufferChange("");
      return;
    }
    if (key.backspace || key.delete) {
      onBufferChange(buffer.slice(0, -1));
      return;
    }
    if (key.escape) {
      onBufferChange("");
      return;
    }
    if (input && !key.ctrl && !key.meta) {
      // Key-routing convention (mirrored in App.tsx):
      //   buffer empty + input is a single-char hotkey {i,a,p,e,h,l,q,:}
      //     → App.useInput handles; CommandPalette ignores so we don't
      //       both append AND trigger a drawer.
      //   buffer empty + input is anything else (start of "task",
      //     "apply", etc.) → CommandPalette accumulates so the operator
      //     can type a command without first pressing ESC.
      //   buffer has content → CommandPalette accumulates everything
      //     (any character including hotkey letters becomes part of the
      //     command line). App.useInput defers in that branch.
      const sanitized = input.replace(/[\r\n]/g, "");
      if (sanitized.length === 0) return;
      const HOTKEY_LETTERS = new Set(["i", "a", "p", "e", "h", "l", "q", ":"]);
      if (buffer.length === 0 && sanitized.length === 1 && HOTKEY_LETTERS.has(sanitized)) {
        return;
      }
      onBufferChange(buffer + sanitized);
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
