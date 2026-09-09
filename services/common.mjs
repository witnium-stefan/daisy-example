import { createServer } from 'node:http';

export function required(env, key) {
  if (typeof env[key] !== 'string' || env[key].trim() === '') {
    throw new Error(`Missing required configuration: ${key}`);
  }
  return env[key];
}

export function configuration(service, env) {
  const revision = required(env, 'SOURCE_REVISION');
  if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error('Invalid SOURCE_REVISION: expected a full Git SHA');
  const config = { revision };
  if (service === 'web') config.message = required(env, 'EXAMPLE_MESSAGE');
  else {
    config.databaseUrl = required(env, 'DATABASE_URL');
    config.sharedSecret = required(env, 'EXAMPLE_SHARED_SECRET');
    let url;
    try { url = new URL(config.databaseUrl); } catch { throw new Error('Invalid DATABASE_URL'); }
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.pathname.slice(1)) {
      throw new Error('Invalid DATABASE_URL: expected a PostgreSQL URL with host and database');
    }
  }
  return config;
}

export function handler(service, config, dependencies) {
  const requiredDependencies = { web: ['api'], api: ['postgres'], worker: ['api', 'postgres', 'files'] }[service];
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
    if (service === 'web' && req.url === '/') return send(200, { service, message: config.message });
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
    if (req.url !== '/') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not-found' }));
      return;
    }
    return requestHandler(req, res);
  };
}
