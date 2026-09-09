import test from 'node:test';
import assert from 'node:assert/strict';
import { createWeb } from '../services/web/main.mjs';
import { createApi } from '../services/api/main.mjs';
import { createWorker } from '../services/worker/main.mjs';
import { applicationHandler, configuration, httpReady } from '../services/common.mjs';

const env = {
  SOURCE_REVISION: 'a'.repeat(40), EXAMPLE_MESSAGE: 'Daisy example',
  DATABASE_URL: 'postgresql://fixture:unit-only@postgres/example', EXAMPLE_TOKEN: 'unit-only-marker', API_URL: 'http://api:9090', FILES_PATH: '/data',
};
const factories = { web: createWeb, api: createApi, worker: createWorker };
const dependencyNames = { web: ['api'], api: ['postgres', 'files'], worker: ['api', 'postgres'] };

async function invoke(handler, url, method = 'GET') {
  let status, headers, body;
  await handler({ method, url }, {
    writeHead(code, values) { status = code; headers = values; },
    end(value) { body = headers['content-type'].startsWith('text/html') ? value : JSON.parse(value); },
  });
  return { status, headers, body };
}

for (const [name, create] of Object.entries(factories)) {
  const dependencies = Object.fromEntries(dependencyNames[name].map((key) => [key, async () => {}]));
  test(`${name}: liveness, readiness and source version`, async () => {
    const handler = create(env, dependencies);
    assert.equal((await invoke(handler, '/health/live')).status, 200);
    const ready = await invoke(handler, '/health/ready');
    assert.equal(ready.status, 200);
    assert.deepEqual(Object.keys(ready.body.dependencies), dependencyNames[name]);
    const version = await invoke(handler, '/version');
    assert.deepEqual(version.body, { service: name, version: '1.0.0', sourceRevision: env.SOURCE_REVISION });
    assert.equal(version.headers['cache-control'], 'no-store');
    assert.equal((await invoke(handler, '/unknown')).status, 404);
    assert.equal((await invoke(handler, '/health/live', 'POST')).status, 405);
  });
  for (const dependency of dependencyNames[name]) {
    test(`${name}: ${dependency} outage fails readiness but keeps liveness, without leaking credentials`, async () => {
      const handler = create(env, { ...dependencies, [dependency]: async () => { throw new Error(env.DATABASE_URL + env.EXAMPLE_TOKEN); } });
      const ready = await invoke(handler, '/health/ready');
      assert.equal(ready.status, 503);
      assert.equal(ready.body.dependencies[dependency], 'unavailable');
      assert.equal((await invoke(handler, '/health/live')).status, 200);
      assert.equal(JSON.stringify(ready).includes(env.EXAMPLE_TOKEN), false);
      assert.equal(JSON.stringify(ready).includes(env.DATABASE_URL), false);
    });
  }
  test(`${name}: missing readiness probe is a configuration error`, () => {
    assert.throws(() => create(env, {}), /Missing required readiness probe/);
  });
  for (const key of ['SOURCE_REVISION', ...(name === 'web' ? ['EXAMPLE_MESSAGE', 'API_URL'] : name === 'api' ? ['DATABASE_URL', 'EXAMPLE_TOKEN', 'FILES_PATH'] : ['DATABASE_URL', 'EXAMPLE_TOKEN', 'API_URL'])]) {
    test(`${name}: missing ${key} fails specifically`, () => {
      for (const value of [undefined, '', '   ']) assert.throws(() => create({ ...env, [key]: value }, dependencies), new RegExp(`Missing required configuration: ${key}`));
    });
  }
}

test('web renders the approved nonsecret message and API answer', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ service: 'api', rows: [{ id: 'visible-job' }] })));
  const handler = createWeb(env, { api: async () => {} });
  assert.match((await invoke(handler, '/')).body, /Daisy example/);
  assert.match((await invoke(handler, '/')).body, /visible-job/);
  const changed = createWeb({ ...env, EXAMPLE_MESSAGE: 'Changed binding' }, { api: async () => {} });
  assert.match((await invoke(changed, '/')).body, /Changed binding/);
});

test('application ingress cannot expose management endpoints', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ service: 'api', rows: [] })));
  const handler = applicationHandler(createWeb(env, { api: async () => {} }));
  for (const path of ['/health/live', '/health/ready', '/version', '/version?x=1']) {
    assert.equal((await invoke(handler, path)).status, 404);
  }
  assert.equal((await invoke(handler, '/')).status, 200);
});

test('invalid configuration fails without exposing its value', () => {
  assert.throws(() => configuration('api', { ...env, DATABASE_URL: env.EXAMPLE_TOKEN }), { message: 'Invalid DATABASE_URL' });
  assert.throws(() => configuration('api', { ...env, DATABASE_URL: 'https://postgres/example' }), /Invalid DATABASE_URL/);
  assert.throws(() => configuration('web', { ...env, SOURCE_REVISION: 'main' }), /Invalid SOURCE_REVISION/);
});

test('HTTP readiness checks response status and application identity', async (t) => {
  const mock = t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ service: 'api', status: 'ready' })));
  await httpReady('http://api:8081/health/ready', 'api');
  assert.equal(mock.mock.calls[0].arguments[1].redirect, 'error');
  assert.ok(mock.mock.calls[0].arguments[1].signal instanceof AbortSignal);
  mock.mock.mockImplementation(async () => new Response(JSON.stringify({ service: 'web', status: 'ready' })));
  await assert.rejects(httpReady('http://api:8081/health/ready', 'api'), /identity mismatch/);
  mock.mock.mockImplementation(async () => new Response('', { status: 503 }));
  await assert.rejects(httpReady('http://api:8081/health/ready', 'api'), /unavailable/);
});
