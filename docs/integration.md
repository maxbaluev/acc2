# AccInt × Claude Code Integration Contract

**Status**: brain-designed (dispatch `KM7V4E7W411P98AGNJG8RKH1NM`, amendment `X6SDH6RJQS4Y7AAJHZNQ653WE0`, KCs `GS1Z4YBRQ143Q2` + `KHTBHA7R397MN0`, closure_residual 0.12), 2026-05-20. Implementation lands in follow-up commits.

After `acc init`, the target owner experience is: **the owner talks to Claude Code normally and AccInt handles substrate ingress without requiring the owner to type `acc task`.** The canonical position is **Q4 + R3 + S2 + T4** across the four design axes.

## Canonical retrieval grounding

- `S3KQ6TPC915Q` — Claude Code is owner-facing runtime; `acc task` substrate-owned; Claude-native progress/events/Agent/skills as observation.
- `QWAGAECET158` — Claude Code as observation+execution runtime around substrate events, NOT alternate strategic planner.
- `7W5N69Z08H43` — Claude Code wraps substrate ledger events rather than replacing substrate strategic planning.
- `YZCWFQCNWS5E` — Claude Code native tools as owner-observation + semantic-edit runtime; substrate owns dispatch, scheduling, learning.
- Commit `4b6af58` — explicit operator rejection of `consent_event_recorded` event kind, `acc stage` CLI verb, and primitives-around-classifier framing. This integration design honors that boundary.

## Q4 — daemon-side ingress (implicit-dispatch path)

A substrate-owned Claude chat observer reads Claude session transcripts (or equivalent Claude-local owner-message streams), captures owner free text as existing `owner_input_received` / `directive_opened` events, lets `intent_classified` and `dispatch_decided` select the lane, and exposes the substrate verdict back to Claude.

The observer must NOT become a second strategic planner and must NOT introduce new event kinds unless a verifier shows existing events cannot represent the observation.

This avoids relying on CLAUDE.md obedience, slash-command use, or prompt heuristics as the primary ingress gate. The owner just talks; the daemon notices.

## R3 — MCP server registration (fresh-chat awareness path)

`acc init` registers the substrate MCP server for Claude Code so a new chat can read substrate state, emit allowed ledger observations, and render owner-facing progress.

Repository `CLAUDE.md` and optional skills may improve ergonomics, but **MCP registration is the durable readiness boundary**. Do not require a new `claude_session_opened` event kind for the first version; use existing daemon/session/owner events plus MCP availability checks.

## S2 — one-time legacy memory import

`acc init` detects `~/.claude/memory/` and prior Claude project transcripts (`~/.claude/projects/*/conversation.jsonl`) and offers a reviewed import that:

- Emits `knowledge_candidate` entries tagged `origin=claude_legacy_memory`
- Routes owner review through existing `owner_input_required` / `owner_decision_recorded` events
- Treats imported memories as evidence candidates, NOT canonical truth

**Rejected alternatives** and why:
- S1 (reject entirely) — too weak for fully-ready expectation; loses provably-useful prior context.
- S3 (continuous mirror) — expands privacy, provenance, and false-memory risk.
- S4 (manual-only `acc memory link`) — too weak for owner's fully-ready expectation.

Imported entries flow through the same merger + posterior pipeline as any other knowledge candidate; they earn weight by contributing to outcomes, not by import provenance.

## T4 — Claude marketplace plugin (distribution channel)

The preferred new-user channel is **`claude plugins install accint`**, installing in one Claude-native flow:

1. The MCP server registration (so fresh chats have substrate.search/read/emit)
2. Minimal Claude guidance (the operator contract section of CLAUDE.md, scoped + non-invasive)
3. Optional `/acc` skill for explicit override (substrate-direct dispatch when owner wants control)
4. The `acc init` checks (daemon spawn, state.db creation, seed bootstrap, migration v001 baseline)

**Repo clone (`git clone bos2 && bun run acc init`) and single-binary distribution remain developer / operator fallbacks**, but the product contract optimizes for Claude-native installation because the owner-facing runtime IS Claude Code.

## What this design is NOT

- Not a consent ledger (rejected by owner directive 2026-05-20 commit `4b6af58`).
- Not an `acc stage` CLI verb (same).
- Not a primitives-around-classifier workaround (the classifier is upstream of the substrate; the substrate cannot influence it from inside, and shouldn't try).
- Not a replacement for substrate-owned strategic planning. Q4 observes; it does not plan. R3 exposes substrate state to Claude; substrate still decides routing and learning. Substrate primacy preserved.

## Implementation phases

This file documents the contract. Follow-up commits implement:

1. **Q4 chat observer worker** — `runtime/claude_chat_observer_worker.ts`. Polls `~/.claude/projects/*/conversation.jsonl` (or a Claude-provided event stream when available), parses owner messages, emits `owner_input_received` / `directive_opened` events. Idempotent via per-message hash. Opt-out via `ACC2_DISABLE_WORKERS=claude_chat_observer`.

2. **R3 MCP registration** — `acc init` extension. Writes substrate MCP server config to user's Claude MCP registry. Idempotent. Reversible via `acc admin claude-mcp-unregister`.

3. **S2 legacy memory import** — `acc init --import-claude-memory` flag (or interactive prompt during init). Reads detected sources, admits as `knowledge_candidate` rows, opens an `owner_input_required` for review of any high-impact entries.

4. **T4 plugin packaging** — release pipeline emits a Claude marketplace plugin manifest plus the bundled `substrate/canonical.db` (Phase 2 distribution, commit `df2a82e`). `claude plugins install accint` becomes the one-command install.

Each phase is a separate commit, designed to be independently verifiable and reversible.
