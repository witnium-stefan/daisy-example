import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compose, generate, services, validateCompose } from '../scripts/compose.mjs';
import { verifyVisibility } from '../scripts/verify-visibility.mjs';

// Synthetic digests are confined to tests; deployment output uses build metadata.
const digests = Object.fromEntries(services.map((name, i) => [name, `sha256:${String(i + 1).repeat(64)}`]));

test('publish workflow only references runner context within job steps', async () => {
  const workflow = await readFile(new URL('../.github/workflows/publish.yml', import.meta.url), 'utf8');
  let inJobs = false;
  let inSteps = false;
  let jobs = 0;
  let steps = 0;
  for (const [index, line] of workflow.split('\n').entries()) {
    if (/^\S/.test(line)) {
      inJobs = line === 'jobs:';
      inSteps = false;
    }
    if (inJobs && /^  [\w-]+:\s*$/.test(line)) {
      inSteps = false;
      jobs++;
    }
    if (inJobs && /^    steps:\s*$/.test(line)) {
      inSteps = true;
      steps++;
    }
    if (!inSteps) assert.ok(!line.includes('runner.'), `Runner context outside steps at line ${index + 1}: ${line}`);
  }
  assert.ok(jobs > 0, 'Expected publish jobs');
  assert.equal(steps, jobs, 'Expected steps in every publish job');
});

test('generated Compose has exactly the reviewed intake shape', () => {
  const source = compose(digests);
  assert.deepEqual(validateCompose(source), digests);
  assert.match(source, /name: daisy-example\nservices:\n/);
  assert.match(source, /ports: \["8080"\]\n    depends_on: \[api\]\n    environment: \[EXAMPLE_MESSAGE\]/);
  assert.match(source, /ports: \["8081"\]\n    depends_on: \[postgres\]/);
  assert.match(source, /ports: \["8082"\]\n    depends_on: \[api, postgres\]/);
  assert.match(source, /environment: \[DATABASE_URL, EXAMPLE_SHARED_SECRET\]/);
  assert.match(source, /volumes: \["files:\/data"\]/);
  assert.match(source, /ports: \["5432"\]\n    environment: \[POSTGRES_PASSWORD\]/);
  assert.match(source, /volumes: \["database:\/var\/lib\/postgresql\/data"\]/);
  assert.ok(source.endsWith('volumes:\n  files: {}\n  database: {}\n'));
});

test('Compose rejects non-GHCR images, mutable references and unsupported keys', () => {
  const source = compose(digests);
  const invalid = [
    source.replace('ghcr.io', 'docker.io'),
    source.replace('daisy-example-web@', 'daisy-example-web:latest@'),
    source.replace(`@${digests.web}`, ':latest'),
    source.replace(digests.web, 'sha256:short'),
    source.replace('EXAMPLE_MESSAGE]', 'EXAMPLE_MESSAGE=value]'),
    source.replace('EXAMPLE_MESSAGE]', '${EXAMPLE_MESSAGE}]'),
    source.replace('files:/data', './files:/data'),
    source.replace('depends_on: [api]', 'depends_on: [worker]'),
    source.replace('"8080"', '"80:8080"'),
    source.replace('  database: {}\n', ''),
    source + '---\nname: unexpected\n',
    ...['build: .', 'healthcheck: {}', 'secrets: []', 'deploy: {}', 'image: duplicate'].map((field) => source.replace('  web:\n', `  web:\n    ${field}\n`)),
  ];
  for (const changed of invalid) assert.throws(() => validateCompose(changed));
  assert.throws(() => compose({ ...digests, extra: digests.web }), /exactly/);
  assert.throws(() => compose({ ...digests, api: undefined }), /api/);
});

test('artifact is generated from actual build metadata, preserving source-to-digest evidence', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'daisy-compose-'));
  t.after(() => rm(directory, { recursive: true }));
  for (const name of services) await writeFile(join(directory, `${name}.json`), JSON.stringify({ 'containerimage.digest': digests[name] }));
  await generate(directory, 'b'.repeat(40));
  const artifact = await readFile(join(directory, 'docker-compose.yaml'), 'utf8');
  assert.deepEqual(validateCompose(artifact), digests);
  assert.deepEqual(JSON.parse(await readFile(join(directory, 'images.json'), 'utf8')), { sourceRevision: 'b'.repeat(40), digests });
  await assert.rejects(generate(directory, 'b'.repeat(40)), /EEXIST/);
});

test('missing configuration or metadata cannot yield a deployment artifact', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'daisy-missing-'));
  t.after(() => rm(directory, { recursive: true }));
  await assert.rejects(generate(directory, undefined), /SOURCE_REVISION/);
  await assert.rejects(generate(directory, 'b'.repeat(40)), /web.json/);
  for (const name of services) await writeFile(join(directory, `${name}.json`), '{}');
  await assert.rejects(generate(directory, 'b'.repeat(40)), /web/);
  assert.equal((await readdir(directory)).includes('docker-compose.yaml'), false);
});

function registry(publicNames, overrides = {}) {
  const calls = [];
  const request = async (url, options = {}) => {
    calls.push({ url, options });
    assert.ok(url.startsWith('https://ghcr.io/'));
    const name = /daisy-example-(web|api|worker|postgres)/.exec(decodeURIComponent(url))[1];
    const isToken = new URL(url).pathname === '/token';
    if (isToken) {
      assert.equal(options.headers?.authorization, undefined);
      return new Response(publicNames.includes(name) ? JSON.stringify({ token: 'anonymous-fixture' }) : '', { status: publicNames.includes(name) ? 200 : 403 });
    }
    if (overrides[name]) return new Response('', { status: overrides[name] });
    if (options.headers?.authorization) {
      assert.equal(options.headers.authorization, 'Bearer anonymous-fixture');
      return new Response('{}', { status: 200 });
    }
    return new Response('', { status: 401, headers: { 'www-authenticate': 'Bearer realm="https://ghcr.io/token",service="ghcr.io"' } });
  };
  return { request, calls };
}

test('visibility verification negotiates anonymous pulls and proves the private worker denial', async () => {
  const { request, calls } = registry(['web', 'api', 'postgres']);
  assert.deepEqual(await verifyVisibility(digests, request), { web: 200, api: 200, worker: 401, postgres: 200 });
  assert.equal(calls.filter(({ url }) => new URL(url).pathname === '/token').length, 4);
  assert.ok(calls.every(({ options }) => options.redirect === 'error'));
});

test('wrong visibility names the package and owner settings page', async () => {
  for (const [publicNames, name] of [[['api', 'postgres'], 'web'], [['web', 'api', 'worker', 'postgres'], 'worker'], [['web', 'api'], 'postgres']]) {
    await assert.rejects(verifyVisibility(digests, registry(publicNames).request), (error) => {
      assert.match(error.message, new RegExp(`daisy-example-${name}`));
      assert.ok(error.message.includes(`https://github.com/users/witnium/packages/container/daisy-example-${name}/settings`));
      return true;
    });
  }
});

test('404, registry errors, redirects and malformed challenges are never private-image success', async () => {
  for (const status of [404, 429, 500, 302]) {
    await assert.rejects(verifyVisibility(digests, registry(['web', 'api', 'postgres'], { worker: status }).request), /daisy-example-worker/);
  }
  await assert.rejects(verifyVisibility(digests, async () => new Response('', { status: 401 })), /daisy-example-web/);
});

test('Docker build sources pin base images and preserve the PostgreSQL mount contract', async () => {
  for (const name of services) {
    const path = name === 'postgres' ? '../postgres/Dockerfile' : `../services/${name}/Dockerfile`;
    const dockerfile = await readFile(new URL(path, import.meta.url), 'utf8');
    assert.match(dockerfile, /^FROM docker\.io\/library\/(node|postgres)@sha256:[a-f0-9]{64}$/m);
    if (name !== 'postgres') {
      assert.match(dockerfile, /USER node/);
      assert.match(dockerfile, /ENV SOURCE_REVISION=\$SOURCE_REVISION/);
    }
  }
});
