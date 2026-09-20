import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { EMBEDDING, embedLexically, openMemory } from './memory.mjs';

const run = promisify(execFile);
const moduleUrl = new URL('./memory.mjs', import.meta.url).href;
const paper = { id: 'paper:1', kind: 'paper', text: 'Sparse attention retrieval with efficient transformer memory', metadata: { title: 'Sparse attention', tags: ['retrieval'], year: 2026 } };
const other = { id: 'idea:2', kind: 'idea', text: 'Biological protein folding using molecular diffusion', metadata: {} };
const resources = new WeakMap();
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'dream-research-memory-'));
  const handles = [];
  resources.set(t, handles);
  t.after(async () => {
    for (const memory of handles) await memory.close();
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}
async function use(t, options) {
  const memory = await openMemory(options);
  resources.get(t).push(memory);
  return memory;
}

test('lexical embeddings are deterministic, normalized, and explicitly nonsemantic', () => {
  const first = embedLexically('Sparse Attention: retrieval!', 384);
  assert.deepEqual(first, embedLexically('sparse attention retrieval', 384));
  assert.ok(Math.abs(Math.hypot(...first) - 1) < 1e-6);
  assert.ok([...embedLexically('!!!')].every(Number.isFinite));
  assert.throws(() => embedLexically('test', 0), /dimensions/);
  assert.throws(() => embedLexically('test', 100000), /dimensions/);
});

test('explicit lexical fallback retrieves, updates without duplicate IDs, and survives reopening', async (t) => {
  const directory = await fixture(t);
  const memory = await use(t, { directory, backend: 'lexical' });
  await memory.upsert(paper);
  await memory.upsert(other);
  assert.equal(memory.status().backend, 'lexical-fallback');
  assert.equal(memory.status().embedding, EMBEDDING);
  assert.equal(memory.status().semanticEmbeddings, false);
  assert.equal((await memory.search('sparse attention retrieval', { limit: 1 }))[0].id, paper.id);
  const updated = { ...paper, text: 'Graph neural message passing causal reasoning', metadata: { outcome: 'passed' } };
  await memory.upsert(updated);
  await memory.upsert(updated);
  assert.equal(memory.list().length, 2);
  assert.deepEqual(await memory.search('   '), []);
  assert.deepEqual(await memory.search('retrieval', { limit: 0 }), []);
  await memory.close();
  const reopened = await use(t, { directory, backend: 'lexical' });
  assert.deepEqual(reopened.list().find((value) => value.id === paper.id), updated);
  assert.equal((await reopened.search(updated.text))[0].id, paper.id);
  assert.ok((await reopened.search(updated.text))[0].score > 0.99999);
});

test('auto fallback is visible when the native module cannot load; strict native requests fail', async (t) => {
  const directory = await fixture(t);
  const loadRuvector = async () => { throw new Error('native intentionally unavailable'); };
  const memory = await use(t, { directory, backend: 'auto', loadRuvector });
  assert.equal(memory.status().backend, 'lexical-fallback');
  assert.match(memory.status().fallbackReason, /native intentionally unavailable/);
  await memory.upsert(paper);
  assert.equal((await memory.search(paper.text))[0].id, paper.id);
  await memory.close();
  await assert.rejects(openMemory({ directory, backend: 'ruvector', loadRuvector }), /Required RuVector native index failed/);
  // A failed open must not strand the writer lock or change existing records.
  const afterFailure = await use(t, { directory, backend: 'lexical' });
  assert.deepEqual(afterFailure.list(), [paper]);
});

test('records and returned results are detached from caller-owned objects', async (t) => {
  const memory = await use(t, { directory: await fixture(t), backend: 'lexical' });
  const input = structuredClone(paper);
  const pending = memory.upsert(input);
  input.metadata.tags.push('mutated');
  input.text = 'changed';
  await pending;
  const listed = memory.list();
  listed[0].metadata.tags.push('again');
  const hits = await memory.search(paper.text);
  hits[0].metadata.tags.push('also mutated');
  assert.deepEqual(memory.list(), [paper]);
});

test('empty native search degrades explicitly without losing canonical records', async (t) => {
  class BrokenNative {
    ids = new Set();
    async insert(record) { this.ids.add(record.id); }
    async len() { return this.ids.size; }
    async search() { return []; }
  }
  const memory = await use(t, { directory: await fixture(t), loadRuvector: async () => ({ VectorDB: BrokenNative }) });
  await memory.upsert(paper);
  assert.equal((await memory.search(paper.text))[0].id, paper.id);
  assert.equal(memory.status().backend, 'lexical-fallback');
  assert.match(memory.status().fallbackReason, /empty/);
  assert.deepEqual(memory.list(), [paper]);
});

test('simultaneous upserts serialize and a second writer cannot overwrite memory', async (t) => {
  const directory = await fixture(t);
  const memory = await use(t, { directory, backend: 'lexical' });
  await Promise.all(Array.from({ length: 15 }, (_, i) => memory.upsert({ ...paper, id: `paper:${i}` })));
  assert.equal(memory.list().length, 15);
  await assert.rejects(openMemory({ directory, backend: 'lexical' }), /memory is locked/);
  await memory.close();
  await assert.rejects(memory.search('test'), /closed/);
  const reopened = await use(t, { directory, backend: 'lexical' });
  assert.equal(reopened.list().length, 15);
});

test('corrupt store fails closed and never silently replaces data', async (t) => {
  const directory = await fixture(t);
  const path = join(directory, 'records.json');
  await writeFile(path, '{broken');
  await assert.rejects(openMemory({ directory, backend: 'lexical' }), /Corrupt research memory/);
  assert.equal(await readFile(path, 'utf8'), '{broken');
  assert.ok(!(await readdir(directory)).includes('.memory.lock'));
});

test('checksum tampering, duplicate IDs, and mismatched dimensions fail closed', async (t) => {
  const directory = await fixture(t);
  const memory = await use(t, { directory, backend: 'lexical' });
  await memory.upsert(paper);
  await memory.close();
  const path = join(directory, 'records.json');
  const original = await readFile(path, 'utf8');
  await assert.rejects(openMemory({ directory, backend: 'lexical', dimensions: 256 }), /Incompatible research memory/);
  const data = JSON.parse(original);
  data.records[0].text = 'tampered';
  await writeFile(path, JSON.stringify(data));
  await assert.rejects(openMemory({ directory, backend: 'lexical' }), /checksum mismatch/);
  data.records.push(data.records[0]);
  data.sha256 = createHash('sha256').update(JSON.stringify(data.records)).digest('hex');
  await writeFile(path, JSON.stringify(data));
  await assert.rejects(openMemory({ directory, backend: 'lexical' }), /duplicate id/);
});

test('symlink canonical file is refused and its target remains untouched', async (t) => {
  const directory = await fixture(t);
  const target = join(directory, 'target.json');
  await writeFile(target, 'do not modify');
  await symlink(target, join(directory, 'records.json'));
  await assert.rejects(openMemory({ directory, backend: 'lexical' }), /regular file/);
  assert.equal(await readFile(target, 'utf8'), 'do not modify');
});

test('invalid records and query limits fail before changing the canonical file', async (t) => {
  const directory = await fixture(t);
  const memory = await use(t, { directory, backend: 'lexical' });
  assert.throws(() => memory.upsert({ ...paper, kind: 'instruction' }), /kind/);
  assert.throws(() => memory.upsert({ ...paper, metadata: { score: Infinity } }), /nonfinite/);
  assert.throws(() => memory.upsert({ ...paper, metadata: { callback: () => {} } }), /JSON values/);
  assert.throws(() => memory.upsert({ ...paper, text: 'x'.repeat(128 * 1024 + 1) }), /128 KiB/);
  assert.throws(() => memory.search('query', { limit: 1001 }), /limit/);
  assert.equal(memory.list().length, 0);
  assert.ok(!(await readdir(directory)).includes('records.json'));
});

let nativeUnavailable;
try { await import('@ruvector/core'); } catch (error) { nativeUnavailable = error.message; }

test('actual RuVector native insert/search/update and fresh-process reopen', { skip: nativeUnavailable }, async (t) => {
  const directory = await fixture(t);
  const memory = await use(t, { directory, backend: 'ruvector' });
  assert.equal(memory.status().backend, 'ruvector-native');
  assert.equal(memory.status().fallbackReason, null);
  await memory.upsert(paper);
  await memory.upsert(other);
  assert.equal((await memory.search('sparse attention retrieval', { limit: 1 }))[0].id, paper.id);
  assert.ok((await memory.search(paper.text))[0].score > 0.9999);
  const updated = { ...paper, text: 'Graph neural causal memory with directed message passing' };
  await memory.upsert(updated);
  assert.equal(memory.list().length, 2);
  const hits = await memory.search(updated.text);
  assert.equal(hits[0].id, updated.id);
  assert.equal(new Set(hits.map((hit) => hit.id)).size, hits.length);
  await memory.close();
  const script = `import {openMemory} from ${JSON.stringify(moduleUrl)};
    const memory=await openMemory({directory:process.argv[1],backend:'ruvector'});
    try { console.log(JSON.stringify({status:memory.status(),records:memory.list(),hits:await memory.search(process.argv[2]),otherHits:await memory.search(process.argv[3])})); }
    finally { await memory.close(); }`;
  const { stdout } = await run(process.execPath, ['--input-type=module', '-e', script, directory, updated.text, other.text], { timeout: 20000 });
  const result = JSON.parse(stdout);
  assert.equal(result.status.backend, 'ruvector-native');
  assert.equal(result.records.length, 2);
  assert.ok(result.hits.length >= 1 && result.hits.length <= 2);
  assert.equal(result.hits[0].id, updated.id);
  assert.ok(result.hits[0].score > 0.9999);
  assert.equal(result.otherHits[0].id, other.id);
  assert.deepEqual((await readdir(directory)).filter((name) => name.startsWith('.ruvector-')), []);
});

test('failed persistence never exposes an uncommitted native record', { skip: nativeUnavailable }, async (t) => {
  const directory = await fixture(t);
  const memory = await use(t, { directory, backend: 'ruvector' });
  await memory.upsert(paper);
  const original = await readFile(join(directory, 'records.json'), 'utf8');
  await rm(join(directory, 'records.json'));
  const target = join(directory, 'protected.json');
  await writeFile(target, original);
  await symlink(target, join(directory, 'records.json'));
  await assert.rejects(memory.upsert(other), /regular file/);
  assert.deepEqual(memory.list(), [paper]);
  assert.equal(await readFile(target, 'utf8'), original);
  // Query rebuilds the dirty native cache from the last committed in-memory
  // snapshot, excluding the failed insert. Restore the actual canonical file.
  await rm(join(directory, 'records.json'));
  await writeFile(join(directory, 'records.json'), original);
  assert.deepEqual((await memory.search(other.text)).map((record) => record.id), [paper.id]);
  await memory.upsert(other);
  assert.equal(memory.list().length, 2);
  await Promise.all([memory.close(), memory.close()]);
  const reopened = await use(t, { directory, backend: 'ruvector' });
  assert.equal(reopened.list().length, 2);
});
