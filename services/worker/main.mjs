import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { configuration, handler, httpReady, listen } from '../common.mjs';
import { database } from '../database.mjs';

export function createWorker(env, dependencies) {
  return handler('worker', configuration('worker', env), dependencies);
}

export async function filesReady() {
  if (!(await stat('/data')).isDirectory()) throw new Error('Files volume is not a directory');
  await access('/data', constants.R_OK | constants.W_OK);
}

if (import.meta.main) {
  try {
    const config = configuration('worker', process.env);
    const db = database(config.databaseUrl);
    listen('worker', 8082, handler('worker', config, {
      api: () => httpReady('http://api:9090/health/ready', 'api'), postgres: db.ready, files: filesReady,
    }), db.close);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
