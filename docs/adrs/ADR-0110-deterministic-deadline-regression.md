# ADR-0110: Make the expired-deadline regression independent of runner speed

Status: Accepted for public repository CI
Date: 2026-09-21
Related: ADR-0109

## Context

The first public CI run passed the ordinary unit and governance tests, but
Linux with Node 24 exposed a race in the research integration test named
`the overall frozen deadline prevents launching additional checks`.

The fixture allowed 0.001 minutes (60 milliseconds) and relied on worktree
creation and filesystem checks taking longer than that. The local machine
satisfied the assumption; the hosted runner was fast enough to start the
baseline check before expiry. The test expected no baseline receipt, so its
timing assumption failed even though the controller treated expiry as
inconclusive. The software-evidence job also reported a failed repository
check, without exposing its nested test output; that job needs revalidation.

## Decision

Make the test observe an explicitly expired clock after the experiment is
frozen. Preserve the original assertions: no check launches, no improvement
is claimed, and the result records deadline exhaustion. Keep the real
controller, configured limits, immutable experiment metadata and source
policy unchanged. The test clock is scoped to the test and restored afterward.

This is a CI test-fixture correction during repository setup. It does not
modify a daily cycle's frozen oracle, stored evidence, baseline or candidate.

## Alternatives considered

- Retry CI until the test passes: hides the hardware-speed dependency.
- Sleep long enough: slows the suite and retains real-time scheduling noise.
- Permit a launched baseline or remove the assertion: weakens the intended
  contract instead of establishing its precondition.
- Change the production timeout policy: unnecessary; the observed failure is
  an incorrect assumption in the test setup.

## Evidence and validation

The [initial public CI run](https://github.com/rudycelekli/DreamMachine/actions/runs/35599345173)
records 61 passing research tests and the one deadline-fixture failure on
Node 24. Its baseline receipt started before the short deadline, proving that
filesystem setup was not a reliable way to make time expire.

Run the targeted experiment integration tests and the full `npm run check`,
then rerun GitHub's Node 22/24 matrix and software-evidence job. Confirm the
deadline assertions still exercise the production evaluator and no checks or
thresholds were relaxed.

## Consequences and next steps

The same deadline contract becomes portable across fast and slow runners.
Future time-dependent tests should control their clock or synchronization
condition explicitly. Continue to retain separate real child-process timeout
coverage; a mocked expiry test does not replace that behavior.
