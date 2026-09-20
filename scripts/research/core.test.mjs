import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { openLab, localDate, rankPapers, researchMode, validateProposal } from './core.mjs';
import { openMemory } from './memory.mjs';

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

async function fixture(t, discover) {
  const root = await mkdtemp(join(tmpdir(), 'dream-research-controller-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = { version: 1, publication: 'local-only', promotion: 'human-review', maxMinutes: 60, maxPendingCandidates: 3, timezone: 'America/Toronto', surfaces: ['memory retrieval'], discovery: { lookbackDays: 7, maxResults: 10 }, memory: { backend: 'lexical' } };
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
