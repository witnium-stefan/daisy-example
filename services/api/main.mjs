import { faults } from '../faults.mjs';
import { randomUUID } from 'node:crypto';
import { configuration, handler, listen, send, authorized, body, containsSecret } from '../common.mjs';
import { database } from '../database.mjs';
import { validateJob } from '../worker/ledger.mjs';
import { files, verifyPrefix } from './files.mjs';

export function createApi(env, dependencies, store, volume, faultControl) {
  const config = configuration('api', env);
  const control = faultControl ?? faults('api', config, { clock: { now: Date.now, setTimeout, clearTimeout } });
  const management = handler('api', config, dependencies);
  return control.wrap(async (req, res) => {
    const reply = (status, value) => send(res, status, value, config.token);
    if (req.url.startsWith('/internal/') && !authorized(req, config.token)) return reply(401, { error: 'Unauthorized worker request' });
    if (['/health/live', '/health/ready', '/version'].includes(req.url)) return management(req, res);
    const route = `${req.method} ${req.url}`;
    if (!['GET /', 'GET /ledger', 'GET /files', 'POST /jobs', 'GET /internal/jobs', 'POST /internal/jobs', 'POST /internal/complete', 'POST /internal/checkpoint', 'POST /internal/restore'].includes(route)) return reply(404, { error: 'not-found' });
    if (!store || !volume) return reply(503, { error: 'Missing API state dependencies' });
    try {
      control.assertDatabase();
      if (route === 'GET /' || route === 'GET /ledger') return reply(200, { service: 'api', rows: await store.rows() });
      if (route === 'GET /files') return reply(200, { files: await volume.list() });
      if (route === 'GET /internal/jobs') return reply(200, { job: await store.nextJob() });
      if (route === 'POST /jobs' || route === 'POST /internal/jobs') {
        let job;
        try { job = await body(req, config.token); validateJob(job); } catch { return reply(400, { error: 'Invalid job or secret-bearing content' }); }
        control.assertDatabase();
        await store.transaction(async (tx) => {
          const existing = await tx.findJob(job.id);
          if (existing && existing.payload !== job.payload) throw new Error('Job ID payload conflict');
          await tx.enqueue({ id: job.id, payload: job.payload });
        });
        return reply(202, { id: job.id, status: 'queued' });
      }
      if (route === 'POST /internal/complete') {
        let input;
        try { input = await body(req, config.token); } catch { return reply(400, { error: 'Invalid completion' }); }
        if (!Number.isInteger(input?.sequence) || input.sequence < 1) return reply(400, { error: 'Invalid completion sequence' });
        const completed = await store.transaction(async (tx) => {
          const row = (await tx.rows()).find((row) => row.sequence === input.sequence);
          if (!row) throw new Error('Missing committed row');
          if (containsSecret(row, config.token)) throw new Error('Secret-bearing row refused');
          const file = await volume.write(row);
          await tx.complete(row.sequence, file.hash);
          return { row, file, status: 'complete' };
        });
        return reply(200, completed);
      }
      if (route === 'POST /internal/checkpoint') {
        let input;
        try { input = await body(req, config.token); } catch { return reply(400, { error: 'Invalid checkpoint metadata' }); }
        if (typeof input?.runId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(input.runId) ||
            !/^sha256:[a-f0-9]{64}$/.test(input.imageDigest ?? '') || typeof input.targetScope !== 'string' || !input.targetScope.trim()) return reply(400, { error: 'Checkpoint requires runId, imageDigest and targetScope' });
        const manifest = await store.transaction(async (tx) => {
          const rows = await tx.rows();
          const fileManifest = [];
          for (const row of rows) {
            if (containsSecret(row, config.token)) throw new Error('Secret-bearing row refused');
            const file = await volume.write(row);
            await tx.complete(row.sequence, file.hash);
            fileManifest.push(file);
          }
          const manifest = { format: 1, checkpointId: randomUUID(), runId: input.runId, imageDigest: input.imageDigest,
            targetScope: input.targetScope, sourceRevision: config.revision, time: new Date().toISOString(),
            watermark: rows.length, rows, files: fileManifest };
          await verifyPrefix(manifest, rows, volume);
          return manifest;
        });
        return reply(200, manifest);
      }
      if (route === 'POST /internal/restore') {
        let expected;
        try { expected = await body(req, config.token, 80 * 1024 * 1024); } catch { return reply(400, { error: 'Invalid recovery manifest' }); }
        const started = performance.now();
        try {
          const result = await store.transaction(async (tx) => verifyPrefix(expected, await tx.rows(), volume));
          return reply(200, { ...result, durationMs: Math.round(performance.now() - started) });
        } catch { return reply(409, { error: 'Complete-prefix restore verification failed' }); }
      }
    } catch (error) {
      if (error.message === 'EXAMPLE_DATABASE_DOWN') return reply(503, { error: 'EXAMPLE_DATABASE_DOWN' });
      if (error.message === 'Job ID payload conflict') return reply(409, { error: 'Job ID payload conflict' });
      // SQL/network/filesystem errors may contain credentials or user payloads.
      return reply(503, { error: `API operation failed: ${route}` });
    }
  });
}

if (import.meta.main) {
  let db;
  try {
    const config = configuration('api', process.env);
    const control = faults('api', config, { clock: { now: Date.now, setTimeout, clearTimeout } });
    if (!await control.start()) process.exit(1);
    const volume = files(config.filesPath);
    try { await volume.ready(); } catch { throw new Error('FILES_PATH unavailable: mounted directory must exist and be writable'); }
    db = database(config.databaseUrl);
    try { await db.initialize(); } catch { throw new Error('DATABASE_URL unavailable or incompatible ledger schema'); }
    listen('api', 8081, createApi(process.env, { postgres: db.ready, files: volume.ready }, db, volume, control), async () => { control.close(); await db.close(); });
  } catch (error) { console.error(error.message); await db?.close(); process.exitCode = 1; }
}
