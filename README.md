# acc2 — AccInt v2

A universal Recursive Language Model whose recursive memory, synthesis operator, and code-runtime broker live in a persistent substrate daemon.

**Canonical design:** [`docs/v2-design.md`](docs/v2-design.md). Read this end-to-end before contributing.

## Quick orientation

- Substrate is a persistent daemon (always-on, no cold start).
- Three code runtimes: bun, uv, camofox-browser. The brain writes code; the substrate runs it sandboxed; a verifier code artifact returns a scalar residual.
- Every brain dispatch is exactly one cycle. Refinement edges in the DAG replace iteration.
- Two LLM substrates contribute knowledge via subscription CLIs (Claude Code, opencode). The substrate is the merger (Model D).
- Owner is the only human in the loop, via Claude Code chat.

## Layout

```
acc2/
├── substrate/         schema, types, extractors, views, seed
├── runtime/           daemon, three runtimes, sandbox, artifact store, embedder, retrieval, dispatch decider, bridge
│   └── runtimes/      bun.ts, uv.ts, camofox.ts
├── cli/               thin RPC clients to the daemon (acc dispatch, state, doctor, watch)
├── tests/             fixtures + falsifiability + invariant tests
└── docs/              v2-design.md (canonical), whitepaper.md
```

## Environment

`.env` holds `OPENAI_API_KEY` (for `text-embedding-3-small`) and any owner-provisioned external-source bearer tokens. Claude Code and opencode authenticate via their subscription CLIs — no API keys needed for the LLM substrates.

## First commit

This repository is a scaffold. No implementation yet. Phase A (this scaffold + design doc) is complete; Phase B (daemon + minimum substrate) is next per `docs/v2-design.md` §17.
