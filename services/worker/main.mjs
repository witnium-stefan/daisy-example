import { faults } from '../faults.mjs';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { configuration, handler, httpReady, listen, apiRequest, containsSecret } from '../common.mjs';
import { database } from '../database.mjs';
import { writeLedger } from './ledger.mjs';

export function createWorker(env, dependencies, faultControl) {
  const config = configuration('worker', env);
  return (faultControl ?? faults('worker', config, { clock: { now: Date.now, setTimeout, clearTimeout } })).wrap(handler('worker', config, dependencies));
}

export async function workOnce(store, config) {
  let { job } = await apiRequest(config, '/internal/jobs');
  if (!job) {
    job = { id: `synthetic-${randomUUID()}`, payload: 'Daisy synthetic ledger entry' };
    await apiRequest(config, '/internal/jobs', { method: 'POST', body: JSON.stringify(job) });
    // Always read the shared FIFO, including submissions that arrived meanwhile.
    ({ job } = await apiRequest(config, '/internal/jobs'));
  }
  if (!job) throw new Error('API returned no queued job after submission');
  if (containsSecret(job, config.token)) throw new Error('Secret-bearing job refused');
  const row = await writeLedger(store, job);
  // Completion is acknowledged only after file durability and its SQL commit.
  return apiRequest(config, '/internal/complete', { method: 'POST', body: JSON.stringify({ sequence: row.sequence }) });
}

if (import.meta.main) {
  let db;
  try {
    const config = configuration('worker', process.env);
    const control = faults('worker', config, { clock: { now: Date.now, setTimeout, clearTimeout } });
    if (!await control.start()) process.exit(1);
    db = database(config.databaseUrl);
    try { await db.initialize(); } catch { throw new Error('DATABASE_URL unavailable or incompatible ledger schema'); }
    const abort = new AbortController();
    let failed = false;
    const loop = (async () => {
      while (!abort.signal.aborted) {
        try { await control.beforeWork(); await workOnce(db, config); } catch {
          failed = true;
          console.error('Worker ledger flow failed; writes stopped');
          break;
        }
        await delay(1000, undefined, { signal: abort.signal }).catch(() => {});
      }
    })();
    listen('worker', 8082, createWorker(process.env, {
      api: async () => {
        if (failed) throw new Error('Worker stopped');
        await httpReady(new URL('/health/ready', config.apiUrl), 'api');
        await apiRequest(config, '/internal/jobs');
      }, postgres: db.ready,
    }, control), async () => { control.close(); abort.abort(); await loop; await db.close(); });
  } catch (error) { console.error(error.message); await db?.close(); process.exitCode = 1; }
}
