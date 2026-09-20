# ADR-0108: Always record research decisions in ADRs

Status: Accepted user policy; implemented in the local research controller
Date: 2026-09-20
Related: ADR-0001, ADR-0103, ADR-0104

## Context

The daily loop combines Dream Machine's compiler, ledger and witnesses with
native RuVector memory, bounded paper discovery and isolated candidate tests.
Reports and experiment logs already retain measurements and lessons. They do
not replace a consistent record of why a decision was made, what alternatives
were considered and what follows from the outcome.

The user requires that we always create ADRs. The earlier architecture-only
exception would omit small changes, rejected experiments and blocked research.

## Decision

Every research cycle creates one dated ADR during preparation, before code is
changed. The controller updates it when a hypothesis is frozen, after evaluation,
and when the cycle finishes or is abandoned. Repeated commands and recovery
reuse the same date-based ID; they do not create duplicate ADRs.

Store cycle ADRs at `docs/adrs/research/ADR-YYYY-MM-DD.md` with a separate index.
Include context, the decision and rationale, alternatives, original sources,
baseline and evidence links, consequences, uncertainty and follow-up actions.
Every outcome is recorded: paper-driven or speculative, ACCEPT, REJECT,
INCONCLUSIVE, blocked, or no implementation. An ACCEPT verdict remains a
Proposed decision awaiting human review; it is not an accepted code change.

Creation and index updates are mandatory controller operations. Failure to
write the ADR prevents successful completion; verification rejects a missing
or changed ADR or its index entry. Interrupted operations may be retried, and
`repair` can reconstruct derived ADRs from preserved run state. It does not
change experimental evidence. Backfill existing completed cycles.

The compiler and daily automation explicitly require ADRs without a size or
architecture exception. Decisions outside a daily cycle, including changes to
the loop itself, receive a numbered ADR and an architecture-index entry.

## Consequences

The reasoning behind unsuccessful work remains discoverable. Preparing a draft
does not invent a decision: it records that selection and evaluation are pending.
Reports and their witnesses stay byte-for-byte unchanged when an older run gains
its ADR; the ADR links to the original artifacts.

The numbered policy ADR and its parent index are version-controlled. Generated
cycle ADRs and their own index are local artifacts, ignored by Git alongside the
reports and run state. This prevents automatic index updates from dirtying the
trusted baseline before an experiment can freeze. Back up all three artifact
directories together; publication or incorporation into a reviewed change is
separate from recording the local decision. No code is promoted automatically.

## Alternatives considered

- Architecture-only ADRs: rejected because the user requires ADRs always.
- A reminder in the scheduled prompt: insufficient; missing records must be
  detected by the controller and verifier.
- Writing into the shared numbered index every day: avoided because it dirties
  tracked baseline files before candidate isolation and introduces numbering
  contention. Date-based cycle IDs are stable and independently indexed.
- Updating historical report bodies to add ADR links: avoided to preserve
  existing report hashes and witnesses.

## Test contract

Exercise draft, Proposed, Rejected and Inconclusive ADRs, source-blocked and
speculative cycles, deterministic retries, missing or changed ADRs/index entries,
and recovery after a failed ADR write. Preserve original report witnesses while
backfilling the completed 2026-09-20 cycle. Run the full repository checks.

## References

- [Daily research loop](../RESEARCH-LOOP.md)
- [Research-cycle ADR index](./research/INDEX.md)
- [Initial experiment report](../../reports/research/2026-09-20.md)
