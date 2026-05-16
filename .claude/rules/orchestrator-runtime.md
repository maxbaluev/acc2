# acc2 — Orchestrator Runtime Rules (v2-scoped)

Materialized 2026-05-16 from meta-audit `b0e9aly4s` → directive
`E1S5DWGPR97KXAKKWE1ZABAPMC`. Cites lessons NFK52VSW, R332MNK3,
RDQHDDAX, D2W0NGD0 — every one names a substrate-truth pattern the
orchestrator violated this session by guessing dispatch state from
stdout silence, Bash subprocess exit, or process listings.

These rules are deliberately small and load-bearing. The CLAUDE.md
operating contract stays the canonical surface for "what the system
is"; this file is the operational protocol for **how the orchestrator
observes dispatch state**.

## Dispatch Observation Protocol

After starting `acc task` with `run_in_background: true`, parse
`directive_id` and root `task_id` from the `directive_opened` line.

The ONLY authoritative status read is `substrate.read` with
`view_name="dispatch_resolved_view"` and `args = { directive_id,
root_task_id }`. Poll every 5s while the owner turn is active.

DO NOT:

- Call a dispatch BROKEN merely because `task_committed` / amendment
  counts are zero in a short window. A zero count means "no events
  yet in this window," not "broken." Re-check after at least 60s.
- Call it "completed cleanly" unless `dispatch_resolved_view.lifecycle_status`
  is exactly `completed` AND `terminal_kind = 'task_committed'` AND
  an `evidence_event_id` is present.
- Read the Claude Code Bash background-task panel as proof of
  anything. It lags substrate truth and reports parent-shell state,
  not brain commit state.

The substrate has the data; ask it.

## Background Task Stop Protocol

Claude Code's Bash background-task panel is **not authoritative**.
The orchestrator MUST issue `TaskStop` for a Bash background task
when ALL of these hold:

1. The corresponding `acc task` emits the `ACC_DISPATCH_RESOLVED`
   stdout sentinel for its root, OR
2. `dispatch_resolved_view` reports `lifecycle_status` ∈
   {`completed`, `failed`, `zombie`} for the same `(directive_id,
   root_task_id)` pair, AND
3. The Claude Code panel still shows the task as `running`.

NEVER issue `TaskStop` as proof of completion. `TaskStop` is a UI
hygiene action that fires AFTER substrate truth is already terminal.

## Owner-Facing Dispatch Truth

When ANY `dispatch_resolved_view` row for the current work is in
status `live`, `queued_at_cap`, `zombie`, or just-transitioned to
`completed`/`failed` within this turn — OR when the Bash panel and
substrate disagree — the orchestrator's end-of-turn response MUST end
with one line of substrate truth:

```
Substrate dispatch status: status=<lifecycle_status> directive=<id_prefix>
root=<id_prefix> evidence=<event_ids[:3]> last_event=<kind>@<ts>
next=<wait|TaskStop|investigate>
```

When substrate truth conflicts with the Bash panel, say so
explicitly: "Bash panel may lag; substrate is authoritative."

## Anti-Patterns (load-bearing structural laws)

1. **Don't classify from stdout silence.** A dispatch with no
   `task_committed` event in 30s is not broken; it is mid-cycle.
2. **Don't infer state from `ps`.** Process listing tells you whether
   bash and opencode are alive, not whether the brain committed.
3. **Don't infer state from Bash exit status.** The bash subprocess
   exits when its SSE stream closes, which can happen before AND
   after `task_committed` lands.
4. **Don't poll `wc -l` on the output file.** The `acc task` follow
   stream writes nothing during long brain cycles; an empty file is
   not a broken dispatch.
5. **Don't trust the Bash background-task panel for substrate
   truth.** Its "running"/"completed" is parent-shell lifecycle,
   not substrate lifecycle. Reconcile via `dispatch_resolved_view`.

## Anchoring Evidence

Every classification of dispatch state MUST cite at least one
`evidence_event_id` from the substrate (terminal event, dispatch
event, or closure_audit event). Statements like "X completed cleanly"
without an `evidence_event_id` are unsupported and forbidden.
