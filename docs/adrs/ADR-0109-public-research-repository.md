# ADR-0109: Publish the research laboratory on GitHub

Status: Accepted user decision
Date: 2026-09-21
Related: ADR-0103, ADR-0108

## Context

The user explicitly requested a public repository so development can continue
every day. The local lab already integrates Dream Machine, native RuVector,
daily paper discovery, isolated experiments, evidence verification, and
mandatory ADRs. Its Git origin currently points to the upstream project.

Publishing the repository is separate from adopting a research candidate or
publishing the local evidence store. The accepted September 21 candidate is
still an unmerged experiment, and its original baseline and receipts must stay
unchanged.

## Decision

Create the public repository `rudycelekli/DreamMachine` with `main` as its
default branch. Publish the committed laboratory implementation and upstream
history, retaining the MIT license and attribution. Preserve the upstream as
the `upstream` remote; use `origin` for the user's repository. Preserve the old
local upstream branch as `upstream-main` when naming the laboratory branch
`main`.

Use a project-specific README and retain the exact integrated upstream README
as reference documentation. Add the research integration tests to GitHub CI.
Restrict inherited website deployment, package release, and paid OpenRouter
research workflows to the upstream repository so repository creation does
not activate those separate services.

Keep `.dream/`, `reports/research/`, and `docs/adrs/research/` ignored. Do not
force-add local memories, absolute-machine-path reports, experiment worktrees,
or generated evidence. Numbered ADRs, including this publication decision,
remain tracked. The existing local daily schedule continues at 07:00
America/Toronto; GitHub CI is not a replacement AI research scheduler.

Daily publication preferences are separate from this initial code publication.
Until the user chooses otherwise, routine artifacts remain local and ACCEPT
means Proposed for human review. No merge, candidate adoption, deployment,
package publication, or paid model job is authorized by this repository setup.

## Alternatives considered

- Keep the laboratory local: inconsistent with the explicit public-repo request.
- Publish a source-only snapshot: loses upstream provenance and historical
  revisions used by differential tests.
- Publish ignored research data wholesale: unnecessary for sharing the code,
  and would expose machine-specific evidence without a portable export.
- Adopt the latest candidate while publishing: conflates repository setup with
  the existing human-review decision.

## Consequences

The public repository becomes the shared codebase for ongoing development.
The original upstream remains available for future synchronization. Local
experiments continue to preserve their baseline commits and evidence. Public
contributors can run the controller and tests but need their own coding-agent
schedule to carry out daily research.

## Validation and next steps

Inspect tracked changes and local history for unintended private content,
retain the upstream license, and run `npm run check` before the first push.
Pre-publication validation passed all 849 tests (647 unit, 140 governance,
62 research); workflow YAML and whitespace checks passed. A content review
found no credential signatures in tracked files or the three local commits.
The retained Git history includes its existing authorship metadata.
Verify the remote repository's public visibility, default branch, and commit
after publication. Check GitHub CI and record any infrastructure limitations.
Keep cycle evidence unchanged and verify the completed local cycles after
repository setup. A later decision can specify portable daily reports and
draft pull requests without permitting automatic merges.

## References

- [Public repository](https://github.com/rudycelekli/DreamMachine)
- [Upstream Dream Machine](https://github.com/ruvnet/dream-machine)
- [RuVector](https://github.com/ruvnet/RuVector)
- [Daily research loop](../RESEARCH-LOOP.md)
- [Mandatory cycle ADR policy](ADR-0108-mandatory-research-cycle-adrs.md)
