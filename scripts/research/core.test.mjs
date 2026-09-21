import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { openLab, localDate, rankPapers, researchMode, validateProposal } from './core.mjs';
import { openMemory } from './memory.mjs';
import { parseLedger, verifyLedger } from '../../packages/ledger/dist/index.js';

const paper = { id: '2609.12345', title: 'Agent memory retrieval', abstract: 'Evaluation of memory retrieval in agents.', url: 'https://arxiv.org/abs/2609.12345', published: '2026-09-19T00:00:00Z', updated: '2026-09-19T00:00:00Z', authors: ['Test fixture'], categories: ['cs.AI'] };
test('Toronto date and seen-ID detection do not depend on UTC midnight or title spelling', () => {
  assert.equal(localDate(new Date('2026-09-20T02:00:00Z'), 'America/Toronto'), '2026-09-19');
  const ranked = rankPapers([paper], [{ id: paper.id, kind: 'paper', text: 'a previous title' }], 'retrieval');
  assert.equal(ranked[0].unseen, false);
  assert.equal(researchMode({ complete: true }, ranked), 'wild-idea');
  assert.equal(researchMode({ complete: false }, ranked), 'source-blocked');
  assert.equal(researchMode({ complete: true }, rankPapers([paper], [], 'retrieval')), 'paper-candidates');
});
test('speculation cannot replace failed research or assert unsupported originality', () => {
  const proposal = { kind: 'wild-idea', paperIds: [], hypothesis: 'An unusual specific falsifiable hypothesis.', rationale: 'Specific application to an observed failure.', changeSummary: 'A small concrete candidate implementation.', expectedOutcome: 'A frozen correctness regression passes.', priorArt: [{ query: 'agent memory test search', finding: 'Related prior art exists and overlap is uncertain.', urls: [paper.url] }] };
  assert.throws(() => validateProposal(proposal, { mode: 'source-blocked', papers: [] }), /source failure/);
  assert.throws(() => validateProposal(proposal, { mode: 'wild-idea', papers: [] }), /uncertainty/);
  proposal.noveltyCaveat = 'The search cannot establish global originality.';
  assert.doesNotThrow(() => validateProposal(proposal, { mode: 'wild-idea', papers: [] }));
  assert.throws(() => validateProposal(proposal, { mode: 'paper-candidates', papers: [paper] }), /Explain why/);
});
test('paper hypotheses must reference the actual discovery snapshot', () => {
  const proposal = { kind: 'paper', paperIds: ['made-up'], hypothesis: 'A concrete falsifiable hypothesis about memory.', rationale: 'Specific application to an observed failure.', changeSummary: 'A small concrete candidate implementation.', expectedOutcome: 'A frozen correctness regression passes.', priorArt: [{ query: 'agent memory', finding: 'The paper describes a related method.', urls: [paper.url] }] };
  assert.throws(() => validateProposal(proposal, { mode: 'paper-candidates', papers: [paper] }), /recorded discovery/);
});

async function fixture(t, discover, configOverrides = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dream-research-controller-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = { version: 1, publication: 'local-only', promotion: 'human-review', maxMinutes: 60, maxPendingCandidates: 3, timezone: 'America/Toronto', surfaces: ['memory retrieval'], discovery: { lookbackDays: 7, maxResults: 10 }, memory: { backend: 'lexical' }, ...configOverrides };
  await writeFile(join(root, 'research.config.json'), JSON.stringify(config));
  await writeFile(join(root, 'dream.config.json'), JSON.stringify({ repo: 'local/test', cron: '0 11 * * *', slots: [{ deep: 'memory', scan: ['evaluation'] }] }));
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture'], { cwd: root });
  return openLab(root, { discover });
}
test('complete cycle persists a witnessed report, one ledger row, memory and daily idempotency', async t => {
  let requests = 0;
  const lab = await fixture(t, async () => { requests++; return { complete: true, papers: [paper], sources: [{ url: 'https://export.arxiv.org/api/query', status: 'ok' }] }; });
  const prepared = await lab.prepare();
  assert.equal(prepared.mode, 'paper-candidates');
  assert.equal((await lab.prepare()).id, prepared.id);
  assert.equal(requests, 1);
  const report = await lab.finalize(prepared.id, { lesson: 'Fixture-only run: no implementation attempted; test next with a real oracle.' }, true);
  assert.equal(report.verdict, 'INCONCLUSIVE');
  assert.equal((await lab.verifyRun(prepared.id)).valid, true);
  await lab.finalize(prepared.id, { lesson: 'Ignored duplicate completion with a sufficiently long lesson.' }, true);
  assert.equal((await lab.prepare()).alreadyComplete, true);
  assert.equal(requests, 1);
  const ledger = await readFile(join(lab.root, 'reports/research/LEDGER.md'), 'utf8');
  assert.equal(ledger.trim().split('\n').length, 3);
  const recall = await lab.recall('implementation oracle');
  assert(recall.hits.some(h => h.kind === 'experiment'));
  const emptyQuery = await lab.recall('');
  assert.equal(emptyQuery.hits.length, 0);
  assert.equal(emptyQuery.recentLessons[0].id, `experiment:${prepared.id}`);
  assert((await readFile(join(prepared.runDir, 'DREAM-REFERENCE.md'), 'utf8')).includes('STEP 26'));
  await writeFile(join(prepared.runDir, 'REPORT.md'), 'tampered');
  assert.equal((await lab.verifyRun(prepared.id)).valid, false);
  assert.equal((await lab.repair(prepared.id)).valid, true);
});
test('blocked source is recorded and never becomes a claimed no-new-research day', async t => {
  const lab = await fixture(t, async () => ({ complete: false, papers: [], sources: [{ url: 'https://export.arxiv.org/api/query', status: 'error', error: 'timeout' }] }));
  const run = await lab.prepare();
  assert.equal(run.mode, 'source-blocked');
  await lab.finalize(run.id, { lesson: 'The arXiv source timed out; retry source retrieval on the next scheduled day.' }, true);
  const report = await readFile(join(lab.root, 'reports/research/LATEST.md'), 'utf8');
  assert.match(report, /source scan incomplete/);
  assert.match(report, /timeout/);
  assert.equal((await lab.verifyRun(run.id)).valid, true);
});
test('overlapping controllers fail with a recoverable owner record', async t => {
  const lab = await fixture(t, async () => ({ complete: true, papers: [], sources: [] }));
  await mkdir(join(lab.root, '.dream/research/controller.lock'));
  await assert.rejects(lab.prepare(), /controller is locked/);
});
test('interrupted preparation is rebuilt without a second remote request', async t => {
  let requests = 0;
  const lab = await fixture(t, async () => { requests++; return { complete: true, papers: [paper], sources: [] }; });
  const run = await lab.prepare();
  run.status = 'preparing';
  run.preparationComplete = false;
  await writeFile(join(run.runDir, 'run.json'), JSON.stringify(run));
  await rm(join(run.runDir, 'PROMPT.md'));
  const resumed = await lab.prepare();
  assert.equal(resumed.status, 'prepared');
  assert.equal(requests, 1);
  assert.match(await readFile(join(run.runDir, 'PROMPT.md'), 'utf8'), /Daily research/);
});
test('focused discovery retains original unseen status and journals extra sources', async t => {
  const lab = await fixture(t, async () => ({ complete: true, papers: [paper], sources: [{ url: 'https://export.arxiv.org/api/query', status: 'ok', totalResults: 200, truncated: true }] }));
  const run = await lab.prepare();
  const extra = await lab.search(run.id, 'all:"agent memory"');
  assert.equal(extra.papers.length, 1);
  assert.equal(extra.papers[0].unseen, true);
  assert.equal(extra.sources.length, 2);
  await lab.finalize(run.id, { lesson: 'The bounded source scan has more matches than fetched; refine the query tomorrow.' }, true);
  assert.match(await readFile(join(lab.root, 'reports/research/LATEST.md'), 'utf8'), /available 200; result limit reached: true/);
});
test('repairing older history cannot make it the latest report', async t => {
  const lab = await fixture(t, async () => ({ complete: true, papers: [], sources: [] }));
  const run = await lab.prepare();
  const completed = await lab.finalize(run.id, { lesson: 'The latest recorded experiment remains the newest report after historical repair.' }, true);
  const old = { ...completed, id: '2020-01-01', lesson: 'An older historical result that must not replace the latest report.' };
  const oldDir = join(lab.root, '.dream/research/runs', old.id);
  await mkdir(oldDir);
  await writeFile(join(oldDir, 'run.json'), JSON.stringify(old));
  await lab.repair(old.id);
  assert.match(await readFile(join(lab.root, 'reports/research/LATEST.md'), 'utf8'), new RegExp(run.id));
  assert.equal((await lab.verifyRun(old.id)).valid, true);
});
test('completion retries restore the lesson after a concurrent memory lock interrupted finalization', async t => {
  const lab = await fixture(t, async () => ({ complete: true, papers: [], sources: [] }));
  const run = await lab.prepare();
  const held = await openMemory({ directory: join(lab.root, '.dream/research/memory'), backend: 'lexical' });
  const review = { lesson: 'Persistent memory must retain this completed lesson even if a concurrent reader interrupted the first write.' };
  try { await assert.rejects(lab.finalize(run.id, review, true), /locked/); } finally { await held.close(); }
  assert.equal((await lab.verifyRun(run.id)).valid, false);
  await lab.finalize(run.id, review, true);
  assert.equal((await lab.verifyRun(run.id)).valid, true);
});
test('every blocked cycle gets an ADR and verification enforces its content and index', async t => {
  const lab = await fixture(t, async () => ({ complete: false, papers: [], sources: [] }));
  const run = await lab.prepare();
  const adrPath = join(lab.root, 'docs/adrs/research', `ADR-${run.id}.md`);
  const indexPath = join(lab.root, 'docs/adrs/research/INDEX.md');
  assert.match(await readFile(adrPath, 'utf8'), /Draft/);
  await lab.finalize(run.id, { lesson: 'The source was blocked; record the missing observation and retry discovery tomorrow.' }, true);
  assert.match(await readFile(adrPath, 'utf8'), /Inconclusive/);
  const originalWitness = await readFile(join(run.runDir, 'witness.json'), 'utf8');
  await writeFile(adrPath, 'An unverified replacement decision.');
  assert.equal((await lab.verifyRun(run.id)).valid, false);
  await lab.repair(run.id);
  await rm(indexPath);
  assert.equal((await lab.verifyRun(run.id)).valid, false);
  await lab.repair(run.id);
  await rm(adrPath);
  assert.equal((await lab.verifyRun(run.id)).valid, false);
  await lab.repair(run.id);
  assert.equal((await lab.verifyRun(run.id)).valid, true);
  assert.equal(await readFile(join(run.runDir, 'witness.json'), 'utf8'), originalWitness);
  assert.equal((await readFile(indexPath, 'utf8')).split('\n').filter(line => line.includes(`](ADR-${run.id}.md)`)).length, 1);
});
test('ADR write failure prevents successful completion and a retry repairs it', async t => {
  const lab = await fixture(t, async () => ({ complete: true, papers: [], sources: [] }));
  const run = await lab.prepare();
  const adrPath = join(lab.root, 'docs/adrs/research', `ADR-${run.id}.md`);
  await rm(adrPath);
  await mkdir(adrPath);
  const review = { lesson: 'An interrupted ADR write must be repaired before reporting this cycle complete.' };
  await assert.rejects(lab.finalize(run.id, review, true));
  assert.notEqual((await lab.load(run.id)).materialized, true);
  await rm(adrPath, { recursive: true });
  await lab.finalize(run.id, review, true);
  assert.equal((await lab.verifyRun(run.id)).valid, true);
});

test('two scheduled cycles keep distinct evidence and lessons with calendar dates in the ledger', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-09-21T11:00:00Z') });
  let requests = 0;
  const lab = await fixture(t, async () => { requests++; return { complete: true, papers: [paper], sources: [] }; }, { dailyHours: [7, 19] });
  const morning = await lab.prepare();
  assert.equal(morning.id, '2026-09-21-0700');
  await lab.finalize(morning.id, { lesson: 'Morning fixture: retain this first observation for the next scheduled experiment.' }, true);
  const morningReport = await readFile(join(morning.runDir, 'REPORT.md'), 'utf8');
  const morningWitness = await readFile(join(morning.runDir, 'witness.json'), 'utf8');
  t.mock.timers.setTime(Date.parse('2026-09-21T22:59:00Z'));
  assert.equal((await lab.prepare()).alreadyComplete, true);
  assert.equal(requests, 1);

  t.mock.timers.setTime(Date.parse('2026-09-21T23:00:00Z'));
  const evening = await lab.prepare();
  assert.equal(evening.id, '2026-09-21-1900');
  assert.equal(evening.signals.lastRowDate, '2026-09-21');
  assert.equal(evening.signals.daysSinceLastRow, 0);
  assert.equal(evening.recentLessons[0].id, `experiment:${morning.id}`);
  assert.match(await readFile(join(evening.runDir, 'PROMPT.md'), 'utf8'), /freeze 2026-09-21-1900/);
  await lab.finalize(evening.id, { lesson: 'Evening fixture: preserve a separate observation without replacing the morning evidence.' }, true);
  const eveningReport = await readFile(join(evening.runDir, 'REPORT.md'), 'utf8');
  assert.equal((await lab.prepare()).alreadyComplete, true);
  assert.equal(requests, 2);
  assert.deepEqual((await lab.status()).runs.map(run => run.id), [morning.id, evening.id]);
  assert.deepEqual(new Set((await lab.recall('')).recentLessons.map(item => item.id)), new Set([`experiment:${morning.id}`, `experiment:${evening.id}`]));

  const ledger = await readFile(join(lab.root, 'reports/research/LEDGER.md'), 'utf8');
  assert.equal(verifyLedger(ledger).ok, true);
  assert.deepEqual(parseLedger(ledger).rows.map(row => row.date), ['2026-09-21', '2026-09-21']);
  const index = await readFile(join(lab.root, 'docs/adrs/research/INDEX.md'), 'utf8');
  for (const run of [morning, evening]) {
    assert.equal(index.split('\n').filter(line => line.includes(`](ADR-${run.id}.md)`)).length, 1);
    assert.equal((await lab.verifyRun(run.id)).valid, true);
  }
  await rm(join(morning.runDir, 'REPORT.md'));
  assert.equal((await lab.repair(morning.id)).valid, true);
  assert.equal(await readFile(join(morning.runDir, 'REPORT.md'), 'utf8'), morningReport);
  assert.equal(await readFile(join(morning.runDir, 'witness.json'), 'utf8'), morningWitness);
  assert.equal(await readFile(join(lab.root, 'reports/research/LATEST.md'), 'utf8'), eveningReport);
  assert.equal((await lab.verifyRun(evening.id)).valid, true);
});

test('legacy completion occupies only the first slot after migration and preserves its original artifacts', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-09-21T11:00:00Z') });
  let requests = 0;
  const discover = async () => { requests++; return { complete: true, papers: [], sources: [] }; };
  const legacyLab = await fixture(t, discover);
  const legacy = await legacyLab.prepare();
  assert.equal(legacy.id, '2026-09-21');
  await legacyLab.finalize(legacy.id, { lesson: 'Legacy fixture: preserve this witnessed daily observation through schedule migration.' }, true);
  const artifactPaths = [
    join(legacy.runDir, 'run.json'), join(legacy.runDir, 'REPORT.md'), join(legacy.runDir, 'witness.json'),
    join(legacyLab.root, 'reports/research', `${legacy.id}.md`),
    join(legacyLab.root, 'reports/research', `${legacy.id}.witness.json`),
    join(legacyLab.root, 'docs/adrs/research', `ADR-${legacy.id}.md`),
  ];
  const originals = await Promise.all(artifactPaths.map(path => readFile(path, 'utf8')));
  await writeFile(join(legacyLab.root, 'research.config.json'), JSON.stringify({ ...legacyLab.config, dailyHours: [7, 19] }));
  const lab = await openLab(legacyLab.root, { discover });
  const morning = await lab.prepare();
  assert.equal(morning.id, legacy.id);
  assert.equal(morning.runDir, legacy.runDir);
  assert.equal(morning.alreadyComplete, true);
  assert.equal(requests, 1);

  t.mock.timers.setTime(Date.parse('2026-09-21T23:00:00Z'));
  const evening = await lab.prepare();
  assert.equal(evening.id, '2026-09-21-1900');
  await lab.finalize(evening.id, { lesson: 'Migrated evening fixture: the second slot is a separate cycle with its own lesson.' }, true);
  assert.equal(requests, 2);
  assert.deepEqual((await lab.status()).runs.map(run => run.id), [legacy.id, evening.id]);
  assert.deepEqual(await Promise.all(artifactPaths.map(path => readFile(path, 'utf8'))), originals);
  assert.equal((await lab.verifyRun(legacy.id)).valid, true);
  assert.equal((await lab.verifyRun(evening.id)).valid, true);
});

test('an unfinished earlier slot resumes before a later slot can start', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-09-21T11:00:00Z') });
  let requests = 0;
  const lab = await fixture(t, async () => { requests++; return { complete: true, papers: [], sources: [] }; }, { dailyHours: [7, 19] });
  const morning = await lab.prepare();
  t.mock.timers.setTime(Date.parse('2026-09-21T23:00:00Z'));
  const resumed = await lab.prepare();
  assert.equal(resumed.id, morning.id);
  assert.equal(resumed.deadline, morning.deadline);
  assert.equal(resumed.resumed, true);
  assert.equal(requests, 1);
  await lab.finalize(morning.id, { lesson: 'The earlier unfinished slot exceeded its budget; retain this blocker before beginning another cycle.' }, true);
  assert.equal((await lab.prepare()).id, '2026-09-21-1900');
  assert.equal(requests, 2);
});

test('controller rejects malformed calendar and slot identifiers before reading run files', async t => {
  const lab = await fixture(t, async () => ({ complete: true, papers: [], sources: [] }), { dailyHours: [7, 19] });
  for (const id of [undefined, '../2026-09-21', '2026-02-30', '2026-09-21-2400', '2026-09-21-1960', '2026-09-21-7', '2026-09-21-0700/../other']) {
    assert.throws(() => lab.load(id), /run.?id|YYYY-MM-DD/i);
  }
  await assert.rejects(fixture(t, async () => ({ complete: true, papers: [], sources: [] }), { dailyHours: [7, 7] }), /dailyHours/);
});
