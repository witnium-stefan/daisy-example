import { configuration, handler, listen } from '../common.mjs';
import { database } from '../database.mjs';

export function createApi(env, dependencies) {
  return handler('api', configuration('api', env), dependencies);
}

if (import.meta.main) {
  try {
    const config = configuration('api', process.env);
    const db = database(config.databaseUrl);
    listen('api', 8081, handler('api', config, { postgres: db.ready }), db.close);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
