import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile, writeFile, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createWeb } from '../services/web/main.mjs';
import { createApi } from '../services/api/main.mjs';
import { createWorker } from '../services/worker/main.mjs';
import { applicationHandler, configuration } from '../services/common.mjs';
import { faults, MAX_LATENCY_MS, MAX_CRASHES } from '../services/faults.mjs';
import { files, verifyPrefix } from '../services/api/files.mjs';
import { memoryStore } from './support/store.mjs';

const metadata = () => ({ actor: 'operator-one', runId: 'fault-unit', operationId: randomUUID(), targetScope: 'isolated-unit',
  imageDigest: `sha256:${'b'.repeat(64)}`, expiresAt: new Date(Date.now() + 60000).toISOString() });
async function serve(t, handler) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}`;
}
async function setup(t, service = 'api', overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'daisy-fault-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const env = { SOURCE_REVISION: 'a'.repeat(40), EXAMPLE_TOKEN: randomBytes(24).toString('hex'), FILES_PATH: directory,
    DATABASE_URL: 'postgresql://fixture:unused@postgres/example', API_URL: 'http://api:9090', EXAMPLE_MESSAGE: 'Example',
    FAULT_FILL_CAP_BYTES: '1048576', FAULT_FILL_FLOOR_BYTES: '1048576', ...overrides };
  const output = [], exits = [];
  const config = configuration(service, env);
  const control = faults(service, config, { log: (line) => output.push(line), exit: (code) => exits.push(code) });
  await control.start();
  t.after(() => control.close());
  const volume = files(directory), store = memoryStore();
  const dependencies = { api: async () => {}, postgres: async () => {}, files: volume.ready };
  const handler = service === 'api' ? createApi(env, { postgres: dependencies.postgres, files: dependencies.files }, store, volume, control)
    : service === 'web' ? createWeb(env, { api: dependencies.api }, control) : createWorker(env, { api: dependencies.api, postgres: dependencies.postgres }, control);
  const url = await serve(t, handler), publicUrl = await serve(t, applicationHandler(handler));
  const request = async (path = '/faults', value, token = env.EXAMPLE_TOKEN, origin = url) => {
    const response = await fetch(origin + path, { method: value === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${token}` },
      ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
    const text = await response.text();
    output.push(text);
    return { status: response.status, body: JSON.parse(text) };
  };
  return { env, config, directory, output, exits, control, request, store, volume, url, publicUrl };
}

for (const service of ['web', 'api', 'worker']) {
  test(`${service}: unauthorized fault controls are observable, immutable, private, and secret-free`, async (t) => {
    const f = await setup(t, service);
    for (const token of ['', 'invalid', f.env.EXAMPLE_TOKEN + '-wrong']) {
      for (const [path, value] of [['/faults', undefined], ['/faults', { ...metadata(), fault: 'crash', mode: 'immediate' }], ['/faults/reset', metadata()]]) {
        assert.equal((await f.request(path, value, token)).status, 401);
      }
    }
    let status = (await f.request()).body;
    assert.equal(status.active, null);
    assert.equal(status.lastSet, null);
    assert.match(status.denial.reason, /Unauthorized/);
    assert.ok(f.output.some((line) => line.includes('fault-denied')));
    for (const path of ['/faults', '/faults/reset', '/faults?x=1', '/internal/jobs', '/health/ready']) {
      assert.equal((await f.request(path, metadata(), f.env.EXAMPLE_TOKEN, f.publicUrl)).status, 404);
    }
    for (const field of ['actor', 'runId', 'operationId', 'targetScope', 'extra']) {
      assert.equal((await f.request('/faults', { ...metadata(), [field]: f.env.EXAMPLE_TOKEN, fault: 'latency', ms: 10 })).status, 400);
    }
    assert.equal((await f.request('/faults', { ...metadata(), expiresAt: new Date(Date.now() - 1000).toISOString(), fault: 'crash', mode: 'immediate' })).status, 400);
    assert.equal((await f.request('/faults', { ...metadata(), expiresAt: new Date(Date.now() + 3000010).toISOString(), fault: 'latency', ms: 10 })).status, 400);
    assert.equal((await f.request('/faults', { ...metadata(), fault: 'latency', ms: 20 })).status, 202);
    assert.equal((await f.request('/faults/reset', metadata(), 'wrong')).status, 401);
    assert.equal((await f.request()).body.active.fault, 'latency');
    assert.equal((await f.request('/faults/reset', metadata())).status, 200);
    for (const name of await readdir(f.directory)) f.output.push(await readFile(join(f.directory, name), 'utf8'));
    assert.equal(f.output.join('\n').includes(f.env.EXAMPLE_TOKEN), false);
    assert.deepEqual(f.exits, []);
  });

  test(`${service}: latency has a measured symptom, hard bound, audited reset, and honest health`, async (t) => {
    const f = await setup(t, service);
    for (const ms of [0, -1, 1.1, MAX_LATENCY_MS + 1, '100']) assert.equal((await f.request('/faults', { ...metadata(), fault: 'latency', ms })).status, 400);
    assert.equal((await f.request('/faults', { ...metadata(), fault: 'latency', ms: MAX_LATENCY_MS })).status, 202);
    assert.equal((await f.request()).body.active.parameters.ms, MAX_LATENCY_MS);
    await f.request('/faults/reset', metadata());
    const set = (await f.request('/faults', { ...metadata(), fault: 'latency', ms: 100 })).body;
    assert.equal(set.active.actor, 'operator-one');
    assert.ok(set.active.setAt);
    assert.equal((await f.request('/health/live')).status, 200);
    const ready = await f.request('/health/ready');
    assert.equal(ready.status, 503);
    assert.equal(ready.body.reason, 'fault:latency');
    let started = performance.now();
    await f.request('/unrecognized');
    assert.ok(performance.now() - started >= 90);
    if (service === 'worker') {
      started = performance.now(); await f.control.beforeWork(); assert.ok(performance.now() - started >= 90);
    }
    assert.equal((await f.request('/faults', { ...metadata(), fault: 'crash', mode: 'immediate' })).status, 409);
    const reset = (await f.request('/faults/reset', { ...metadata(), actor: 'operator-two' })).body;
    assert.equal(reset.active, null);
    assert.equal(reset.lastReset.resetActor, 'operator-two');
    assert.equal(reset.lastReset.operationId, set.active.operationId);
    assert.ok(Date.parse(reset.lastReset.resetAt) >= Date.parse(set.active.setAt));
    assert.equal((await f.request('/health/ready')).status, 200);
    assert.ok(f.output.some((line) => line.includes('fault-set')));
    assert.ok(f.output.some((line) => line.includes('fault-reset')));
  });

  test(`${service}: next-request crash can be reset; immediate crash exits once and records completion`, async (t) => {
    const f = await setup(t, service);
    assert.equal((await f.request('/faults', { ...metadata(), fault: 'crash', mode: 'next-request' })).status, 202);
    assert.equal((await f.request('/health/ready')).body.reason, 'fault:crash');
    assert.deepEqual(f.exits, []);
    await f.request('/faults/reset', metadata());
    await f.request('/unrecognized');
    assert.deepEqual(f.exits, []);
    await f.request('/faults', { ...metadata(), fault: 'crash', mode: 'next-request' });
    await f.request('/unrecognized');
    assert.deepEqual(f.exits, [1]);
    // A real process ends at this point; create a fresh controller for immediate mode.
    const fresh = faults(service, f.config, { exit: (code) => f.exits.push(code), log: (line) => f.output.push(line) });
    await fresh.start(); t.after(() => fresh.close());
    const origin = await serve(t, fresh.wrap(async (_req, res) => { res.end('{}'); }));
    await f.request('/faults', { ...metadata(), fault: 'crash', mode: 'immediate' }, f.env.EXAMPLE_TOKEN, origin);
    for (let i = 0; i < 100 && f.exits.length < 2; i++) await delay(10);
    assert.deepEqual(f.exits, [1, 1]);
    assert.equal(fresh.status().active, null);
    assert.equal(fresh.status().lastReset.reason, 'one-shot-complete');
    assert.equal(f.output.join('\n').includes(f.env.EXAMPLE_TOKEN), false);
  });
}

test('API database-down refuses pool use by name, preserves committed rows, and resets', async (t) => {
  const f = await setup(t);
  await f.request('/jobs', { id: 'retained', payload: 'safe' });
  let calls = 0;
  const original = f.store.rows;
  f.store.rows = async () => { calls++; return original(); };
  assert.equal((await f.request('/faults', { ...metadata(), fault: 'database-down' })).status, 202);
  assert.equal((await f.request('/health/ready')).body.reason, 'EXAMPLE_DATABASE_DOWN');
  assert.equal((await f.request('/health/live')).status, 200);
  assert.deepEqual(await f.request('/ledger'), { status: 503, body: { error: 'EXAMPLE_DATABASE_DOWN' } });
  assert.equal((await f.request('/internal/jobs')).status, 503);
  assert.equal(calls, 0, 'fault refuses the store before acquiring a pool connection');
  await f.request('/faults/reset', metadata());
  assert.equal((await f.request('/ledger')).status, 200);
  assert.equal((await f.request('/internal/jobs')).body.job.id, 'retained');
  assert.equal((await f.request('/health/ready')).status, 200);
});

test('API bounded disk fill preserves the ledger manifest and resets after process restart', async (t) => {
  const f = await setup(t);
  for (const bytes of [0, -1, 1.5, 1048577, '100']) assert.equal((await f.request('/faults', { ...metadata(), fault: 'disk-full', bytes })).status, 400);
  const set = await f.request('/faults', { ...metadata(), fault: 'disk-full', bytes: 1048576 });
  assert.equal(set.status, 202);
  assert.equal(set.body.active.parameters.writtenBytes, 1048576);
  assert.equal((await stat(join(f.directory, '.fault-api.fill'))).size, 1048576);
  assert.equal((await f.request('/health/ready')).body.reason, 'fault:disk-full');
  assert.equal((await f.request('/health/live')).status, 200);
  assert.deepEqual(await f.volume.list(), []);
  await verifyPrefix({ format: 1, checkpointId: 'unchanged', watermark: 0, rows: [], files: [] }, [], f.volume);
  const restarted = faults('api', f.config, { log: (line) => f.output.push(line) });
  await restarted.start(); t.after(() => restarted.close());
  assert.equal(restarted.status().active.parameters.writtenBytes, 1048576);
  const origin = await serve(t, restarted.wrap(async (_req, res) => res.end('{}')));
  const reset = await f.request('/faults/reset', metadata(), f.env.EXAMPLE_TOKEN, origin);
  assert.equal(reset.status, 200);
  await assert.rejects(stat(join(f.directory, '.fault-api.fill')), { code: 'ENOENT' });
  assert.equal(restarted.reason(), null);
  await writeFile(join(f.directory, 'unexpected'), 'preserve me');
  await assert.rejects(f.volume.list(), /Unexpected file/);
  assert.equal(await readFile(join(f.directory, 'unexpected'), 'utf8'), 'preserve me');
  for (const name of await readdir(f.directory)) f.output.push(await readFile(join(f.directory, name), 'utf8'));
  assert.equal(f.output.join('\n').includes(f.env.EXAMPLE_TOKEN), false);
});

test('disk fill refuses the required free-space floor and leaves a resettable named symptom', async (t) => {
  const f = await setup(t, 'api', { FAULT_FILL_FLOOR_BYTES: String(Number.MAX_SAFE_INTEGER) });
  const response = await f.request('/faults', { ...metadata(), fault: 'disk-full', bytes: 100 });
  assert.equal(response.status, 503);
  assert.equal(response.body.active.parameters.writtenBytes, 0);
  await assert.rejects(stat(join(f.directory, '.fault-api.fill')), { code: 'ENOENT' });
  assert.equal((await f.request('/health/ready')).body.reason, 'fault:disk-full:fill-failed');
  assert.equal((await f.request('/faults/reset', metadata())).status, 200);
  assert.equal((await f.request('/health/ready')).status, 200);
});

test('leases automatically reset latency and disk fill with bounded audit storage', async (t) => {
  const f = await setup(t);
  for (const fault of [{ fault: 'latency', ms: 10 }, { fault: 'disk-full', bytes: 1024 }]) {
    assert.equal((await f.request('/faults', { ...metadata(), ...fault, expiresAt: new Date(Date.now() + 100).toISOString() })).status, 202);
    await delay(160);
    assert.equal((await f.request()).body.active, null);
    assert.equal((await f.request()).body.lastReset.reason, 'expired');
    assert.equal((await f.request('/health/ready')).status, 200);
  }
  assert.ok((await stat(join(f.directory, '.fault-api.json'))).size < 8192);
  assert.deepEqual(await readdir(f.directory), ['.fault-api.json']);
});

test('missing bounds and malformed fault state fail specifically without deleting existing bytes', async (t) => {
  const f = await setup(t);
  for (const key of ['FAULT_FILL_CAP_BYTES', 'FAULT_FILL_FLOOR_BYTES']) {
    for (const value of [undefined, '', '0', '-1', '1.5', '9007199254740992']) assert.throws(() => configuration('api', { ...f.env, [key]: value }), new RegExp(key));
  }
  assert.throws(() => configuration('api', { ...f.env, FAULT_FILL_CAP_BYTES: '67108865' }), /FAULT_FILL_CAP_BYTES/);
  const path = join(f.directory, '.fault-api.json');
  await writeFile(path, '{broken');
  await assert.rejects(faults('api', f.config).start(), /Invalid fault record/);
  assert.equal(await readFile(path, 'utf8'), '{broken');
  await rm(path);
  const outside = join(f.directory, 'existing-data');
  await writeFile(outside, 'preserve');
  await symlink(outside, path);
  await assert.rejects(faults('api', f.config).start(), /Invalid fault record/);
  assert.equal(await readFile(outside, 'utf8'), 'preserve');
});

test('crash loops exit nonzero in real child processes at most three times, then reset', async (t) => {
  const f = await setup(t, 'web');
  for (const starts of [0, MAX_CRASHES + 1, 1.5]) assert.equal((await f.request('/faults', { ...metadata(), fault: 'crash-loop', starts })).status, 400);
  // Child processes receive secrets only in their environment, never command arguments or output.
  const script = `import { faults } from ${JSON.stringify(new URL('../services/faults.mjs', import.meta.url).href)};
    import { configuration } from ${JSON.stringify(new URL('../services/common.mjs', import.meta.url).href)};
    import { createServer } from 'node:http';
    const control = faults('web', configuration('web', process.env));
    if (await control.start()) {
      const server = createServer(control.wrap((_req, res) => res.end('{}')));
      server.listen(0, '127.0.0.1', () => process.send({ port: server.address().port, status: control.status() }));
    }`;
  const launch = () => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, ...f.env }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    const output = [];
    child.stdout.on('data', (chunk) => output.push(chunk.toString()));
    child.stderr.on('data', (chunk) => output.push(chunk.toString()));
    const ended = once(child, 'exit');
    t.after(() => { if (child.exitCode === null) child.kill(); });
    return { child, ended, output };
  };
  let run = launch();
  let [message] = await once(run.child, 'message');
  assert.equal((await f.request('/faults', { ...metadata(), fault: 'crash-loop', starts: 3 }, f.env.EXAMPLE_TOKEN, `http://127.0.0.1:${message.port}`)).status, 202);
  assert.equal((await run.ended)[0], 1);
  f.output.push(...run.output);
  for (let i = 0; i < 2; i++) { run = launch(); assert.equal((await run.ended)[0], 1); f.output.push(...run.output); }
  run = launch();
  [message] = await once(run.child, 'message');
  assert.equal(message.status.active, null);
  assert.equal(message.status.lastReset.reason, 'crash-loop-complete');
  run.child.kill(); await run.ended;
  f.output.push(...run.output);
  assert.equal(f.output.join('\n').includes(f.env.EXAMPLE_TOKEN), false);
  const saved = JSON.parse(await readFile(join(f.directory, '.fault-web.json'), 'utf8'));
  assert.equal(saved.active, null);
  assert.equal(saved.lastReset.parameters.remaining, 0);
});

test('disk reset preserves an unexpected filler and other services audit records', async (t) => {
  const f = await setup(t);
  const filler = join(f.directory, '.fault-api.fill');
  await writeFile(filler, 'existing bytes');
  await writeFile(join(f.directory, '.fault-web.json'), 'sibling evidence');
  const result = await f.request('/faults', { ...metadata(), fault: 'disk-full', bytes: 100 });
  assert.equal(result.status, 503);
  assert.equal(result.body.active.parameters.created, false);
  assert.equal((await f.request('/faults/reset', metadata())).status, 200);
  assert.equal(await readFile(filler, 'utf8'), 'existing bytes');
  assert.equal(await readFile(join(f.directory, '.fault-web.json'), 'utf8'), 'sibling evidence');
  await assert.rejects(faults('api', f.config).start(), /Unowned fault filler/);
});
