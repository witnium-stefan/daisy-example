import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, readdir, mkdir, copyFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compose, generate, services, validateCompose } from '../scripts/compose.mjs';
import { verifyVisibility } from '../scripts/verify-visibility.mjs';

// Synthetic digests are confined to tests; deployment output uses build metadata.
const digests = Object.fromEntries(services.map((name, i) => [name, `sha256:${String(i + 1).repeat(64)}`]));

async function composeCommitStep() {
  const workflow = await readFile(new URL('../.github/workflows/publish.yml', import.meta.url), 'utf8');
  const steps = workflow.split(/^      - /m);
  const verify = steps.findIndex(step => step.startsWith('name: Generate and verify deployment artifact\n'));
  const release = steps.findIndex(step => step.startsWith('name: Publish immutable release assets\n'));
  const commit = steps.findIndex(step => step.startsWith('name: Commit verified Compose to main\n'));
  assert.ok(verify > 0 && release > verify && commit > release);
  assert.match(steps[verify], /node scripts\/verify-visibility\.mjs release\/images.json/);
  assert.match(steps[release], /gh release create/);
  assert.match(steps[release], /release\/docker-compose.yaml/);
  for (const index of [verify, release, commit]) {
    assert.doesNotMatch(steps[index], /\bif:|continue-on-error:|\|\|\s*true/);
  }
  assert.equal(workflow.match(/^on:\n([\s\S]*?)\n\S/m)[1], '  workflow_dispatch:\n');
  assert.match(workflow, /permissions:\n      contents: write/);
  assert.match(steps[commit], /GH_TOKEN: \$\{\{ github.token \}\}/);
  return steps[commit].split('        run: |\n')[1].trimEnd().split('\n').map(line => line.slice(10)).join('\n');
}

test('workflow commits only after successful visibility verification and release publication', async () => {
  await composeCommitStep();
});

test('workflow checks in exact generator output on current main and skips unchanged content', async (t) => {
  const script = await composeCommitStep();
  const directory = await mkdtemp(join(tmpdir(), 'daisy-publish-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const remote = join(directory, 'remote.git');
  const source = join(directory, 'source');
  const bin = join(directory, 'bin');
  await mkdir(source);
  await mkdir(bin);
  // Only authentication is stubbed; every Git operation uses a local repository.
  await writeFile(join(bin, 'gh'), '#!/bin/sh\n[ "$*" = "auth setup-git" ]\n', { mode: 0o755 });
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid' };
  const git = (...args) => execFileSync('git', args, { cwd: source, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '--bare', '--initial-branch=main', remote);
  git('init', '--initial-branch=main');
  git('remote', 'add', 'origin', remote);
  await writeFile(join(source, 'README.md'), 'Reviewed source\n');
  git('add', 'README.md');
  git('commit', '-m', 'Reviewed source');
  const revision = git('rev-parse', 'HEAD');
  await writeFile(join(source, 'README.md'), 'Newer main content\n');
  git('commit', '-am', 'Advance main');
  const currentMain = git('rev-parse', 'HEAD');
  git('push', 'origin', 'main');
  git('checkout', '--detach', revision);
  await mkdir(join(source, 'scripts'));
  await copyFile(new URL('../scripts/compose.mjs', import.meta.url), join(source, 'scripts/compose.mjs'));
  const release = join(source, 'release');
  await mkdir(release);
  for (const name of services) await writeFile(join(release, `${name}.json`), JSON.stringify({ 'containerimage.digest': digests[name] }));
  await generate(release, revision);
  const artifact = await readFile(join(release, 'docker-compose.yaml'), 'utf8');
  const run = async (number) => {
    const runnerTemp = join(directory, `runner-${number}`);
    await mkdir(runnerTemp);
    return execFileSync('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', script], { cwd: source, env: { ...env, RUNNER_TEMP: runnerTemp }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  };
  await run(1);
  const committed = git('--git-dir', remote, 'show', 'main:docker-compose.yaml') + '\n';
  assert.equal(committed, artifact);
  assert.equal(compose(validateCompose(committed)), committed, 'Checked-in file equals the generator shape');
  assert.equal(git('--git-dir', remote, 'show', 'main:README.md'), 'Newer main content');
  assert.equal(git('--git-dir', remote, 'rev-parse', 'main^'), currentMain);
  assert.equal(git('--git-dir', remote, 'log', '-1', '--format=%s', 'main'), `publish: pin images ${services.map(name => `${name}=${digests[name].slice(7, 19)}`).join(' ')}`);
  const pinned = git('--git-dir', remote, 'rev-parse', 'main');
  assert.match(await run(2), /unchanged; skipping commit/);
  assert.equal(git('--git-dir', remote, 'rev-parse', 'main'), pinned);
  await rm(join(release, 'docker-compose.yaml'));
  await assert.rejects(run(3), /docker-compose.yaml/);
  assert.equal(git('--git-dir', remote, 'rev-parse', 'main'), pinned);
});

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
  assert.match(source, /ports: \["8080"\]\n    depends_on: \[api\]\n    environment: \[EXAMPLE_MESSAGE, API_URL, EXAMPLE_TOKEN, FILES_PATH\]/);
  assert.match(source, /ports: \["8081"\]\n    depends_on: \[postgres\]/);
  assert.match(source, /ports: \["8082"\]\n    depends_on: \[api, postgres\]/);
  assert.match(source, /environment: \[DATABASE_URL, EXAMPLE_TOKEN, FILES_PATH, FAULT_FILL_CAP_BYTES, FAULT_FILL_FLOOR_BYTES\]/);
  assert.equal([...source.matchAll(/volumes: \["files:\/data"\]/g)].length, 3, 'All Node services share the existing files volume for bounded fault records');
  assert.equal([...source.matchAll(/restart: unless-stopped/g)].length, 3);
  assert.ok(!source.includes('9090'));
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
    source.replace('EXAMPLE_MESSAGE, API_URL, EXAMPLE_TOKEN, FILES_PATH]', 'EXAMPLE_MESSAGE=value]'),
    source.replace('EXAMPLE_MESSAGE, API_URL, EXAMPLE_TOKEN, FILES_PATH]', '${EXAMPLE_MESSAGE}]'),
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
