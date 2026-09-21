# DreamMachine research laboratory

[![CI](https://github.com/rudycelekli/DreamMachine/actions/workflows/ci.yml/badge.svg)](https://github.com/rudycelekli/DreamMachine/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

A personal research lab that reads recent AI papers, implements one testable
idea per cycle, measures it against a frozen baseline, and remembers the result.
Built on [ruvnet/dream-machine](https://github.com/ruvnet/dream-machine) and
[RuVector](https://github.com/ruvnet/RuVector).

The objective is a useful, evidence-backed change each cycle. An unsuccessful
experiment still produces a durable lesson. No improvement or scientific
originality is guaranteed.

## Twice-daily loop

1. Discover recently submitted papers and retrieve prior research lessons.
2. Read primary sources and select one bounded, falsifiable hypothesis.
3. Create a mandatory ADR and freeze an external correctness oracle.
4. Implement in an isolated candidate worktree.
5. Run the same full checks and oracle against baseline and candidate.
6. Obtain an independent critique; record ACCEPT, REJECT, or INCONCLUSIVE.
7. Verify the report, ADR, evidence receipts, and retained memory.

When no useful new paper qualifies, the researcher may propose a clearly labeled
speculative idea with a prior-art search and a falsifiable prediction. Source
outages are recorded as blockers, not evidence that research has stopped.

**ACCEPT means ready for human review.** Code is never merged automatically.
Every cycle needs an ADR, including small changes, rejected experiments,
inconclusive results, and speculative ideas.

## Run locally

Requires Node.js 22.13+ within the 22.x line, or Node.js 24.x, and Git.

```sh
git clone https://github.com/rudycelekli/DreamMachine.git
cd DreamMachine
npm ci
npm run build
npm run check
npm run research -- status
npm run research -- prepare
```

Follow the returned run's `.dream/research/runs/RUN_ID/PROMPT.md`.
`prepare` creates the research context; an AI coding agent follows that prompt
to research, implement, evaluate, and finish the cycle.

The maintainer's Codex schedule runs at **07:00 and 19:00 America/Toronto**.
New cycle IDs include their slot, for example `2026-09-22-0700` and
`2026-09-22-1900`, with a separate experiment, report, and ADR for each.
It requires the local computer and Codex to be running. Cloning this repository
does not install that schedule. GitHub Actions validates code; it does not run
the daily AI researcher.

## Architecture and evidence

- Dream Machine supplies the compiler, ledger, and report witnesses.
- Native RuVector provides vector insert/search over durable local research
  memory. The current embedding is deterministic lexical feature hashing;
  it is not a trained neural embedding or model-weight self-improvement.
- Each cycle has a 60-minute limit, one frozen hypothesis, and one evaluation.
- The correctness gate requires a failing baseline oracle, passing candidate
  oracle, and passing existing checks on both.
- Raw runs, vector memory, reports, and generated daily ADRs stay local in
  ignored directories. This public repository contains code and numbered
  architecture decisions. Publishing experimental artifacts is a separate step.

Start with the [research runbook](docs/RESEARCH-LOOP.md),
[research configuration](research.config.json), and
[architecture decisions](docs/adrs/INDEX.md).

## Upstream and license

This repository preserves the history and MIT license of
[`ruvnet/dream-machine`](https://github.com/ruvnet/dream-machine), integrated
from commit `aa931caad5dd0108253645bba0ab1481ad7da0ee`.
The original guide is retained as [upstream documentation](README.upstream.md).
Its publishing commands and hosted-service examples describe the upstream
project; this lab's [AGENTS.md](AGENTS.md) and runbook govern local operation.

The inherited Pages, package-release, and OpenRouter research workflows are
restricted to the upstream repository. This repository's CI also runs the
local research integration tests. Dependencies are recorded in
[`package-lock.json`](package-lock.json).
