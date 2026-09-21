#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { openLab, json } from './core.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const [command = 'status', id, ...rest] = process.argv.slice(2);
try {
  const lab = await openLab(root);
  let result;
  switch (command) {
    case 'status': result = await lab.status(); break;
    case 'prepare': result = await lab.prepare(); break;
    case 'search': result = await lab.search(id, rest.join(' ')); break;
    case 'recall': result = await lab.recall([id, ...rest].join(' ')); break;
    case 'freeze': result = await lab.freeze(id, await json(rest[0])); break;
    case 'evaluate': result = await lab.evaluate(id); break;
    case 'finish': result = await lab.finalize(id, await json(rest[0])); break;
    case 'abandon': result = await lab.finalize(id, { lesson: rest.join(' ') }, true); break;
    case 'verify': result = await lab.verifyRun(id); if (!result.valid) process.exitCode = 1; break;
    case 'repair': result = await lab.repair(id); if (!result.valid) process.exitCode = 1; break;
    case 'disposition': result = await lab.disposition(id, rest[0]); break;
    default: throw new Error('Commands: status, prepare, search <run-id> <arxiv-query>, recall <query>, freeze <run-id> <proposal.json>, evaluate <run-id>, finish <run-id> <review.json>, abandon <run-id> <reason>, verify <run-id>, repair <run-id>, disposition <run-id> reviewed|discarded. Run IDs: YYYY-MM-DD-HHMM, or YYYY-MM-DD for legacy daily runs.');
  }
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(`Research loop: ${error.message}`);
  process.exitCode = 1;
}
