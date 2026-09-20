/**
 * Persistent research memory with a real, optional @ruvector/core native index.
 *
 * records.json is authoritative. The index is rebuilt on open because the pinned
 * native binding does not provide a reliable close/reopen contract. Embeddings
 * are deterministic lexical feature hashes, NOT neural/semantic embeddings.
 * No model download, remote memory service, or execution of recalled text occurs.
 */
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, realpath, rename, rm, unlink } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';

export const EMBEDDING = 'lexical-feature-hash-v1';
const LIMITS = Object.freeze({ records: 10000, fileBytes: 64 * 1024 * 1024, recordBytes: 256 * 1024, textBytes: 128 * 1024, results: 1000 });
const KINDS = new Set(['paper', 'experiment', 'idea']);
const STOP_WORDS = new Set('a an and are as at be by for from has have in into is it of on or that the their this to was were will with'.split(' '));

function digest(value) { return createHash('sha256').update(value).digest('hex'); }
function validateDimensions(dimensions) {
  if (!Number.isSafeInteger(dimensions) || dimensions < 32 || dimensions > 4096) throw new RangeError('Memory dimensions must be an integer from 32 to 4096');
}

/** Signed unigram/bigram hashing; the version and dimension are pinned per store. */
export function embedLexically(text, dimensions = 384) {
  validateDimensions(dimensions);
  if (typeof text !== 'string' || Buffer.byteLength(text) > LIMITS.textBytes) throw new TypeError('Memory text must be a string at most 128 KiB');
  const terms = (text.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((term) => !STOP_WORDS.has(term));
  const counts = new Map();
  for (let i = 0; i < terms.length; i += 1) {
    counts.set(terms[i], (counts.get(terms[i]) ?? 0) + 1);
    if (i) {
      const bigram = `${terms[i - 1]}\u001f${terms[i]}`;
      counts.set(bigram, (counts.get(bigram) ?? 0) + 0.5);
    }
  }
  const vector = new Float32Array(dimensions);
  for (const [term, frequency] of counts) {
    const hash = createHash('sha256').update(term).digest();
    vector[hash.readUInt32LE(0) % dimensions] += (hash[4] & 1 ? 1 : -1) * Math.log1p(frequency);
  }
  let magnitude = Math.hypot(...vector);
  // Zero vectors are undefined for cosine distance. Reserve a deterministic
  // direction for empty/stopword-only records; empty queries still return [].
  if (magnitude === 0) { vector[0] = 1; magnitude = 1; }
  for (let i = 0; i < dimensions; i += 1) vector[i] /= magnitude;
  return vector;
}

function snapshotRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw new TypeError('Memory record must be an object');
  if (typeof record.id !== 'string' || !record.id.trim() || record.id.length > 512) throw new TypeError('Memory record requires an id of 1–512 characters');
  if (!KINDS.has(record.kind)) throw new TypeError('Memory record kind must be paper, experiment, or idea');
  if (typeof record.text !== 'string' || !record.text.trim() || Buffer.byteLength(record.text) > LIMITS.textBytes) throw new TypeError('Memory record requires nonempty text at most 128 KiB');
  const metadata = record.metadata ?? {};
  if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) throw new TypeError('Memory metadata must be a JSON object');
  const raw = JSON.stringify({ id: record.id, kind: record.kind, text: record.text, metadata }, (_key, value) => {
    if (typeof value === 'number' && !Number.isFinite(value)) throw new TypeError('Memory metadata contains a nonfinite number');
    if (['bigint', 'function', 'symbol', 'undefined'].includes(typeof value)) throw new TypeError('Memory metadata must contain only JSON values');
    return value;
  });
  if (Buffer.byteLength(raw) > LIMITS.recordBytes) throw new RangeError('Memory record exceeds 256 KiB');
  return JSON.parse(raw);
}

async function readRegularFile(path, maxBytes) {
  const info = await lstat(path);
  if (!info.isFile()) throw new Error(`Memory path must be a regular file, not a symlink: ${path}`);
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes) throw new Error('Memory store exceeds its size limit or is not a regular file');
    const bytes = Buffer.alloc(stat.size + 1);
    let count = 0;
    while (count < bytes.length) {
      const result = await handle.read(bytes, count, bytes.length - count, count);
      if (!result.bytesRead) break;
      count += result.bytesRead;
    }
    if (count !== stat.size) throw new Error('Memory store changed during read');
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, count));
  } finally { await handle.close(); }
}

async function loadRecords(path, dimensions) {
  let raw;
  try { raw = await readRegularFile(path, LIMITS.fileBytes); }
  catch (error) { if (error.code === 'ENOENT') return new Map(); throw error; }
  let store;
  try { store = JSON.parse(raw); }
  catch (cause) { throw new Error('Corrupt research memory: records.json is invalid JSON; restore a known-good copy', { cause }); }
  if (!store || store.schemaVersion !== 1 || store.embedding !== EMBEDDING || store.dimensions !== dimensions || !Array.isArray(store.records)) {
    throw new Error('Incompatible research memory schema, embedding, or dimensions; migrate to a new directory');
  }
  if (store.records.length > LIMITS.records) throw new Error('Memory record limit exceeded');
  if (store.sha256 !== digest(JSON.stringify(store.records))) throw new Error('Corrupt research memory: record checksum mismatch');
  const result = new Map();
  for (const value of store.records) {
    const record = snapshotRecord(value);
    if (result.has(record.id)) throw new Error(`Corrupt research memory: duplicate id ${record.id}`);
    result.set(record.id, record);
  }
  return result;
}

function serializeRecords(records, dimensions) {
  if (records.size > LIMITS.records) throw new RangeError('Memory record limit exceeded');
  const values = [...records.values()];
  const raw = `${JSON.stringify({ schemaVersion: 1, embedding: EMBEDDING, dimensions, sha256: digest(JSON.stringify(values)), records: values }, null, 2)}\n`;
  if (Buffer.byteLength(raw) > LIMITS.fileBytes) throw new RangeError('Memory file exceeds 64 MiB');
  return raw;
}

async function atomicWrite(path, raw, directory) {
  const temporary = join(directory, `.records-${randomUUID()}.tmp`);
  const handle = await open(temporary, 'wx', 0o600);
  let committed = false;
  try {
    await handle.writeFile(raw, 'utf8');
    await handle.sync();
    await handle.close();
    try {
      if (!(await lstat(path)).isFile()) throw new Error('Memory records.json must be a regular file');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await rename(temporary, path);
    committed = true;
    if (process.platform !== 'win32') {
      const parent = await open(directory, 'r');
      try { await parent.sync(); } finally { await parent.close(); }
    }
  } catch (cause) {
    if (committed) {
      const error = new Error('Memory replacement committed but directory sync failed; close and reopen before retrying', { cause });
      error.committed = true;
      throw error;
    }
    throw cause;
  } finally {
    await handle.close().catch(() => {});
    if (!committed) await unlink(temporary).catch(() => {});
  }
}

/**
 * One writer per directory. close() releases the lock; abandoned locks fail
 * closed and name the recovery file instead of risking concurrent lost writes.
 * loadRuvector is an explicit test seam, never populated from stored content.
 */
export async function openMemory({ directory, dimensions = 384, backend = 'auto', loadRuvector = () => import('@ruvector/core') } = {}) {
  if (typeof directory !== 'string' || !directory || directory.includes('\0')) throw new TypeError('Memory directory is required');
  validateDimensions(dimensions);
  if (!['auto', 'ruvector', 'lexical'].includes(backend)) throw new TypeError('Memory backend must be auto, ruvector, or lexical');
  const requested = resolve(directory);
  await mkdir(requested, { recursive: true, mode: 0o700 });
  if (!(await lstat(requested)).isDirectory()) throw new Error('Memory directory cannot be a symlink');
  const location = await realpath(requested);
  const path = join(location, 'records.json');
  const lockPath = join(location, '.memory.lock');
  let lock;
  try { lock = await open(lockPath, 'wx', 0o600); }
  catch (cause) { throw new Error(`Research memory is locked or inaccessible: ${lockPath}. Remove a stale lock only after confirming its owner process has stopped.`, { cause }); }
  let records;
  let NativeDb;
  let db;
  let nativeDirectory;
  let nativeDirty = false;
  let fallbackReason = backend === 'lexical' ? 'Lexical backend explicitly selected' : null;
  let closed = false;
  let closing;
  let poisoned = false;
  let queue = Promise.resolve();
  const cacheDirectories = new Set();

  async function discardIndex() {
    db = undefined;
    if (nativeDirectory) {
      const previous = nativeDirectory;
      nativeDirectory = undefined;
      await rm(previous, { recursive: true, force: true }).then(() => cacheDirectories.delete(previous), () => {});
    }
  }

  async function rebuildIndex(indexRecords = records) {
    await discardIndex();
    nativeDirectory = await mkdtemp(join(location, '.ruvector-'));
    cacheDirectories.add(nativeDirectory);
    // The actual NAPI enum uses uppercase Cosine; the package prose differs.
    db = new NativeDb({ dimensions, distanceMetric: 'Cosine', storagePath: join(nativeDirectory, 'index.db'), hnswConfig: { m: 16, efConstruction: 100, efSearch: 100, maxElements: LIMITS.records } });
    for (const record of indexRecords.values()) await db.insert({ id: record.id, vector: embedLexically(record.text, dimensions) });
    if (await db.len() !== indexRecords.size) throw new Error('Native index record count did not match canonical memory');
    nativeDirty = false;
  }

  async function nativeFailure(cause) {
    nativeDirty = true;
    if (backend === 'ruvector') throw new Error(`Required RuVector native index failed: ${cause.message}`, { cause });
    fallbackReason = `RuVector native index unavailable: ${cause.message}`;
    await discardIndex();
    NativeDb = undefined;
    nativeDirty = false;
  }

  async function ensureIndex() {
    if (NativeDb && nativeDirty) {
      try { await rebuildIndex(); } catch (error) { await nativeFailure(error); }
    }
  }

  function enqueue(operation) {
    if (closed || poisoned) return Promise.reject(new Error('Research memory is closed or requires reopening'));
    const result = queue.then(() => {
      if (poisoned) throw new Error('Research memory requires reopening after an uncertain commit');
      return operation();
    });
    queue = result.catch(() => {});
    return result;
  }

  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, host: hostname(), openedAt: new Date().toISOString() }));
    records = await loadRecords(path, dimensions);
    if (backend !== 'lexical') {
      try {
        const module = await loadRuvector();
        NativeDb = module.VectorDB ?? module.VectorDb ?? module.default?.VectorDB ?? module.default?.VectorDb;
        if (typeof NativeDb !== 'function') throw new Error('@ruvector/core did not expose VectorDB');
        await rebuildIndex();
      } catch (error) { await nativeFailure(error); }
    }
  } catch (error) {
    await discardIndex();
    await lock.close();
    await unlink(lockPath);
    throw error;
  }

  return {
    upsert(record) {
      // Snapshot before queueing so later caller mutations cannot change a write.
      const snapshot = snapshotRecord(record);
      return enqueue(async () => {
        const previous = records.get(snapshot.id);
        if (JSON.stringify(previous) === JSON.stringify(snapshot)) return structuredClone(snapshot);
        const next = new Map(records);
        next.set(snapshot.id, snapshot);
        const raw = serializeRecords(next, dimensions);
        await ensureIndex();
        if (db) {
          nativeDirty = true;
          try {
            // Deleting then reinserting a stable ID can leave the pinned native
            // HNSW index incomplete. A replacement rebuild avoids tombstones.
            if (previous) await rebuildIndex(next);
            else await db.insert({ id: snapshot.id, vector: embedLexically(snapshot.text, dimensions) });
            nativeDirty = true;
            if (await db.len() !== next.size) throw new Error('Native index record count mismatch after upsert');
          } catch (error) { await nativeFailure(error); }
        }
        try { await atomicWrite(path, raw, location); }
        catch (error) { if (error.committed) poisoned = true; throw error; }
        records = next;
        nativeDirty = false;
        return structuredClone(snapshot);
      });
    },
    search(text, { limit = 5 } = {}) {
      if (!Number.isSafeInteger(limit) || limit < 0 || limit > LIMITS.results) throw new RangeError('Search limit must be an integer from 0 to 1000');
      const vector = embedLexically(text, dimensions);
      return enqueue(async () => {
        if (!limit || !records.size || !text.trim() || !/[\p{L}\p{N}]/u.test(text)) return [];
        await ensureIndex();
        let hits;
        if (db) {
          try {
            const raw = await db.search({ vector, k: Math.min(limit, records.size), efSearch: Math.max(100, limit) });
            // HNSW is approximate: a valid search can return fewer than k.
            if (!Array.isArray(raw) || raw.length === 0 || raw.length > Math.min(limit, records.size) || raw.some((hit) => !records.has(hit.id) || !Number.isFinite(hit.score)) || new Set(raw.map((hit) => hit.id)).size !== raw.length) throw new Error('Native index returned empty, invalid, or duplicate records');
            hits = raw.map((hit) => ({ ...structuredClone(records.get(hit.id)), score: Math.max(-1, Math.min(1, 1 - hit.score)), distance: hit.score }));
          } catch (error) { await nativeFailure(error); }
        }
        if (!hits) {
          hits = [...records.values()].map((record) => {
            const candidate = embedLexically(record.text, dimensions);
            const score = Math.max(-1, Math.min(1, candidate.reduce((sum, value, i) => sum + value * vector[i], 0)));
            return { ...structuredClone(record), score, distance: 1 - score };
          });
        }
        return hits.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, limit);
      });
    },
    list() {
      if (closed || poisoned) throw new Error('Research memory is closed or requires reopening');
      return [...records.values()].map((record) => structuredClone(record));
    },
    status() {
      return { backend: NativeDb ? 'ruvector-native' : 'lexical-fallback', embedding: EMBEDDING, semanticEmbeddings: false, approximateRetrieval: Boolean(NativeDb), dimensions, records: records.size, path, indexPersistence: 'rebuilt-from-canonical-json', fallbackReason, closed };
    },
    async close() {
      if (closing) return closing;
      closed = true;
      closing = (async () => {
        await queue;
        await discardIndex();
        for (const cache of cacheDirectories) await rm(cache, { recursive: true, force: true }).catch(() => {});
        await lock.close();
        await unlink(lockPath);
      })();
      return closing;
    },
  };
}
