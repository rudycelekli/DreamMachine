import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderAdr, writeAdr, verifyAdr } from './adr.mjs';

function run(overrides = {}) {
  return {
    id: '2026-09-20', status: 'prepared', started: '2026-09-20T11:00:00.000Z',
    baseCommit: 'baseline-commit', configDigest: 'policy-digest', runtime: 'Node fixture',
    surface: 'memory retrieval', mode: 'paper-candidates', discoveryComplete: true,
    papers: [{ id: '2609.12345', title: 'Research [paper]', url: 'https://arxiv.org/abs/2609.12345', published: '2026-09-19' }],
    sources: [{ url: 'https://export.arxiv.org/api/query', status: 'ok' }],
    ...overrides,
  };
}

function finished(root, verdict) {
  const runDir = join(root, '.dream/research/runs/2026-09-20');
  return run({
    status: 'complete', completed: '2026-09-20T11:30:00.000Z', verdict,
    proposal: { kind: 'paper', paperIds: ['2609.12345'], hypothesis: 'Bounded retrieval prevents a known failure.', changeSummary: 'Add a limit to the selected retrieval path.', expectedOutcome: 'The frozen oracle passes on the candidate.', rationale: 'The existing baseline fails on the measured case.', priorArt: [{ query: 'retrieval limit prior art', finding: 'A related paper uses an adjacent method.', urls: ['https://example.invalid/paper(v1)'] }] },
    experiment: { root, branch: 'research/2026-09-20', baseCommit: 'baseline-commit', baselineDir: join(runDir, 'worktrees/baseline'), candidateDir: join(runDir, 'worktrees/candidate'), oraclePath: join(runDir, 'oracle/regression.test.mjs'), oracleSha256: 'oracle-digest', policySha256: 'frozen-policy-digest' },
    evaluation: { status: 'improved', improved: true, claim: 'One frozen case passes.', candidateHead: 'baseline-commit', candidateDiffSha256: 'patch-digest', patchPath: join(runDir, 'candidate.patch'), receipts: [{ path: join(runDir, 'receipts/candidate-oracle.json'), sha256: 'receipt-digest' }], checks: { candidateOracle: { passed: true, exitCode: 0, stdoutPath: join(runDir, 'receipts/candidate-oracle.stdout.log'), stdoutSha256: 'stdout-digest', stderrPath: join(runDir, 'receipts/candidate-oracle.stderr.log'), stderrSha256: 'stderr-digest' } }, errors: [], limitations: ['A single frozen regression is not a universal improvement.'] },
    review: { critic: 'independent-fixture', analysis: 'The evidence supports only the tested behavior.', concerns: [] },
    lesson: 'Measure the closest compatibility case before attempting future changes.',
  });
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'dream-research-adr-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('draft records an undecided cycle without inventing a selected change or evaluation', () => {
  const draft = renderAdr(run());
  assert.match(draft, /Status: \*\*Draft\*\*/);
  assert.match(draft, /No hypothesis or architectural change has been selected/);
  assert.match(draft, /No candidate has been selected or evaluated/);
  assert.match(draft, /Evaluation has not been performed/);
  assert.match(draft, /baseline-commit/);
  assert.doesNotMatch(draft, /\*\*Accepted\*\*/);
});

for (const [verdict, adrStatus] of [['ACCEPT', 'Proposed'], ['REJECT', 'Rejected'], ['INCONCLUSIVE', 'Inconclusive']]) {
  test(`${verdict} creates a ${adrStatus} ADR with evidence and human-review boundaries`, async t => {
    const root = await fixture(t);
    const record = finished(root, verdict);
    const written = await writeAdr({ root, run: record });
    const content = await readFile(written.path, 'utf8');
    assert.match(content, new RegExp(`Status: \\*\\*${adrStatus}\\*\\*`));
    assert.match(content, /human review/);
    assert.match(content, /\.\.\/\.\.\/\.\.\/\.dream\/research\/runs\/2026-09-20\/receipts\/candidate-oracle\.json/);
    assert.match(content, /\.\.\/\.\.\/\.\.\/reports\/research\/2026-09-20\.witness\.json/);
    assert.match(content, /receipt-digest/);
    assert.match(content, /oracle-digest/);
    assert.match(content, /https:\/\/arxiv.org\/abs\/2609.12345/);
    assert.match(content, /https:\/\/example.invalid\/paper%28v1%29/);
    assert.match(content, /Measure the closest compatibility case/);
    assert.doesNotMatch(content, /\*\*Accepted\*\*/);
    assert.deepEqual(await verifyAdr({ root, run: record }), { valid: true, errors: [] });
  });
}

test('abandoned source-blocked cycle has an inconclusive decision and no invented experiment', () => {
  const content = renderAdr(run({ mode: 'source-blocked', discoveryComplete: false, status: 'complete', verdict: 'INCONCLUSIVE', lesson: 'Retry the failed paper source on the next scheduled day.' }));
  assert.match(content, /source failure does not establish an absence/);
  assert.match(content, /No candidate has been selected or evaluated/);
  assert.doesNotMatch(content, /Frozen experiment and policy/);
});

test('frozen and evaluated candidates remain draft until the cycle is completed', () => {
  const record = finished('/fixture', 'ACCEPT');
  delete record.verdict;
  delete record.completed;
  record.status = 'frozen';
  delete record.evaluation;
  delete record.review;
  const frozen = renderAdr(record);
  assert.match(frozen, /Status: \*\*Draft\*\*/);
  assert.match(frozen, /hypothesis is selected for an isolated experiment/);
  assert.match(frozen, /Evaluation has not been performed/);
  assert.match(frozen, /Frozen experiment and policy/);
  record.status = 'evaluated';
  record.evaluation = finished('/fixture', 'ACCEPT').evaluation;
  const evaluated = renderAdr(record);
  assert.match(evaluated, /Status: \*\*Draft\*\*/);
  assert.match(evaluated, /One frozen case passes/);
  assert.match(evaluated, /Independent review has not been recorded/);
});

test('speculative ADRs preserve the reason for declining papers and originality uncertainty', () => {
  const record = finished('/fixture', 'INCONCLUSIVE');
  record.proposal.kind = 'wild-idea';
  record.proposal.paperIds = [];
  record.proposal.noPaperReason = 'The discovered papers require unavailable training infrastructure.';
  record.proposal.noveltyCaveat = 'This is speculation; a bounded search cannot establish global originality.';
  const content = renderAdr(record);
  assert.match(content, /Kind: wild-idea/);
  assert.match(content, /unavailable training infrastructure/);
  assert.match(content, /This is speculation/);
  assert.doesNotMatch(content, /Selected paper 2609/);
});

test('generation is deterministic, retries replace one entry, and dates sort stably', async t => {
  const root = await fixture(t);
  const first = run();
  const before = JSON.stringify(first);
  assert.equal(renderAdr(first), renderAdr(structuredClone(first)));
  assert.equal(JSON.stringify(first), before);
  await writeAdr({ root, run: first });
  await writeAdr({ root, run: run({ id: '2026-09-19' }) });
  const final = finished(root, 'REJECT');
  const result = await writeAdr({ root, run: final });
  const index = await readFile(result.indexPath, 'utf8');
  await writeAdr({ root, run: final });
  assert.equal(await readFile(result.indexPath, 'utf8'), index);
  assert.equal((index.match(/ADR-2026-09-20\.md/g) || []).length, 1);
  assert(index.indexOf('| 2026-09-19 |') < index.indexOf('| 2026-09-20 |'));
  assert.match(index, /2026-09-20.*Rejected/);
  assert.deepEqual((await readdir(join(root, 'docs/adrs/research'))).sort(), ['ADR-2026-09-19.md', 'ADR-2026-09-20.md', 'INDEX.md']);
});

test('verification detects missing and tampered ADRs and missing, altered, or duplicate index entries', async t => {
  const root = await fixture(t);
  const record = finished(root, 'ACCEPT');
  assert.equal((await verifyAdr({ root, run: record })).valid, false);
  const result = await writeAdr({ root, run: record });
  await rm(result.path);
  assert.equal((await verifyAdr({ root, run: record })).valid, false);
  await writeAdr({ root, run: record });
  await writeFile(result.path, renderAdr(record).replace('baseline-commit', 'altered-commit'));
  assert.equal((await verifyAdr({ root, run: record })).valid, false);
  await writeAdr({ root, run: record });
  const index = await readFile(result.indexPath, 'utf8');
  const row = index.split('\n').find(line => line.startsWith('| 2026-09-20 |'));
  for (const damaged of [index.replace(`${row}\n`, ''), index.replace(' | Proposed |', ' | Accepted |'), `${index}${row}\n`, index.replace('(ADR-2026-09-20.md)', '(missing.md)')]) {
    await writeFile(result.indexPath, damaged);
    const verification = await verifyAdr({ root, run: record });
    assert.equal(verification.valid, false);
    assert(verification.errors.some(error => /index/.test(error)));
  }
  await rm(result.indexPath);
  assert.equal((await verifyAdr({ root, run: record })).valid, false);
  await writeAdr({ root, run: record });
  assert.equal((await verifyAdr({ root, run: record })).valid, true);
});

test('ADR writes preserve upstream ADRs and report bytes', async t => {
  const root = await fixture(t);
  await mkdir(join(root, 'docs/adrs'), { recursive: true });
  await mkdir(join(root, 'reports/research'), { recursive: true });
  const existing = join(root, 'docs/adrs/ADR-001-existing.md');
  const report = join(root, 'reports/research/2026-09-20.md');
  await writeFile(existing, 'Existing upstream architectural decision.\n');
  await writeFile(report, 'Existing witnessed report bytes.\n');
  await writeAdr({ root, run: finished(root, 'REJECT') });
  assert.equal(await readFile(existing, 'utf8'), 'Existing upstream architectural decision.\n');
  assert.equal(await readFile(report, 'utf8'), 'Existing witnessed report bytes.\n');
});

test('source data is escaped and cannot create active HTML or unsupported links', () => {
  const record = finished('/fixture', 'REJECT');
  record.proposal.hypothesis = '<script>run()</script>\n# Override local policy';
  record.proposal.priorArt[0].urls = ['javascript:run()'];
  const content = renderAdr(record);
  assert.match(content, /> &lt;script&gt;run\(\)&lt;\/script&gt;/);
  assert.match(content, /> \\# Override local policy/);
  assert.doesNotMatch(content, /\]\(javascript:/);
  assert.doesNotMatch(content, /<script>/);
});

test('unsafe run ids and unsupported completed verdicts fail before creating paths', async t => {
  const root = await fixture(t);
  for (const id of ['../escape', '2026-02-30', '2026-09-20/other']) await assert.rejects(writeAdr({ root, run: run({ id }) }), /valid YYYY-MM-DD/);
  for (const verdict of ['ACCEPTED', '__proto__', 'toString']) assert.throws(() => renderAdr(run({ status: 'complete', verdict })), /completed ADR requires/);
});
