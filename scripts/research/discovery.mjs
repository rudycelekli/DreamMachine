/**
 * Read a bounded daily scan of primary-source arXiv metadata.
 *
 * Metadata is untrusted research data, never an instruction or executable input.
 * The caller owns persistent caching/deduplication and should scan once daily.
 * arXiv asks clients to use one connection and at least 3 seconds between calls:
 * https://info.arxiv.org/help/api/tou.html
 * Query/Atom schema: https://info.arxiv.org/help/api/user-manual.html
 */
import { XMLParser, XMLValidator } from 'fast-xml-parser';

export const DEFAULT_ARXIV_QUERY = 'cat:cs.AI OR cat:cs.LG OR cat:cs.CL OR cat:cs.IR';
const API_URL = 'https://export.arxiv.org/api/query';
const MAX_FEED_BYTES = 4 * 1024 * 1024;
const DAY_MS = 86_400_000;

const parser = new XMLParser({
  ignoreAttributes: false,
  removeNSPrefix: true,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  processEntities: true,
});

function list(value) {
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}

function text(value) {
  const raw = typeof value === 'string' ? value : value?.['#text'];
  if (typeof raw !== 'string') return '';
  // Remove terminal controls, but preserve Unicode and mathematical notation.
  return raw.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').replace(/\s+/g, ' ').trim();
}

function timestamp(value, field) {
  const raw = text(value);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(raw)) {
    throw new Error(`arXiv entry has an invalid ${field} timestamp`);
  }
  const date = new Date(raw);
  if (!Number.isFinite(date.getTime())) throw new Error(`arXiv entry has an invalid ${field} timestamp`);
  return date.toISOString();
}

/** Accept only genuine arXiv abstract identifiers; never follow entry URLs. */
function canonicalId(value) {
  let url;
  try { url = new URL(text(value)); } catch { throw new Error('arXiv entry has an invalid identifier URL'); }
  if (!['http:', 'https:'].includes(url.protocol)
      || !['arxiv.org', 'www.arxiv.org'].includes(url.hostname)
      || url.username || url.password || url.port || url.search || url.hash) {
    throw new Error('arXiv entry has an unsafe identifier URL');
  }
  const match = /^\/abs\/((?:\d{2}(?:0[1-9]|1[0-2])\.\d{4,5}|[a-z][a-z-]*(?:\.[A-Z]{2})?\/\d{7}))(?:v[1-9]\d*)?$/.exec(url.pathname);
  if (!match) throw new Error('arXiv entry has an invalid paper identifier');
  return match[1];
}

function parseFeed(xml) {
  if (typeof xml !== 'string' || Buffer.byteLength(xml, 'utf8') > MAX_FEED_BYTES) {
    throw new Error('arXiv feed is missing or exceeds the 4 MiB limit');
  }
  // External/custom entities are unnecessary for Atom and must not be expanded.
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(xml)) throw new Error('DTD and entity declarations are not allowed in arXiv feeds');
  const valid = XMLValidator.validate(xml);
  if (valid !== true) throw new Error('arXiv returned malformed XML');
  const document = parser.parse(xml);
  const feed = document?.feed;
  if (!feed || typeof feed !== 'object' || Array.isArray(feed)) throw new Error('arXiv did not return an Atom feed');

  const entries = list(feed.entry);
  const rawTotal = text(feed.totalResults);
  const totalResults = /^\d+$/.test(rawTotal) ? Number(rawTotal) : undefined;
  // An empty API result must be explicitly confirmed; an HTML/block page or
  // schema drift must never trigger the "nothing new, invent something" path.
  if (entries.length === 0 && totalResults !== 0) throw new Error('arXiv feed did not confirm an empty result set');
  if (totalResults !== undefined && (!Number.isSafeInteger(totalResults) || totalResults < entries.length)) {
    throw new Error('arXiv feed has inconsistent result metadata');
  }
  const papers = entries.map(entry => {
    if (!entry || typeof entry !== 'object') throw new Error('arXiv feed contains an invalid entry');
    if (text(entry.title).toLowerCase() === 'error' || /\/api\/errors(?:[?#/]|$)/.test(text(entry.id))) {
      throw new Error('arXiv returned an API error entry');
    }
    const id = canonicalId(entry.id);
    const title = text(entry.title);
    const abstract = text(entry.summary);
    if (!title || title.length > 2000 || !abstract || abstract.length > 50_000) {
      throw new Error('arXiv entry has missing or excessive title/abstract metadata');
    }
    const published = timestamp(entry.published, 'published');
    const updated = timestamp(entry.updated, 'updated');
    if (updated < published) throw new Error('arXiv entry was updated before its publication');
    const authors = [...new Set(list(entry.author).map(author => text(author?.name)).filter(Boolean))];
    const categories = [...new Set(list(entry.category).map(category => text(category?.['@_term'])).filter(Boolean))];
    if (authors.length === 0 || categories.length === 0) throw new Error('arXiv entry lacks author/category metadata');
    return { id, title, abstract, url: `https://arxiv.org/abs/${id}`, published, updated, authors, categories };
  });
  return { papers, totalResults };
}

/** Parse primary-source API Atom, rejecting malformed entries rather than inventing fields. */
export function parseArxivFeed(xml) {
  return parseFeed(xml).papers;
}

function validateWindow(now, lookbackDays) {
  const date = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(date.getTime())) throw new TypeError('now must be a valid date');
  if (!Number.isFinite(lookbackDays) || lookbackDays <= 0 || lookbackDays > 365) {
    throw new RangeError('lookbackDays must be greater than 0 and no more than 365');
  }
  return { now: date, since: new Date(date.getTime() - lookbackDays * DAY_MS) };
}

/** Keep first publications in the window; revisions of old work are not new papers. */
export function filterRecentPapers(papers, { now = new Date(), lookbackDays = 7, maxResults = 40 } = {}) {
  const window = validateWindow(now, lookbackDays);
  if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 2000) throw new RangeError('maxResults must be an integer from 1 to 2000');
  const byId = new Map();
  for (const paper of papers) {
    const published = Date.parse(paper.published);
    if (!Number.isFinite(published) || published < window.since.getTime() || published > window.now.getTime()) continue;
    const previous = byId.get(paper.id);
    if (!previous || Date.parse(paper.updated) > Date.parse(previous.updated)) byId.set(paper.id, paper);
  }
  return [...byId.values()].sort((a, b) => Date.parse(b.published) - Date.parse(a.published) || a.id.localeCompare(b.id)).slice(0, maxResults);
}

function queryDate(date) {
  return date.toISOString().replace(/[-:T]/g, '').slice(0, 12);
}

async function boundedText(response) {
  const length = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(length) && length > MAX_FEED_BYTES) throw new Error('arXiv feed exceeds the 4 MiB limit');
  if (!response.body?.getReader) {
    const value = await response.text();
    if (Buffer.byteLength(value, 'utf8') > MAX_FEED_BYTES) throw new Error('arXiv feed exceeds the 4 MiB limit');
    return value;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_FEED_BYTES) throw new Error('arXiv feed exceeds the 4 MiB limit');
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally {
    if (bytes > MAX_FEED_BYTES) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/**
 * One bounded API request, with no retries or source-derived network requests.
 * `complete` means the configured bounded scan succeeded, not an exhaustive
 * search of all scientific literature. A failed scan is never a novelty claim.
 * `sources[0].truncated` discloses when more results exist than this scan reads.
 */
export async function discoverPapers({
  now = new Date(), lookbackDays = 7, maxResults = 40,
  query = DEFAULT_ARXIV_QUERY, fetchImpl = globalThis.fetch, timeoutMs = 20_000,
} = {}) {
  const window = validateWindow(now, lookbackDays);
  if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 2000) throw new RangeError('maxResults must be an integer from 1 to 2000');
  if (typeof query !== 'string' || !query.trim() || query.length > 2000) throw new TypeError('query must contain 1 to 2000 characters');
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) throw new RangeError('timeoutMs must be an integer from 1 to 120000');
  const url = new URL(API_URL);
  url.searchParams.set('search_query', `(${query}) AND submittedDate:[${queryDate(window.since)} TO ${queryDate(window.now)}]`);
  url.searchParams.set('start', '0');
  url.searchParams.set('max_results', String(maxResults));
  url.searchParams.set('sortBy', 'submittedDate');
  url.searchParams.set('sortOrder', 'descending');
  const source = { url: url.href, status: 'error' };
  const controller = new AbortController();
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`arXiv request exceeded ${timeoutMs} ms`));
    }, timeoutMs);
  });
  try {
    const feed = await Promise.race([deadline, (async () => {
      const response = await fetchImpl(url.href, {
        signal: controller.signal,
        // Never follow a source or proxy redirect to an arbitrary host.
        redirect: 'error',
        headers: { Accept: 'application/atom+xml, application/xml', 'User-Agent': 'DreamMachineResearch/1.0 (+https://github.com/ruvnet/dream-machine)' },
      });
      if (!response.ok) throw new Error(`arXiv returned HTTP ${response.status}`);
      if (response.url && new URL(response.url).origin !== url.origin) throw new Error('arXiv response has an unexpected origin');
      return parseFeed(await boundedText(response));
    })()]);
    source.status = 'ok';
    source.totalResults = feed.totalResults ?? feed.papers.length;
    source.truncated = feed.totalResults === undefined ? feed.papers.length >= maxResults : feed.totalResults > feed.papers.length;
    return { papers: filterRecentPapers(feed.papers, { now: window.now, lookbackDays, maxResults }), sources: [source], complete: true };
  } catch (error) {
    // Error text is kept small and stripped of controls for reports/logs.
    source.error = text(error?.message ?? String(error)).slice(0, 500);
    return { papers: [], sources: [source], complete: false };
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
