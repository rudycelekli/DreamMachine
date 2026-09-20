import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { freezeExperiment, evaluateExperiment, verifyExperiment } from './experiment.mjs';

const oracle = `import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const { value } = await import(pathToFileURL(resolve(process.env.DREAM_TARGET_ROOT, 'packages/feature/value.mjs')));
test('the newly reported result is correct', () => assert.equal(value(), 2));
`;

async function fixture(t, options = {}) {
  const parent = await mkdtemp(resolve(tmpdir(), 'dream-research-experiment-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = resolve(parent, 'repository');
  const runDir = resolve(parent, 'run');
  await mkdir(resolve(root, 'packages/feature'), { recursive: true });
  await writeFile(resolve(root, 'packages/feature/value.mjs'), `export const value = () => ${options.baseline ?? 1};\n`);
  await writeFile(resolve(root, 'packages/feature/value.test.mjs'), '// Existing regression test is protected.\n');
  await writeFile(resolve(root, 'check.mjs'), options.check ?? `import assert from 'node:assert/strict'; import { value } from './packages/feature/value.mjs'; assert.ok(value() > 0);\n`);
  await writeFile(resolve(root, '.gitignore'), 'node_modules/\n');
  if (options.workspace) {
    await writeFile(resolve(root, 'package.json'), JSON.stringify({ name: 'workspace-fixture', private: true, type: 'module', workspaces: ['packages/*'] }));
    await writeFile(resolve(root, 'packages/feature/package.json'), JSON.stringify({ name: '@fixture/feature', type: 'module', exports: './value.mjs' }));
    await mkdir(resolve(root, 'node_modules/@fixture'), { recursive: true });
    await symlink(resolve(root, 'packages/feature'), resolve(root, 'node_modules/@fixture/feature'));
    await mkdir(resolve(root, 'node_modules/trusted-external'), { recursive: true });
    await writeFile(resolve(root, 'node_modules/trusted-external/index.mjs'), 'export const trusted = true;\n');
  }
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  git('init');
  git('config', 'user.email', 'fixture@example.invalid');
  git('config', 'user.name', 'Experiment Fixture');
  git('add', '.');
  git('-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'fixture baseline');
  const testFile = resolve(parent, 'new.test.mjs');
  await writeFile(testFile, oracle);
  const config = { evaluation: { command: [process.execPath, 'check.mjs'], timeoutSeconds: options.timeoutSeconds ?? 5 }, allowedPaths: ['packages/feature/'], maxChangedLines: options.maxChangedLines ?? 20 };
  const proposal = { kind: 'paper', hypothesis: 'The new method corrects this newly frozen case.', paperIds: ['paper:fixture'], changeSummary: 'Correct the result.', expectedOutcome: 'The result is 2.', validation: { testFile } };
  const args = { root, runDir, runId: 'fixture', proposal, config };
  return { ...args, git, parent, freeze: () => freezeExperiment(args) };
}

async function candidate(experiment, value) { await writeFile(resolve(experiment.candidateDir, 'packages/feature/value.mjs'), `export const value = () => ${value};\n`); }

test('freezes exact HEAD, proves red-to-green behavior and preserves verifiable evidence', async (t) => {
  const f = await fixture(t);
  const originalHead = f.git('rev-parse', 'HEAD').toString().trim();
  const experiment = await f.freeze();
  assert.equal(experiment.baseCommit, originalHead);
  assert.equal(experiment.branch, 'research/fixture');
  assert.equal(await readFile(experiment.oraclePath, 'utf8'), oracle);
  await candidate(experiment, 2);
  const evaluation = await evaluateExperiment({ ...f, experiment });
  assert.equal(evaluation.status, 'improved', evaluation.errors.join('\n'));
  assert.equal(evaluation.checks.baselineOracle.exitCode, 1);
  assert.equal(evaluation.checks.candidateOracle.exitCode, 0);
  assert.equal(evaluation.checks.baselineRegression.passed, true);
  assert.equal(evaluation.checks.candidateRegression.passed, true);
  assert.match(await readFile(evaluation.patchPath, 'utf8'), /\+export const value = \(\) => 2;/);
  assert.deepEqual(await verifyExperiment({ ...f, experiment, evaluation }), { valid: true, errors: [] });
  assert.equal(f.git('rev-parse', 'HEAD').toString().trim(), originalHead);
  assert.equal(await readFile(resolve(f.root, 'packages/feature/value.mjs'), 'utf8'), 'export const value = () => 1;\n');
  await assert.rejects(evaluateExperiment({ ...f, experiment }), /already has an evaluation/);
});

test('a candidate that still fails the frozen oracle is rejected', async (t) => {
  const f = await fixture(t);
  const experiment = await f.freeze();
  await candidate(experiment, 3);
  const evaluation = await evaluateExperiment({ ...f, experiment });
  assert.equal(evaluation.improved, false);
  assert.match(evaluation.errors.join('\n'), /does not pass the frozen oracle/);
});

test('a baseline that already passes the oracle cannot count as an improvement', async (t) => {
  const f = await fixture(t, { baseline: 2 });
  const experiment = await f.freeze();
  await writeFile(resolve(experiment.candidateDir, 'packages/feature/value.mjs'), 'export const value = () => 1 + 1;\n');
  const evaluation = await evaluateExperiment({ ...f, experiment });
  assert.equal(evaluation.improved, false);
  assert.match(evaluation.errors.join('\n'), /must fail on the baseline/);
});

test('existing failing baseline checks prevent the improvement claim', async (t) => {
  const f = await fixture(t, { check: 'process.exitCode = 1;\n' });
  const experiment = await f.freeze();
  await candidate(experiment, 2);
  const evaluation = await evaluateExperiment({ ...f, experiment });
  assert.equal(evaluation.improved, false);
  assert.equal(evaluation.status, 'inconclusive');
  assert.match(evaluation.errors.join('\n'), /baseline regressions do not pass/);
});

test('frozen oracle changes are rejected before checks execute', async (t) => {
  const f = await fixture(t);
  const experiment = await f.freeze();
  await candidate(experiment, 2);
  await chmod(experiment.oraclePath, 0o644);
  await writeFile(experiment.oraclePath, `${oracle}\n// changed after freezing\n`);
  const evaluation = await evaluateExperiment({ ...f, experiment });
  assert.equal(evaluation.improved, false);
  assert.match(evaluation.errors.join('\n'), /Frozen oracle changed/);
  assert.deepEqual(evaluation.checks, {});
});

test('candidate, oracle, patch and raw-log mutations invalidate stored evidence', async (t) => {
  const f = await fixture(t);
  const experiment = await f.freeze();
  await candidate(experiment, 2);
  const evaluation = await evaluateExperiment({ ...f, experiment });
  assert.equal(evaluation.improved, true);
  await candidate(experiment, 3);
  let verified = await verifyExperiment({ ...f, experiment, evaluation });
  assert.equal(verified.valid, false);
  assert.match(verified.errors.join('\n'), /Candidate changed after evaluation/);
  await candidate(experiment, 2);
  await writeFile(evaluation.checks.candidateOracle.stdoutPath, 'fabricated passing output\n');
  await writeFile(evaluation.patchPath, 'changed patch\n');
  await chmod(experiment.oraclePath, 0o644);
  await writeFile(experiment.oraclePath, `${oracle}\n// tamper\n`);
  verified = await verifyExperiment({ ...f, experiment, evaluation });
  assert.equal(verified.valid, false);
  assert.match(verified.errors.join('\n'), /Frozen oracle changed/);
  assert.match(verified.errors.join('\n'), /Saved candidate patch changed/);
  assert.match(verified.errors.join('\n'), /Raw logs changed/);
});

test('policy changes, protected tests and files outside allowedPaths cannot execute', async (t) => {
  const f = await fixture(t);
  const experiment = await f.freeze();
  await candidate(experiment, 2);
  await writeFile(resolve(experiment.candidateDir, 'packages/feature/value.test.mjs'), '// weakened test\n');
  await writeFile(resolve(experiment.candidateDir, 'unapproved.mjs'), 'export const bypass = true;\n');
  const config = { ...f.config, evaluation: { ...f.config.evaluation, command: [process.execPath, '-e', 'process.exit(0)'] } };
  const evaluation = await evaluateExperiment({ ...f, experiment, config });
  assert.equal(evaluation.improved, false);
  assert.deepEqual(evaluation.checks, {});
  assert.match(evaluation.errors.join('\n'), /configuration differs/);
  assert.match(evaluation.errors.join('\n'), /Protected path changed: packages\/feature\/value.test.mjs/);
  assert.match(evaluation.errors.join('\n'), /outside allowedPaths: unapproved.mjs/);
  assert.deepEqual(await verifyExperiment({ ...f, experiment, evaluation }), { valid: true, errors: [] });
});

test('new source files are included in the patch and changed-line limit', async (t) => {
  const f = await fixture(t, { maxChangedLines: 2 });
  const experiment = await f.freeze();
  await candidate(experiment, 2);
  await writeFile(resolve(experiment.candidateDir, 'packages/feature/new.mjs'), 'export const newFeature = true;\n');
  const evaluation = await evaluateExperiment({ ...f, experiment });
  assert.equal(evaluation.improved, false);
  assert.equal(evaluation.changedLines, 3);
  assert.match(evaluation.errors.join('\n'), /exceeding maxChangedLines=2/);
  assert.match(await readFile(evaluation.patchPath, 'utf8'), /packages\/feature\/new.mjs/);
});

test('dirty tracked source and reuse of an existing test are refused at freeze time', async (t) => {
  const f = await fixture(t);
  await writeFile(resolve(f.root, 'packages/feature/value.mjs'), 'export const value = () => 99;\n');
  await assert.rejects(f.freeze(), /tracked workspace changes/);
  f.git('checkout', '--', 'packages/feature/value.mjs');
  f.proposal.validation.testFile = 'packages/feature/value.test.mjs';
  await assert.rejects(f.freeze(), /must be a NEW file/);
});

test('timed-out regression processes are killed and cannot create passing evidence', async (t) => {
  const f = await fixture(t, { timeoutSeconds: 0.25, check: "import { spawn } from 'node:child_process'; const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' }); console.log(child.pid); setInterval(() => {}, 1000);\n" });
  const experiment = await f.freeze();
  await candidate(experiment, 2);
  const evaluation = await evaluateExperiment({ ...f, experiment });
  assert.equal(evaluation.improved, false);
  assert.equal(evaluation.status, 'inconclusive');
  assert.equal(evaluation.checks.baselineRegression.timedOut, true);
  assert.equal(evaluation.checks.candidateRegression.timedOut, true);
  assert.equal(evaluation.checks.candidateRegression.signal, 'SIGKILL');
  assert.ok(evaluation.checks.candidateRegression.durationMs < 3000);
  // Grandchildren inherit the detached process group and receive the same kill.
  const childPid = Number((await readFile(evaluation.checks.candidateRegression.stdoutPath, 'utf8')).trim());
  assert.ok(childPid > 0);
  try {
    process.kill(childPid, 0);
    // A reaped-on-next-tick zombie can briefly remain visible on Unix; it must
    // not be a live Node process retaining the log pipes (runCheck already closed).
    const state = execFileSync('ps', ['-o', 'stat=', '-p', String(childPid)], { encoding: 'utf8' }).trim();
    assert.match(state, /^Z/);
  } catch (error) {
    if (error.code !== 'ESRCH' && error.status !== 1) throw error;
  }
});

test('the overall frozen deadline prevents launching additional checks', async (t) => {
  const f = await fixture(t);
  // A very short total budget expires during worktree setup, independently of
  // the longer per-process timeout. No sleeps or additional process are needed.
  f.config.maxMinutes = 0.001;
  const experiment = await f.freeze();
  await candidate(experiment, 2);
  const evaluation = await evaluateExperiment({ ...f, experiment });
  assert.equal(evaluation.status, 'inconclusive');
  assert.match(evaluation.errors.join('\n'), /deadline reached/);
  assert.equal(evaluation.checks.baselineRegression, null);
  assert.equal(evaluation.checks.candidateOracle, null);
  assert.deepEqual(await verifyExperiment({ ...f, experiment, evaluation }), { valid: true, errors: [] });
});

test('workspace aliases resolve isolated code while external dependencies remain trusted links', async (t) => {
  const f = await fixture(t, {
    workspace: true,
    check: "import assert from 'node:assert/strict'; import { value } from '@fixture/feature'; assert.ok(value() > 0);\n",
  });
  await writeFile(f.proposal.validation.testFile, `import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const require = createRequire(resolve(process.env.DREAM_TARGET_ROOT, 'package.json'));
const { value } = await import(pathToFileURL(require.resolve('@fixture/feature')));
test('the workspace alias exposes the corrected result', () => assert.equal(value(), 2));
`);
  const experiment = await f.freeze();
  await candidate(experiment, 2);
  const evaluation = await evaluateExperiment({ ...f, experiment });
  assert.equal(evaluation.improved, true, evaluation.errors.join('\n'));
  assert.equal(await realpath(resolve(experiment.candidateDir, 'node_modules/@fixture/feature')), resolve(experiment.candidateDir, 'packages/feature'));
  assert.equal(await realpath(resolve(experiment.baselineDir, 'node_modules/@fixture/feature')), resolve(experiment.baselineDir, 'packages/feature'));
  assert.equal(await realpath(resolve(experiment.candidateDir, 'node_modules/trusted-external')), await realpath(resolve(f.root, 'node_modules/trusted-external')));
  assert.equal(await readFile(resolve(f.root, 'packages/feature/value.mjs'), 'utf8'), 'export const value = () => 1;\n');
});
