import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, readFile, readdir, realpath, symlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { finished } from 'node:stream/promises';

const SCHEMA_VERSION = 1;
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const within = (parent, child) => child === parent || (!relative(parent, child).startsWith(`..${sep}`) && relative(parent, child) !== '..' && !isAbsolute(relative(parent, child)));
const protectedPath = (path) => /(?:^|\/)(?:\.git|\.github|scripts|tests?|specs?|__tests__|__snapshots__)(?:\/|$)/i.test(path)
  || /(?:^|\/)(?:AGENTS\.md|SECURITY\.md|CODEOWNERS|package(?:-lock)?\.json|npm-shrinkwrap\.json|(?:yarn|bun)\.lockb?|pnpm-lock\.yaml|Cargo\.(?:toml|lock)|go\.(?:mod|sum)|pyproject\.toml|uv\.lock|requirements[^/]*\.txt|\.npmrc|\.yarnrc[^/]*|\.gitmodules)$/i.test(path)
  || /(?:^|\/)[^/]*(?:test|spec|\.config\.|threshold|evaluator|benchmark|gate|controller|policy|promotion|consent|watchdog|holdout)[^/]*(?:\/|$)/i.test(path)
  || /(?:^|\/)(?:tsconfig[^/]*|[^/]*config\.(?:json|ya?ml|toml))$/i.test(path);

function cleanRelative(path) {
  return typeof path === 'string' && path.length > 0 && !path.startsWith('-') && !path.includes('\\')
    && !isAbsolute(path) && !/[\x00-\x1f\x7f]/.test(path)
    && path.replace(/\/$/, '').split('/').every((part) => part && part !== '.' && part !== '..');
}

function policyFrom(config) {
  const command = config?.evaluation?.command ?? ['npm', 'run', 'check'];
  const timeoutSeconds = config?.evaluation?.timeoutSeconds ?? 600;
  const allowedPaths = config?.allowedPaths ?? ['packages/'];
  const maxChangedLines = config?.maxChangedLines ?? 300;
  if (!Array.isArray(command) || command.length === 0 || command.some((part) => typeof part !== 'string' || !part || part.includes('\0'))) throw new Error('evaluation.command must be a nonempty argv array. Shell strings are not supported.');
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0 || timeoutSeconds > 3600) throw new Error('evaluation.timeoutSeconds must be between 0 and 3600.');
  if (!Array.isArray(allowedPaths) || allowedPaths.length === 0 || allowedPaths.some((path) => !cleanRelative(path))) throw new Error('allowedPaths must contain repository-relative paths.');
  if (!Number.isSafeInteger(maxChangedLines) || maxChangedLines <= 0) throw new Error('maxChangedLines must be a positive integer.');
  return { command: [...command], timeoutSeconds, allowedPaths: [...allowedPaths], maxChangedLines };
}

async function git(cwd, args, acceptedCodes = [0]) {
  return new Promise((fulfill, reject) => {
    const child = spawn('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args], { cwd, shell: false, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    const stdout = [];
    const stderr = [];
    const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      const result = { code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr).toString() };
      if (!acceptedCodes.includes(code)) reject(new Error(`git ${args[0]} failed: ${result.stderr.trim() || `exit ${code}`}`));
      else fulfill(result);
    });
  });
}

async function gitText(cwd, args) { return (await git(cwd, args)).stdout.toString().trim(); }
async function digestFile(path) { return sha256(await readFile(path)); }
async function exists(path) { try { await lstat(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
async function saveJson(path, value) { await writeFile(path, json(value)); }

async function runCheck({ name, cwd, command, timeoutSeconds, receiptsDir }) {
  await mkdir(receiptsDir, { recursive: true });
  const stdoutPath = resolve(receiptsDir, `${name}.stdout.log`);
  const stderrPath = resolve(receiptsDir, `${name}.stderr.log`);
  const receiptPath = resolve(receiptsDir, `${name}.json`);
  if (await exists(stdoutPath) || await exists(stderrPath) || await exists(receiptPath)) throw new Error(`Partial evidence already exists for ${name}; preserve this run and start a new experiment.`);
  const stdout = createWriteStream(stdoutPath, { flags: 'wx' });
  const stderr = createWriteStream(stderrPath, { flags: 'wx' });
  const startedAt = new Date().toISOString();
  const started = Date.now();
  let timedOut = false;
  let spawnError = null;
  const env = { ...process.env, DREAM_TARGET_ROOT: cwd, CI: 'true', FORCE_COLOR: '0' };
  // Node's test runner exports this private variable to its own workers. Keeping
  // it in a nested `node --test` can silently disable running the frozen oracle.
  delete env.NODE_TEST_CONTEXT;
  const outcome = await new Promise((fulfill) => {
    const child = spawn(command[0], command.slice(1), {
      cwd, shell: false, detached: process.platform !== 'win32',
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.pipe(stdout);
    child.stderr.pipe(stderr);
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.platform === 'win32' ? child.kill('SIGKILL') : process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') spawnError = error.message; }
    }, timeoutSeconds * 1000);
    child.on('error', (error) => { spawnError = error.message; });
    child.on('close', (exitCode, signal) => { clearTimeout(timer); fulfill({ exitCode, signal }); });
  });
  await Promise.all([finished(stdout), finished(stderr)]);
  const receipt = {
    schemaVersion: SCHEMA_VERSION, name, command, cwd, startedAt,
    finishedAt: new Date().toISOString(), durationMs: Date.now() - started,
    ...outcome, timedOut, spawnError,
    passed: outcome.exitCode === 0 && !timedOut && !spawnError,
    stdoutPath, stdoutSha256: await digestFile(stdoutPath),
    stderrPath, stderrSha256: await digestFile(stderrPath), receiptPath,
  };
  await saveJson(receiptPath, receipt);
  return { ...receipt, receiptSha256: await digestFile(receiptPath) };
}

async function workspaceAliases(root) {
  const aliases = new Map();
  if (!await exists(resolve(root, 'package.json'))) return aliases;
  const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
  const patterns = Array.isArray(manifest.workspaces) ? manifest.workspaces : manifest.workspaces?.packages ?? [];
  // Resolve the common npm workspace path glob forms without invoking npm or
  // installing anything. Also remap actual internal dependency links below.
  const expand = async (directory, parts) => {
    if (!parts.length) return [directory];
    const [part, ...rest] = parts;
    if (part === '**') {
      const paths = await expand(directory, rest);
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') paths.push(...await expand(resolve(directory, entry.name), parts));
      }
      return paths;
    }
    if (!part.includes('*') && !part.includes('?')) {
      const next = resolve(directory, part);
      return await exists(next) ? expand(next, rest) : [];
    }
    const pattern = new RegExp(`^${part.replace(/[.+^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*').replaceAll('?', '.')}$`);
    const paths = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) if (entry.isDirectory() && pattern.test(entry.name)) paths.push(...await expand(resolve(directory, entry.name), rest));
    return paths;
  };
  for (const pattern of patterns) {
    if (!cleanRelative(pattern) || /[!{}[\]]/.test(pattern)) throw new Error(`Unsupported workspace path pattern: ${pattern}`);
    for (const directory of await expand(root, pattern.replace(/\/$/, '').split('/'))) {
      if (!await exists(resolve(directory, 'package.json'))) continue;
      const workspace = JSON.parse(await readFile(resolve(directory, 'package.json'), 'utf8'));
      if (typeof workspace.name !== 'string' || !/^(?:@[A-Za-z0-9_.-]+\/)?[A-Za-z0-9_.-]+$/.test(workspace.name)) throw new Error(`Invalid workspace package name in ${directory}`);
      aliases.set(workspace.name, relative(root, directory));
    }
  }
  return aliases;
}

async function linkTrustedDependencies(root, target) {
  const sourceModules = resolve(root, 'node_modules');
  if (!await exists(sourceModules)) return;
  const targetModules = resolve(target, 'node_modules');
  const aliases = await workspaceAliases(root);
  await mkdir(targetModules);
  const link = async (name) => {
    const source = resolve(sourceModules, name);
    let destination = source;
    if (aliases.has(name)) destination = resolve(target, aliases.get(name));
    else if ((await lstat(source)).isSymbolicLink()) {
      const original = await realpath(source);
      // Cover local npm links as well as declared workspaces. External links
      // remain trusted dependencies and are never copied or reinstalled.
      if (within(root, original) && !within(sourceModules, original)) destination = resolve(target, relative(root, original));
    }
    if (!await exists(destination)) throw new Error(`Dependency ${name} has no corresponding frozen workspace path.`);
    await symlink(destination, resolve(targetModules, name));
  };
  for (const entry of await readdir(sourceModules, { withFileTypes: true })) {
    if (entry.name.startsWith('@')) {
      await mkdir(resolve(targetModules, entry.name));
      for (const scoped of await readdir(resolve(sourceModules, entry.name))) await link(`${entry.name}/${scoped}`);
    } else await link(entry.name);
  }
  // npm can omit a workspace alias if dependencies were installed with a
  // workspace filter. Link every declared workspace consistently in both trees.
  for (const [name, path] of aliases) {
    if (!await exists(resolve(targetModules, name))) {
      await mkdir(dirname(resolve(targetModules, name)), { recursive: true });
      await symlink(resolve(target, path), resolve(targetModules, name));
    }
  }
}

/** Freeze a new node:test oracle BEFORE changing the candidate. Its imports must
 * resolve target code through process.env.DREAM_TARGET_ROOT, never relative to
 * the oracle itself. Worktrees and evidence are deliberately retained for review.
 */
export async function freezeExperiment({ root, runDir, runId, proposal, config, deadline }) {
  root = await realpath(root);
  runDir = resolve(runDir);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(runId ?? '')) throw new Error('runId must be a short branch-safe identifier.');
  if (!proposal || !['paper', 'wild-idea'].includes(proposal.kind) || typeof proposal.hypothesis !== 'string' || !proposal.hypothesis.trim()) throw new Error('A paper or wild-idea proposal with a hypothesis is required.');
  if (!Array.isArray(proposal.paperIds) || proposal.paperIds.some((id) => typeof id !== 'string')) throw new Error('proposal.paperIds must be an array of source identifiers.');
  const policy = policyFrom(config);
  const frozenAt = new Date().toISOString();
  const budgetMinutes = config?.maxMinutes ?? 60;
  if (!Number.isFinite(budgetMinutes) || budgetMinutes <= 0 || budgetMinutes > 180) throw new Error('maxMinutes must be between 0 and 180.');
  const deadlineMs = Math.min(Date.parse(frozenAt) + budgetMinutes * 60_000, deadline === undefined ? Infinity : Date.parse(deadline));
  if (!Number.isFinite(deadlineMs) || deadlineMs <= Date.now()) throw new Error('The experiment deadline must be a valid future time.');
  if (await exists(resolve(runDir, 'experiment.json'))) throw new Error('This run already has a frozen experiment; use a new run.');
  const dirty = await gitText(root, ['diff', '--name-only', 'HEAD', '--']);
  if (dirty) throw new Error(`Commit or restore tracked workspace changes before freezing an experiment:\n${dirty}`);
  if (await gitText(root, ['ls-files', '--unmerged'])) throw new Error('Resolve Git conflicts before freezing an experiment.');
  const testFile = proposal.validation?.testFile;
  if (typeof testFile !== 'string' || !testFile.endsWith('.test.mjs')) throw new Error('proposal.validation.testFile must name a new .test.mjs oracle.');
  const sourcePath = resolve(root, testFile);
  if (!(await lstat(sourcePath)).isFile()) throw new Error('The proposed oracle must be a regular file, not a symlink.');
  if (within(root, sourcePath) && await gitText(root, ['ls-files', '--', relative(root, sourcePath)])) throw new Error('The oracle must be a NEW file; existing repository tests are protected.');
  const source = await readFile(sourcePath);
  if (!source.toString().includes('node:test') || !source.toString().includes('DREAM_TARGET_ROOT')) throw new Error('The oracle must use node:test and import candidate code via process.env.DREAM_TARGET_ROOT.');
  const baseCommit = await gitText(root, ['rev-parse', 'HEAD']);
  const branch = `research/${runId}`;
  await mkdir(runDir, { recursive: true });
  runDir = await realpath(runDir);
  const baselineDir = resolve(runDir, 'worktrees', 'baseline');
  const candidateDir = resolve(runDir, 'worktrees', 'candidate');
  const oraclePath = resolve(runDir, 'oracle', 'regression.test.mjs');
  if (sourcePath === oraclePath) throw new Error('Supply a new oracle outside the reserved frozen oracle path.');
  await mkdir(dirname(oraclePath), { recursive: true });
  await mkdir(dirname(baselineDir), { recursive: true });
  await copyFile(sourcePath, oraclePath);
  await chmod(oraclePath, 0o444);
  await git(root, ['worktree', 'add', '--detach', baselineDir, baseCommit]);
  try { await git(root, ['worktree', 'add', '-b', branch, candidateDir, baseCommit]); }
  catch (error) { await git(root, ['worktree', 'remove', baselineDir]); throw error; }
  await linkTrustedDependencies(root, baselineDir);
  await linkTrustedDependencies(root, candidateDir);
  const experiment = {
    schemaVersion: SCHEMA_VERSION, runId, frozenAt, deadline: new Date(deadlineMs).toISOString(), root, runDir,
    baseCommit, branch, baselineDir, candidateDir, oraclePath,
    oracleSha256: sha256(source), proposal: structuredClone(proposal), policy,
    policySha256: sha256(json(policy)), receiptsDir: resolve(runDir, 'receipts'),
    dependencyMode: 'trusted-external-dependencies-with-worktree-local-workspace-aliases',
  };
  await saveJson(resolve(runDir, 'experiment.json'), experiment);
  return experiment;
}

async function snapshot(experiment) {
  const cwd = experiment.candidateDir;
  const base = experiment.baseCommit;
  const head = await gitText(cwd, ['rev-parse', 'HEAD']);
  const tracked = (await git(cwd, ['diff', '--name-only', '--no-renames', '-z', base, '--'])).stdout.toString().split('\0').filter(Boolean);
  const untracked = (await git(cwd, ['ls-files', '--others', '--exclude-standard', '-z'])).stdout.toString().split('\0').filter(Boolean);
  const paths = [...new Set([...tracked, ...untracked])].sort();
  const errors = [];
  let changedLines = 0;
  if (head !== base) errors.push('Candidate HEAD changed; keep changes uncommitted on the frozen base.');
  if (!paths.length) errors.push('Candidate has no source changes.');
  const patches = [(await git(cwd, ['diff', '--binary', '--no-ext-diff', '--no-textconv', '--no-renames', base, '--'])).stdout];
  const numstat = (await git(cwd, ['diff', '--numstat', '--no-renames', base, '--'])).stdout.toString();
  for (const line of numstat.split('\n').filter(Boolean)) {
    const [added, removed] = line.split('\t');
    if (added === '-' || removed === '-') errors.push('Binary changes are not eligible for automatic experimentation.');
    else changedLines += Number(added) + Number(removed);
  }
  for (const path of paths) {
    if (!cleanRelative(path) || protectedPath(path)) errors.push(`Protected path changed: ${path}`);
    if (!experiment.policy.allowedPaths.some((prefix) => path === prefix.replace(/\/$/, '') || path.startsWith(`${prefix.replace(/\/$/, '')}/`))) errors.push(`Path is outside allowedPaths: ${path}`);
    const absolute = resolve(cwd, path);
    if (!within(cwd, absolute)) { errors.push(`Path escapes candidate: ${path}`); continue; }
    if (await exists(absolute)) {
      if (!(await lstat(absolute)).isFile() || !within(cwd, await realpath(absolute))) { errors.push(`Changed path must be a regular file inside the candidate: ${path}`); continue; }
      if (untracked.includes(path)) {
        const content = await readFile(absolute);
        if (content.includes(0)) errors.push(`Binary file added: ${path}`);
        changedLines += content.length ? content.toString().split('\n').length - (content.at(-1) === 10 ? 1 : 0) : 0;
        patches.push((await git(cwd, ['diff', '--no-index', '--binary', '--no-ext-diff', '--no-textconv', '--', '/dev/null', path], [0, 1])).stdout);
      }
    }
  }
  if (changedLines > experiment.policy.maxChangedLines) errors.push(`Change has ${changedLines} lines, exceeding maxChangedLines=${experiment.policy.maxChangedLines}.`);
  const patch = Buffer.concat(patches);
  return { head, paths, changedLines, errors, patch, sha256: sha256(patch) };
}

async function frozenErrors({ root, runDir, experiment }) {
  const errors = [];
  try {
    const saved = JSON.parse(await readFile(resolve(runDir, 'experiment.json'), 'utf8'));
    if (json(saved) !== json(experiment)) errors.push('Frozen experiment metadata changed.');
    if (sha256(json(experiment.policy)) !== experiment.policySha256) errors.push('Frozen evaluation policy changed.');
    if (await realpath(root) !== experiment.root || await realpath(runDir) !== experiment.runDir) errors.push('Experiment root or run directory does not match the frozen metadata.');
    if (await digestFile(experiment.oraclePath) !== experiment.oracleSha256) errors.push('Frozen oracle changed.');
    if (await gitText(experiment.baselineDir, ['rev-parse', 'HEAD']) !== experiment.baseCommit) errors.push('Baseline HEAD changed.');
    if (await gitText(experiment.baselineDir, ['status', '--porcelain', '--untracked-files=normal'])) errors.push('Baseline worktree changed.');
  } catch (error) { errors.push(`Unable to verify frozen inputs: ${error.message}`); }
  return errors;
}

/** Execute only the frozen trusted argv plus node --test on the frozen oracle.
 * A failed baseline oracle followed by a passing candidate oracle establishes
 * one reproducible correctness improvement, not a general performance claim.
 */
export async function evaluateExperiment({ root, runDir, experiment, config }) {
  if (await exists(resolve(runDir, 'evaluation.json'))) throw new Error('This experiment already has an evaluation; start a new run for new evidence.');
  const errors = await frozenErrors({ root, runDir, experiment });
  if (json(policyFrom(config)) !== json(experiment.policy)) errors.push('Evaluation configuration differs from the frozen policy.');
  const before = await snapshot(experiment);
  errors.push(...before.errors);
  const patchPath = resolve(runDir, 'candidate.patch');
  await writeFile(patchPath, before.patch);
  const checks = {};
  let inconclusive = false;
  if (!errors.length) {
    const run = async (name, cwd, command) => {
      const remainingSeconds = (Date.parse(experiment.deadline) - Date.now()) / 1000;
      if (remainingSeconds <= 0) {
        inconclusive = true;
        errors.push('Experiment deadline reached before all checks completed.');
        return null;
      }
      const result = await runCheck({ name, cwd, command, timeoutSeconds: Math.min(experiment.policy.timeoutSeconds, remainingSeconds), receiptsDir: experiment.receiptsDir });
      if (result.timedOut || result.spawnError || result.signal || result.exitCode === null) inconclusive = true;
      return result;
    };
    // Sequential runs avoid baseline/candidate contention and shared dependency
    // cache races; each raw result remains independently inspectable.
    checks.baselineRegression = await run('baseline-regression', experiment.baselineDir, experiment.policy.command);
    checks.baselineOracle = await run('baseline-oracle', experiment.baselineDir, [process.execPath, '--test', experiment.oraclePath]);
    checks.candidateRegression = await run('candidate-regression', experiment.candidateDir, experiment.policy.command);
    checks.candidateOracle = await run('candidate-oracle', experiment.candidateDir, [process.execPath, '--test', experiment.oraclePath]);
    if (!checks.baselineRegression?.passed) { errors.push('Existing baseline regressions do not pass.'); inconclusive = true; }
    const baselineOracle = checks.baselineOracle;
    if (!baselineOracle || baselineOracle.exitCode === 0 || baselineOracle.timedOut || baselineOracle.spawnError || baselineOracle.signal || baselineOracle.exitCode === null) errors.push('Oracle must fail on the baseline without timing out or a process error.');
    if (!checks.candidateRegression?.passed) errors.push('Candidate regressions do not pass.');
    if (!checks.candidateOracle?.passed) errors.push('Candidate does not pass the frozen oracle.');
  }
  errors.push(...await frozenErrors({ root, runDir, experiment }));
  const after = await snapshot(experiment);
  if (before.sha256 !== after.sha256) errors.push('Candidate changed while evaluation was running.');
  errors.push(...after.errors);
  const evaluation = {
    schemaVersion: SCHEMA_VERSION, runId: experiment.runId, evaluatedAt: new Date().toISOString(),
    status: errors.length ? (inconclusive ? 'inconclusive' : 'rejected') : 'improved', improved: errors.length === 0,
    claim: errors.length ? null : 'One frozen regression fails on the clean baseline and passes on the candidate; existing checks pass on both.',
    baseCommit: experiment.baseCommit, candidateHead: before.head, candidateDiffSha256: before.sha256,
    oracleSha256: experiment.oracleSha256, policySha256: experiment.policySha256,
    paths: before.paths, changedLines: before.changedLines, patchPath, checks,
    receipts: Object.values(checks).filter(Boolean).map(({ receiptPath, receiptSha256 }) => ({ path: receiptPath, sha256: receiptSha256 })),
    errors: [...new Set(errors)],
    limitations: ['Local worktrees isolate Git changes, not malicious code.', 'External dependencies are linked to the trusted root; declared workspace aliases resolve within each isolated worktree.', 'This is regression evidence for the frozen case, not a claim of scientific novelty or universal improvement.'],
  };
  await saveJson(resolve(runDir, 'evaluation.json'), evaluation);
  return evaluation;
}

/** Recheck exact candidate, oracle, patch, logs and receipts before reporting or
 * accepting an improvement. This module never commits, merges, pushes or deploys.
 */
export async function verifyExperiment({ root, runDir, experiment, evaluation }) {
  const errors = await frozenErrors({ root, runDir, experiment });
  try {
    const saved = JSON.parse(await readFile(resolve(runDir, 'evaluation.json'), 'utf8'));
    if (json(saved) !== json(evaluation)) errors.push('Evaluation metadata changed.');
    if (evaluation.runId !== experiment.runId || evaluation.baseCommit !== experiment.baseCommit || evaluation.oracleSha256 !== experiment.oracleSha256 || evaluation.policySha256 !== experiment.policySha256) errors.push('Evaluation does not match frozen experiment.');
    const candidate = await snapshot(experiment);
    // A policy-rejected candidate can still have authentic evidence and a useful
    // durable lesson. Reapply eligibility only to a claimed improvement.
    if (evaluation.improved) errors.push(...candidate.errors);
    if (candidate.head !== evaluation.candidateHead) errors.push('Candidate HEAD changed after evaluation.');
    if (candidate.sha256 !== evaluation.candidateDiffSha256) errors.push('Candidate changed after evaluation.');
    if (await digestFile(evaluation.patchPath) !== evaluation.candidateDiffSha256) errors.push('Saved candidate patch changed.');
    for (const receipt of Object.values(evaluation.checks ?? {}).filter(Boolean)) {
      if (await digestFile(receipt.receiptPath) !== receipt.receiptSha256) errors.push(`Receipt changed: ${receipt.name}`);
      if (await digestFile(receipt.stdoutPath) !== receipt.stdoutSha256 || await digestFile(receipt.stderrPath) !== receipt.stderrSha256) errors.push(`Raw logs changed: ${receipt.name}`);
    }
    if (evaluation.improved) {
      const { baselineRegression: baseline, baselineOracle: red, candidateRegression: candidate, candidateOracle: green } = evaluation.checks;
      if (!baseline?.passed || !candidate?.passed || !green?.passed || red?.exitCode === 0 || red?.exitCode == null || red?.timedOut || red?.spawnError || red?.signal) errors.push('Improvement lacks the required baseline/candidate evidence.');
    }
  } catch (error) { errors.push(`Unable to verify evaluation: ${error.message}`); }
  return { valid: errors.length === 0, errors: [...new Set(errors)] };
}
