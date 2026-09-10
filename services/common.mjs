import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { isAbsolute } from 'node:path';

export function required(env, key) {
  if (typeof env[key] !== 'string' || env[key].trim() === '') {
    throw new Error(`Missing required configuration: ${key}`);
  }
  return env[key];
}

export function configuration(service, env) {
  const revision = required(env, 'SOURCE_REVISION');
  if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error('Invalid SOURCE_REVISION: expected a full Git SHA');
  const config = { revision, token: required(env, 'EXAMPLE_TOKEN'), filesPath: required(env, 'FILES_PATH') };
  if (!/^[\x21-\x7e]+$/.test(config.token)) throw new Error('Invalid EXAMPLE_TOKEN: expected visible ASCII');
  if (!isAbsolute(config.filesPath)) throw new Error('Invalid FILES_PATH: expected an absolute mounted directory');
  if (service === 'web') config.message = required(env, 'EXAMPLE_MESSAGE');
  else {
    config.databaseUrl = required(env, 'DATABASE_URL');
    let url;
    try { url = new URL(config.databaseUrl); } catch { throw new Error('Invalid DATABASE_URL'); }
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.pathname.slice(1)) {
      throw new Error('Invalid DATABASE_URL: expected a PostgreSQL URL with host and database');
    }
  }
  if (service === 'web' || service === 'worker') {
    config.apiUrl = required(env, 'API_URL');
    let url;
    try { url = new URL(config.apiUrl); } catch { throw new Error('Invalid API_URL'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Invalid API_URL: expected an HTTP origin without credentials');
  }
  if (service === 'api') {
    for (const [key, name] of [['FAULT_FILL_CAP_BYTES', 'fillCapBytes'], ['FAULT_FILL_FLOOR_BYTES', 'fillFloorBytes']]) {
      const value = required(env, key);
      if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error(`Invalid ${key}: expected a positive safe integer`);
      config[name] = Number(value);
    }
    if (config.fillCapBytes > 64 * 1024 * 1024) throw new Error('Invalid FAULT_FILL_CAP_BYTES: maximum is 67108864');
  }
  return config;
}

export function handler(service, config, dependencies) {
  const requiredDependencies = { web: ['api'], api: ['postgres', 'files'], worker: ['api', 'postgres'] }[service];
  for (const name of requiredDependencies) {
    if (typeof dependencies?.[name] !== 'function') throw new Error(`Missing required readiness probe: ${service}/${name}`);
  }
  return async (req, res) => {
    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    if (req.method !== 'GET') return send(405, { error: 'method-not-allowed' });
    if (req.url === '/health/live') return send(200, { service, status: 'live' });
    if (req.url === '/version') return send(200, { service, version: '1.0.0', sourceRevision: config.revision });
    if (req.url === '/health/ready') {
      const results = await Promise.all(Object.entries(dependencies).map(async ([name, probe]) => {
        try { await probe(); return [name, 'ready']; } catch { return [name, 'unavailable']; }
      }));
      const ready = results.every(([, status]) => status === 'ready');
      return send(ready ? 200 : 503, { service, status: ready ? 'ready' : 'unavailable', dependencies: Object.fromEntries(results) });
    }
    return send(404, { error: 'not-found' });
  };
}

export async function httpReady(url, expectedService) {
  const response = await fetch(url, { signal: AbortSignal.timeout(2000), redirect: 'error' });
  if (response.status !== 200) throw new Error('Dependency unavailable');
  const body = await response.json();
  if (body.service !== expectedService || body.status !== 'ready') throw new Error('Dependency identity mismatch');
}

export function listen(service, port, requestHandler, close = async () => {}) {
  const server = createServer(applicationHandler(requestHandler));
  // Intake advertises only the application port. Management endpoints use a
  // separate internal listener, so public web ingress cannot expose them.
  const management = createServer(requestHandler);
  for (const listener of [server, management]) {
    listener.on('error', () => {
      console.error(`${service}: HTTP server failure`);
      process.exitCode = 1;
      server.close();
      management.close();
      void close();
    });
  }
  server.listen(port, '0.0.0.0');
  management.listen(9090, '0.0.0.0');
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => {
    server.close();
    management.close(() => { void close(); });
    for (const listener of [server, management]) listener.closeIdleConnections();
  });
  return server;
}

export function applicationHandler(requestHandler) {
  return (req, res) => {
    if (!['/', '/jobs', '/ledger', '/files'].includes(req.url)) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not-found' }));
      return;
    }
    return requestHandler(req, res);
  };
}

export function containsSecret(value, token) {
  if (typeof value === 'string') return value.includes(token);
  if (value && typeof value === 'object') return Object.entries(value).some(([key, entry]) => key.includes(token) || containsSecret(entry, token));
  return false;
}

export function send(res, status, body, token) {
  let encoded = JSON.stringify(body);
  if (token && containsSecret(body, token)) { status = 500; encoded = JSON.stringify({ error: 'Secret-bearing content refused' }); }
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(encoded);
}

export function authorized(req, token) {
  const actual = Buffer.from(req.headers?.authorization ?? '');
  const expected = Buffer.from(`Bearer ${token}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export async function body(req, token, limit = 8192) {
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > limit) throw new Error('Request body too large');
    chunks.push(chunk);
  }
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (token && containsSecret(value, token)) throw new Error('Secret-bearing content refused');
  return value;
}

export async function apiRequest(config, path, options = {}) {
  const response = await fetch(new URL(path, config.apiUrl), {
    ...options, headers: { 'content-type': 'application/json', ...(config.token ? { authorization: `Bearer ${config.token}` } : {}) },
    signal: AbortSignal.timeout(10000), redirect: 'error',
  });
  if (!response.ok) throw Object.assign(new Error('API request failed'), { status: response.status });
  return response.json();
}
