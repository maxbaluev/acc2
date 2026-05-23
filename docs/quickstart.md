# AccInt v2 Quickstart

Paste the install prompt into Claude Code. Claude walks you through
`acc init --interactive`, validates keys, repairs missing dependencies,
starts the daemon, runs `acc doctor`, and offers demo directives.

If anything fails, copy the single repair command Claude shows you and
re-run the same interactive init — the flow is idempotent. **Do not start
real work until `acc doctor` says PASS.**

## What the interactive flow does

1. **Probes host dependencies** — `bun`, `opencode`, `uv`, `camoufox` —
   and offers the exact install command for any missing piece.
2. **Collects + validates API keys** at paste time, never at runtime:
   - `OPENAI_API_KEY` is **required ONLY for embeddings** (text-embedding-3-small
     drives substrate retrieval; ~$0.02/1M tokens — cheap). It does NOT pay
     for brain calls.
   - **Brain (gpt-5.5) auth comes from opencode**, not from
     `OPENAI_API_KEY`. opencode is installed via `acc admin install-deps`
     and uses its own subscription path. For sustained use you want an
     **OpenAI Max plan (Plus/Pro/Team/Enterprise)** signed in via opencode
     so the brain stays within your subscription's rate + quota limits
     instead of pay-per-token billing.
   - `SERPER_API_KEY` is **highly recommended** for any information-search
     directive. Search-shaped tasks degrade gracefully without it but
     the system feels half-functional.
3. **Seeds the substrate** — foundational knowledge, canonical artifacts,
   demo directive templates.
4. **Starts the daemon** + the canonical worker set (embedder, scheduler,
   father, extractors, auto_apply, …).
5. **Runs `acc doctor`** as the readiness check.
6. **Offers 3-5 demo directives** matched to which keys you provided —
   each demo exercises the full RLM loop (decomposition → action artifact →
   verifier residual → credit chain → knowledge candidate) and produces a
   30-second readable result.

## After install

- `acc watch` — live SQLite-native TUI dashboard.
- `acc state` (mcp) and `acc admin substrate-status` — substrate liveness.
- `acc task "<your request>"` — natural language directive; brain decomposes.
- Owner-facing chat with Claude: speak any language, ask anything, request
  changes mid-flight via amendments.

See [docs/operator-install.md](operator-install.md) for the manual install
path (used by integration tests + CI). See [docs/Architecture.md](Architecture.md)
for the canonical architectural reference.
