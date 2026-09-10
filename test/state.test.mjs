import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile, rm, cp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApi } from '../services/api/main.mjs';
import { files, fileBytes, fileName, verifyPrefix } from '../services/api/files.mjs';
import { createWeb } from '../services/web/main.mjs';
import { workOnce } from '../services/worker/main.mjs';
import { writeLedger } from '../services/worker/ledger.mjs';
import { applicationHandler, configuration } from '../services/common.mjs';
import { memoryStore } from './support/store.mjs';

async function serve(t, handler) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}`;
}
async function setup(t, store = memoryStore()) {
  const directory = await mkdtemp(join(tmpdir(), 'daisy-state-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const volume = files(directory);
  const env = { SOURCE_REVISION: 'a'.repeat(40), FAULT_FILL_CAP_BYTES: '1048576', FAULT_FILL_FLOOR_BYTES: '1048576', DATABASE_URL: 'postgresql://unit:unused@postgres/example',
    EXAMPLE_TOKEN: randomBytes(24).toString('hex'), FILES_PATH: directory, EXAMPLE_MESSAGE: 'Visible message' };
  const api = createApi(env, { postgres: async () => {}, files: volume.ready }, store, volume);
  env.API_URL = await serve(t, api);
  const request = async (path, value, token = env.EXAMPLE_TOKEN) => {
    const response = await fetch(new URL(path, env.API_URL), { method: value === undefined ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
    return { status: response.status, body: await response.json() };
  };
  return { env, api, store, volume, directory, request };
}
const metadata = { runId: 'unit-run', imageDigest: `sha256:${'b'.repeat(64)}`, targetScope: 'isolated-test' };

test('web submits through API, worker commits and completes files, web renders API ledger', async (t) => {
  const { env, store, volume, request, directory } = await setup(t);
  const web = await serve(t, applicationHandler(createWeb(env, { api: async () => {} })));
  const submit = await fetch(`${web}/jobs`, { method: 'POST', body: JSON.stringify({ id: 'web-job', payload: 'from the web' }) });
  assert.equal(submit.status, 202);
  assert.deepEqual(await submit.json(), { id: 'web-job', status: 'queued' });
  const completed = await workOnce(store, configuration('worker', env));
  assert.equal(completed.row.id, 'web-job');
  assert.equal(completed.row.sequence, 1);
  assert.deepEqual((await request('/ledger')).body.rows, [completed.row]);
  assert.deepEqual((await request('/files')).body.files, [completed.file]);
  assert.equal(await readFile(join(directory, completed.file.name), 'utf8'), fileBytes(completed.row));
  assert.deepEqual(await files(directory).list(), await volume.list(), 'reopened volume retains bytes and manifest');
  const html = await (await fetch(web)).text();
  assert.match(html, /Visible message/);
  assert.match(html, /web-job/);
  assert.match(html, /from the web/);
  for (const path of ['/health/live', '/health/ready', '/version', '/internal/jobs', '/internal/checkpoint', '/internal/restore']) {
    assert.equal((await fetch(web + path)).status, 404);
  }
  const synthetic = await workOnce(store, configuration('worker', env));
  assert.match(synthetic.row.id, /^synthetic-/);
  assert.equal(synthetic.row.sequence, 2);
});

test('private worker requests authenticate, errors and files never disclose the credential', async (t) => {
  const { env, request, store, directory } = await setup(t);
  const output = [];
  t.mock.method(console, 'error', (...args) => output.push(args.join(' ')));
  for (const token of ['', 'invalid', env.EXAMPLE_TOKEN + '-wrong']) {
    for (const [path, value] of [['/internal/jobs', undefined], ['/internal/jobs', { id: 'denied', payload: '' }], ['/internal/complete', { sequence: 1 }], ['/internal/checkpoint', metadata], ['/internal/restore', {}]]) {
      const response = await request(path, value, token);
      assert.equal(response.status, 401);
      output.push(JSON.stringify(response));
    }
  }
  assert.equal((await request('/internal/jobs')).status, 200);
  assert.equal((await request('/jobs', { id: 'leak', payload: env.EXAMPLE_TOKEN })).status, 400);
  assert.equal((await request('/jobs', { id: 'safe', payload: 'public bytes' })).status, 202);
  await workOnce(store, configuration('worker', env));
  const original = store.rows;
  store.rows = async () => { throw new Error(env.EXAMPLE_TOKEN + env.DATABASE_URL); };
  output.push(JSON.stringify(await request('/ledger')));
  store.rows = original;
  for (const path of ['/ledger', '/files', '/health/live', '/health/ready', '/version']) output.push(JSON.stringify(await request(path)));
  for (const name of await readdir(directory)) output.push(await readFile(join(directory, name), 'utf8'));
  assert.equal(output.join('\n').includes(env.EXAMPLE_TOKEN), false);
  assert.equal(output.join('\n').includes(env.DATABASE_URL), false);
});

test('failed SQL commit is not acknowledged; retry reconciles interrupted file completion without another row', async (t) => {
  const { env, store, request, volume, directory } = await setup(t);
  await request('/jobs', { id: 'retry', payload: 'immutable' });
  store.failCommit = true;
  await assert.rejects(workOnce(store, configuration('worker', env)));
  assert.deepEqual(await store.rows(), []);
  store.failCommit = false;
  const write = volume.write;
  volume.write = async (row) => { await write(row); throw new Error('interrupted after durable rename'); };
  await assert.rejects(workOnce(store, configuration('worker', env)));
  assert.equal((await store.rows()).length, 1);
  assert.equal((await request('/internal/jobs')).body.job.id, 'retry');
  volume.write = write;
  const completed = await workOnce(store, configuration('worker', env));
  assert.equal(completed.row.sequence, 1);
  assert.equal((await store.rows()).length, 1);
  assert.equal((await request('/internal/jobs')).body.job, null);
  // An interrupted temporary write is recoverable from its committed row.
  const second = await writeLedger(store, { id: 'temporary', payload: 'complete bytes' });
  await writeFile(join(directory, `.${fileName(second.sequence)}.tmp`), 'partial');
  assert.equal((await request('/internal/complete', { sequence: 2 })).status, 200);
  assert.equal(await readFile(join(directory, fileName(2)), 'utf8'), fileBytes(second));
  await writeFile(join(directory, fileName(2)), 'wrong bytes');
  assert.equal((await request('/internal/complete', { sequence: 2 })).status, 503);
  assert.equal(await readFile(join(directory, fileName(2)), 'utf8'), 'wrong bytes', 'never overwrites corrupt immutable history');
});

test('barrier drains incomplete files and blocks new ledger commits while capturing an independent manifest', async (t) => {
  const { store, request, volume } = await setup(t);
  await writeLedger(store, { id: 'first', payload: 'one' });
  let entered, release;
  const enteredPromise = new Promise((resolve) => { entered = resolve; });
  const released = new Promise((resolve) => { release = resolve; });
  const write = volume.write;
  volume.write = async (row) => { entered(); await released; return write(row); };
  const checkpoint = request('/internal/checkpoint', metadata);
  await enteredPromise;
  let committed = false;
  const pending = writeLedger(store, { id: 'second', payload: 'two' }).then(() => { committed = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(committed, false);
  release();
  const result = await checkpoint;
  await pending;
  assert.equal(result.status, 200);
  assert.equal(result.body.watermark, 1);
  assert.equal(result.body.files.length, 1);
  assert.equal((await store.rows()).length, 2);
  assert.equal((await request('/internal/restore', result.body)).status, 409, 'post-barrier row is outside selected prefix');
});

test('restore accepts exactly the complete prefix and rejects missing middle rows, corruption, and extra files', async (t) => {
  const { store, request, directory } = await setup(t);
  for (let i = 1; i <= 3; i++) await writeLedger(store, { id: `job-${i}`, payload: `payload-${i}` });
  const { status, body: manifest } = await request('/internal/checkpoint', metadata);
  assert.equal(status, 200);
  const restored = await mkdtemp(join(tmpdir(), 'daisy-restore-'));
  t.after(() => rm(restored, { recursive: true, force: true }));
  await cp(directory, restored, { recursive: true });
  const copy = files(restored);
  assert.equal((await verifyPrefix(manifest, structuredClone(manifest.rows), copy)).status, 'complete-prefix');
  assert.equal((await request('/internal/restore', manifest)).status, 200);
  await assert.rejects(verifyPrefix(manifest, [manifest.rows[0], manifest.rows[2]], copy), /row count/);
  const missingMiddle = [manifest.rows[0], manifest.rows[2], manifest.rows[2]];
  await assert.rejects(verifyPrefix(manifest, missingMiddle, copy), /ledger prefix/);
  const changed = structuredClone(manifest.rows); changed[1].payload = 'corrupt';
  await assert.rejects(verifyPrefix(manifest, changed, copy), /ledger prefix/);
  await writeFile(join(restored, fileName(2)), 'wrong file');
  await assert.rejects(verifyPrefix(manifest, manifest.rows, copy), /file prefix/);
  await writeFile(join(restored, fileName(2)), fileBytes(manifest.rows[1]));
  await writeFile(join(restored, fileName(4)), 'unexplained');
  await assert.rejects(verifyPrefix(manifest, manifest.rows, copy), /file manifest/);
  await rm(join(restored, fileName(4)));
  await rm(join(restored, fileName(2)));
  await assert.rejects(verifyPrefix(manifest, manifest.rows, copy), /ENOENT/);
  await assert.rejects(verifyPrefix({ ...manifest, watermark: 4 }, manifest.rows, copy), /Invalid recovery/);
});

test('database hold fences all writers across API instances, counts refusals, and releases explicitly', async (t) => {
  const { store, request, env, volume } = await setup(t);
  await request('/jobs', { id: 'queued', payload: 'later' });
  const row = await writeLedger(store, { id: 'prefix', payload: 'one' });
  const { status, body: manifest } = await request('/internal/checkpoint', { ...metadata, hold: true });
  assert.equal(status, 200);
  assert.equal(manifest.held, true);
  assert.equal(manifest.watermark, 1);
  assert.equal(Object.hasOwn(manifest, 'ledger_hold'), false);
  const frozen = { error: 'EXAMPLE_FROZEN', checkpointId: manifest.checkpointId };
  for (const [path, input] of [
    ['/jobs', { id: 'blocked', payload: '' }],
    ['/internal/jobs', { id: 'blocked', payload: '' }],
    ['/internal/complete', { sequence: row.sequence }],
    ['/internal/checkpoint', metadata],
  ]) assert.deepEqual(await request(path, input), { status: 423, body: frozen });
  await assert.rejects(writeLedger(store, { id: 'direct', payload: '' }), (error) => error.status === 423 && error.checkpointId === manifest.checkpointId);
  assert.deepEqual(await request('/internal/checkpoint', { ...metadata, hold: true }), { status: 409, body: frozen });
  assert.deepEqual(await request('/internal/checkpoint/release', { checkpointId: 'wrong' }), { status: 409, body: frozen });
  assert.equal((await request('/internal/checkpoint/release', { checkpointId: manifest.checkpointId }, 'wrong')).status, 401);
  for (const path of ['/ledger', '/files', '/internal/jobs']) assert.equal((await request(path)).status, 200);
  assert.equal((await request('/internal/restore', manifest)).status, 200);
  assert.deepEqual(await store.rows(), manifest.rows);
  assert.deepEqual(await volume.list(), manifest.files);
  // Recreating the API cannot thaw shared database state.
  const restarted = await serve(t, createApi(env, { postgres: async () => {}, files: volume.ready }, store, volume));
  const response = await fetch(restarted + '/jobs', { method: 'POST', body: JSON.stringify({ id: 'restart', payload: '' }) });
  assert.equal(response.status, 423);
  assert.deepEqual(await response.json(), frozen);
  assert.deepEqual(await request('/internal/checkpoint/release', { checkpointId: manifest.checkpointId }), {
    status: 200, body: { checkpointId: manifest.checkpointId, refusedWrites: 7 },
  });
  assert.equal((await workOnce(store, configuration('worker', env))).row.id, 'queued');
  assert.equal((await request('/jobs', { id: 'thawed', payload: '' })).status, 202);
  assert.equal((await request('/internal/checkpoint', metadata)).body.held, false);
  assert.equal((await request('/internal/checkpoint/release', { checkpointId: manifest.checkpointId })).status, 409);
});

test('hold commits atomically with checkpoint and fences a waiting direct writer', async (t) => {
  const { store, request, volume } = await setup(t);
  await writeLedger(store, { id: 'prefix', payload: '' });
  store.failCommit = true;
  assert.equal((await request('/internal/checkpoint', { ...metadata, hold: true })).status, 503);
  store.failCommit = false;
  await writeLedger(store, { id: 'after-failed-hold', payload: '' });
  let entered, release;
  const entering = new Promise((resolve) => { entered = resolve; });
  const waiting = new Promise((resolve) => { release = resolve; });
  const write = volume.write;
  volume.write = async (row) => { entered(); await waiting; return write(row); };
  const checkpoint = request('/internal/checkpoint', { ...metadata, hold: true });
  await entering;
  const refused = assert.rejects(writeLedger(store, { id: 'waiting', payload: '' }), (error) => error.status === 423);
  release();
  const { body: manifest } = await checkpoint;
  await refused;
  assert.equal(manifest.watermark, 2);
  assert.equal((await request('/internal/restore', manifest)).status, 200);
  assert.equal((await request('/internal/checkpoint/release', { checkpointId: manifest.checkpointId })).body.refusedWrites, 1);
});

test('worker retries database and API holds through its normal loop without losing queued work', async (t) => {
  const { store, request, env } = await setup(t);
  const config = configuration('worker', env);
  // An empty FIFO attempts synthetic enqueue and receives HTTP 423.
  let manifest = (await request('/internal/checkpoint', { ...metadata, hold: true })).body;
  assert.equal(await workOnce(store, config), undefined);
  assert.equal(await store.nextJob(), null);
  assert.equal((await request('/internal/checkpoint/release', { checkpointId: manifest.checkpointId })).body.refusedWrites, 1);
  await request('/jobs', { id: 'retained', payload: '' });
  manifest = (await request('/internal/checkpoint', { ...metadata, hold: true })).body;
  for (let i = 0; i < 2; i++) assert.equal(await workOnce(store, config), undefined);
  assert.equal((await store.nextJob()).id, 'retained');
  assert.deepEqual(await store.rows(), []);
  assert.equal((await request('/internal/checkpoint/release', { checkpointId: manifest.checkpointId })).body.refusedWrites, 2);
  // Hold after the direct SQL commit, before the HTTP completion call.
  const transaction = store.transaction.bind(store);
  let intercept = true;
  store.transaction = async (...args) => {
    const result = await transaction(...args);
    if (intercept && result?.id === 'retained') {
      intercept = false;
      manifest = (await request('/internal/checkpoint', { ...metadata, hold: true })).body;
    }
    return result;
  };
  assert.equal(await workOnce(store, config), undefined);
  assert.equal((await store.rows()).length, 1);
  assert.equal((await request('/internal/checkpoint/release', { checkpointId: manifest.checkpointId })).body.refusedWrites, 1);
  // Checkpoint already completed the retained row; retrying its completion is safe.
  assert.equal((await request('/internal/complete', { sequence: 1 })).status, 200);
  assert.equal(await store.nextJob(), null);
  assert.equal((await workOnce(store, config)).row.sequence, 2);
});

test('checkpoint hold and release reject malformed inputs explicitly', async (t) => {
  const { request } = await setup(t);
  for (const hold of [null, 'true', 1, {}]) assert.equal((await request('/internal/checkpoint', { ...metadata, hold })).status, 400);
  for (const input of [{}, { checkpointId: '' }, { checkpointId: 1 }, null]) assert.equal((await request('/internal/checkpoint/release', input)).status, 400);
  assert.equal((await request('/internal/checkpoint', { ...metadata, hold: false })).body.held, false);
});
