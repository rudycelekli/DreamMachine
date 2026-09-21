# Daily research and implementation

This checkout combines the actual [Dream Machine engine](https://github.com/ruvnet/dream-machine)
with native [RuVector](https://github.com/ruvnet/RuVector). The daily Codex task
provides the researcher, implementer and independent critic. The local CLI
provides discovery, memory, isolation, measurement, evidence and reports.
Every cycle also has a mandatory ADR, including small changes, failed or blocked
experiments and speculative ideas; see [ADR-0108](adrs/ADR-0108-mandatory-research-cycle-adrs.md).
The public code repository is [rudycelekli/DreamMachine](https://github.com/rudycelekli/DreamMachine).
GitHub CI validates the code; the AI research schedule runs locally in Codex.
Raw research artifacts remain local unless separately selected for publication;
see [ADR-0109](adrs/ADR-0109-public-research-repository.md).
Running `prepare` alone does not implement code: the scheduled agent follows
the generated instructions to complete the cycle.

The default research target is this repository, with a rotating focus on agent
memory, retrieval, evaluation, novelty selection and bounded reasoning.
Configure source queries and surfaces in `research.config.json`. The daily
schedule is a Codex heartbeat at 07:00 America/Toronto; changing `dailyHour`
in the JSON does not reschedule the task. Change the actual scheduled task too.
Keep the computer on and Codex running for scheduled local work.

## Run now

```sh
npm ci
npm run build
npm run research -- status
npm run research -- prepare
```

Open the returned `.dream/research/runs/YYYY-MM-DD/PROMPT.md`, `papers.json`
and `memory.json`. Preparation resumes an unfinished run and will not create a
second run on the same Toronto date. Each cycle has a 60-minute deadline, one
frozen hypothesis and one evaluation. At most three accepted candidates await
review. A stale or blocked run must be abandoned with a specific useful lesson;
it cannot silently vanish. If the controller process is killed, inspect
`.dream/research/controller.lock/owner.json` and confirm its process is gone
before removing that stale lock directory.
Memory also has `.dream/research/memory/.memory.lock`, containing its owning
PID and hostname. Confirm that owner stopped before removing an abandoned
memory lock. Never remove a lock belonging to a running process.

The query selects arXiv papers first submitted during the previous seven days,
sorted by submission date. Canonical IDs prevent treating v2 of an old paper as
a newly released paper. This bounded source scan is not comprehensive coverage
of all conferences or the entire research literature. The researcher must
read primary sources and perform a web prior-art search before implementation.
An abstract supports discovery, not a claim that the full paper was read.
Use `npm run research -- search YYYY-MM-DD 'all:"specific topic"'` before
freezing to record additional focused arXiv discovery (four queries per cycle
maximum). Leave at least three seconds between arXiv requests. Source totals
and truncation are preserved so absence from the newest results is not treated
as absence from the literature.

## Propose and freeze

Write a new external `.test.mjs` regression oracle under the run directory.
The same file runs unchanged against baseline and candidate. Import the code
under test through `process.env.DREAM_TARGET_ROOT`. It must check a real
requirement, not the target directory name, branch, clock or changed version.
An example oracle for a ledger parser would import the baseline/candidate's
built `packages/ledger/dist/index.js` using `pathToFileURL(join(root,...))` and
assert a correctly parsed expected row. Both builds run before the oracle.

Create `proposal.json` under the run directory:

```json
{
  "kind": "paper",
  "paperIds": ["CANONICAL_ARXIV_ID_FROM_PAPERS_JSON"],
  "hypothesis": "Given the frozen adversarial input, the proposed change will preserve the expected result while all existing checks remain green.",
  "changeSummary": "One concrete method adapted from the inspected source.",
  "expectedOutcome": "The unchanged correctness oracle fails on baseline and passes on candidate.",
  "rationale": "Explain why the paper's method applies to this repository and identify its limitations.",
  "priorArt": [{
    "query": "The actual prior-art query used",
    "finding": "The closest existing method and the precise distinction, without claiming global originality.",
    "urls": ["https://arxiv.org/abs/ACTUAL_INSPECTED_ID"]
  }],
  "validation": { "testFile": ".dream/research/runs/YYYY-MM-DD/oracle.test.mjs" }
}
```

These are schema examples, not invented paper citations. Replace their values
with inspected sources. Use `kind: "wild-idea"` and `paperIds: []` when no
useful new paper qualifies. Also include `noveltyCaveat` explaining that a
prior-art search cannot prove nobody has considered the idea. When discovery
found unseen relevant papers, include `noPaperReason` explaining why none are
useful or testable. Speculation should combine distant mechanisms with a
specific known failure from memory and predict a falsifiable outcome. A
network/source failure is not evidence that there is no new research and
cannot trigger this fallback.

```sh
npm run research -- freeze YYYY-MM-DD .dream/research/runs/YYYY-MM-DD/proposal.json
```

Freeze captures the clean committed baseline, policy and oracle, then creates
baseline and candidate worktrees. Change only the returned candidate directory.
The default scope allows memory, ledger and compiler source; it excludes the
controller, witness/security boundaries, existing tests, dependencies and
configuration. An experiment cannot expand its own policy. Infrastructure or
new benchmark work can be proposed separately for human review.

## Evaluate and learn

```sh
npm run research -- evaluate YYYY-MM-DD
```

The evaluator runs the fixed configured command against both worktrees, then
the same frozen external oracle against each. A qualifying correctness result
requires green baseline regressions, green candidate regressions, a failing
baseline oracle and a passing candidate oracle. A merely green test suite is
not improvement. Logs, command exits, digests and the candidate patch are
retained. Existing tests and gold data cannot be changed. Worktrees share the
trusted pinned dependencies, not source/build outputs; they are not OS or
network sandboxes. Only repository-owned code is evaluated. Paper code is not
automatically downloaded or executed.

An independent critic should inspect the full receipts, oracle and patch,
source attribution, overfitting and unexpected effects. Save `review.json`:

```json
{
  "critic": "actual independent reviewer or subagent identity",
  "analysis": "Specific observations about the measurement, source adaptation, scope and reward-hacking risks.",
  "rewardHackClear": true,
  "concerns": [],
  "lesson": "A concrete evidence-based lesson and what the next cycle should test."
}
```

```sh
npm run research -- finish YYYY-MM-DD .dream/research/runs/YYYY-MM-DD/review.json
npm run research -- verify YYYY-MM-DD
```

No improvement can be guaranteed. ACCEPT is a recommendation for review,
REJECT records a failed criterion, and INCONCLUSIVE records a blocker or
insufficient evidence. The controller verifies file integrity and test results;
the critic's independence and qualitative assessment rely on the orchestrating
agent. This is not an independent security authority or a scientific peer review.
Performance-only ideas, model-quality claims or training jobs require a
separately designed benchmark and budget; this first implementation's automated
acceptance gate measures correctness. It never invents those measurements.

```sh
npm run research -- abandon YYYY-MM-DD "The specific blocker; the exact measurement needed next."
npm run research -- recall "memory retrieval failure"
```

`reports/research/LATEST.md` is the most recent report. Dated reports, adjacent
witness JSON and `LEDGER.md` preserve history. Raw source records, hypotheses,
worktrees, patches and logs live in `.dream/research/`. All are local and ignored
by Git to avoid contaminating future baseline snapshots. Back up these directories
if the machine is replaced. No public issues, gists or PRs are created.
The controller creates `docs/adrs/research/ADR-YYYY-MM-DD.md` during preparation
and updates it through freezing, evaluation and completion. The separate
[ADR index](adrs/research/INDEX.md) links every cycle's context, decision,
alternatives, evidence, consequences and next steps. ACCEPT remains Proposed
pending human review; REJECT and INCONCLUSIVE receive their own explicit status.
Missing or changed ADRs or index entries fail `verify`. Cycle ADRs and their
index are local generated artifacts, ignored by Git so updates do not dirty the
baseline. Back them up together with reports and `.dream/research/`.
Use `repair YYYY-MM-DD` only to rebuild derived reports/ledger/memory after an
interrupted completion. It is not a way to repair modified experimental evidence.

Review a successful candidate with `git diff` in its worktree or its saved
`candidate.patch`. Merging/applying code is an explicit human decision. After
review, `disposition YYYY-MM-DD reviewed` or `discarded` releases its pending
slot; it does not apply code or delete evidence. Accepted changes do not silently
become tomorrow's baseline; the baseline advances after an explicitly reviewed
change reaches the target branch. Research memory advances after every cycle.

## Integration details

- Upstream Dream Machine: cloned at `aa931caad5dd0108253645bba0ab1481ad7da0ee`.
  Its real compiler generates each `DREAM-REFERENCE.md`; its ledger library
  computes learning signals and renders the journal; its witness package stamps
  reports against the baseline SHA. Original source and license are preserved.
- RuVector: exact optional package `@ruvector/core@0.1.32`, native vector insert
  and search, canonical atomic JSON records and a disposable native index rebuilt
  on reopen. We do not rely on the wrapper's unreliable persisted-index reload.
  Approximate search can return fewer than the requested number of results.
  Memory is bounded at 10,000 records and 64 MiB; reaching a limit is an explicit
  blocker requiring archival/migration, never silent deletion of past lessons.
- Embeddings: deterministic 384-dimensional lexical feature hashing, zero remote
  API calls. This is real native vector retrieval, not a claim of neural semantic
  understanding, learned embeddings, GNN training or self-training model weights.
  Backend status clearly reports a lexical fallback if the native package fails.
- Selection: explicit ID deduplication, local lexical relevance and prior-result
  retrieval assist the AI's judgment. No heuristic score proves scientific novelty.
  Each recall/preparation also includes the last seven experiment lessons
  separately from ranked vector hits, so abundant paper records cannot crowd
  recent rejections out of the next cycle's context.
- Source parser: exact `fast-xml-parser@5.11.1`, bounded arXiv retrieval with
  source status and timestamps. Unavailable sources remain explicit failures.
- Credentials: discovery/memory/evaluation use no paid model API. The scheduled
  agent consumes the normal Codex account allowance. No new model subscription
  or API key is configured by this project.

## Validation

`npm run check` runs upstream type checks/build/lint/governance checks and the
research tests. `npm run test:research` runs discovery, native/fallback memory,
experiment isolation/evidence and controller regressions. Offline fixtures are
clearly test data and never represented as newly discovered research.

Primary references: [arXiv API manual](https://info.arxiv.org/help/api/user-manual.html),
[RuVector source](https://github.com/ruvnet/RuVector),
[Dream Machine source](https://github.com/ruvnet/dream-machine),
[Codex scheduled tasks](https://learn.chatgpt.com/docs/automations?surface=app).
