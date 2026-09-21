# ADR-0111: Run research at 07:00 and 19:00 Toronto time

Status: Accepted user request
Date: 2026-09-21
Related: ADR-0108, ADR-0109, ADR-0110
Supersedes: Date-only identity for new multi-slot cycles in ADR-0108; historical records remain unchanged

## Context

The user requested two research and implementation cycles per day. The existing
heartbeat runs at 07:00, and the controller identifies every run only by its
Toronto calendar date. Adding a second trigger alone would return the completed
morning result rather than conduct a second experiment.

Each experiment must keep its own frozen hypothesis, worktrees, report, witness,
memory lesson, and mandatory ADR. Existing reports and decision records are
verified evidence and must not be rewritten merely to change the schedule.

## Decision

Update the existing thread heartbeat to run at 07:00 and 19:00 America/Toronto.
Retain its target thread, active status, notification settings and research
scope. This updates one automation rather than creating duplicate jobs.

Set `dailyHours` to `[7, 19]`. New run IDs include the local slot, for example
`2026-09-22-0700` and `2026-09-22-1900`. Use that ID consistently for directories,
branches, reports, memory keys and `docs/adrs/research/ADR-RUN_ID.md`. Ledger
dates and staleness calculations continue using the calendar-date portion.

Select the latest configured local slot at or before preparation time; before
the day's first slot, select the prior calendar day's final slot. Slot identity
does not depend on elapsed UTC hours, including daylight-saving transitions.
Missed slots are not automatically backfilled. Manual invocations use the same
identity rules.

An unfinished cycle always resumes first, even after a later slot becomes due.
It must finish or be abandoned with a lesson before a later cycle starts.
Repeated preparation for a completed slot returns that result. Legacy date-only
records remain valid and byte-identical; during migration a completed legacy
run occupies the first slot of its date. Configurations that omit `dailyHours`
retain the original one-date identity.

Preserve the 60-minute budget per cycle, one hypothesis/evaluation per cycle,
three pending accepted candidates, frozen evidence and human-review promotion.
This request does not change publication preferences, authorize automatic
merges, or enable paid APIs. The local computer and Codex must remain available
for execution.

## Alternatives considered

- Change only the heartbeat: rejected because the evening call would return the
  morning record without conducting new work.
- Allocate arbitrary increasing counters: retries could create duplicate runs
  and names would obscure the scheduled time.
- Rename historical runs and regenerate their evidence: unnecessary migration
  would alter reports, witnesses, branches and ADR links.
- Start an evening run while a morning run remains active: introduces overlap
  and abandons the existing recovery and locking contract.

## Consequences

The laboratory can conduct two independently recorded experiments per day.
Total possible research time doubles, while each cycle retains its prior
bounds. Memory and the pending review queue are shared, so a morning lesson is
available to the evening researcher. Review capacity can still limit eligible
new candidates. Old records remain independently verifiable.

## Validation and follow-up

`npm run check` passed all 861 tests: 647 unit, 140 governance and 74 research
tests. Coverage includes morning/evening selection, repeated calls, local
midnight, DST and calendar rollover, invalid IDs, active-run recovery and
migration from date-only history. Two synthetic cycles finish by abandonment
with distinct reports, memory and ADRs; repairing a morning result preserves
the evening's latest report. Fixed legacy ADR render hashes still match.

Both real historical cycles, `2026-09-20` and `2026-09-21`, passed verification
without rewriting their evidence. An independent review found no blocking
issue and traced suffixed IDs through freeze/evaluate; no additional live
experiment was launched for this scheduling change. The existing heartbeat's
persisted schedule and prompt were verified after updating it, including its
unchanged target thread and notification preference. Confirm the next scheduled
cycle produces its own slot-specific report and ADR during normal operation.

## References

- [Research runbook](../RESEARCH-LOOP.md)
- [Research configuration](../../research.config.json)
- [OpenAI scheduled tasks documentation](https://learn.chatgpt.com/docs/automations?surface=app)
