import { configuration, handler, httpReady, listen } from '../common.mjs';

export function createWeb(env, dependencies) {
  return handler('web', configuration('web', env), dependencies);
}

if (import.meta.main) {
  try {
    listen('web', 8080, createWeb(process.env, { api: () => httpReady('http://api:9090/health/ready', 'api') }));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
