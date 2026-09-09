import pg from 'pg';

export function database(connectionString) {
  const pool = new pg.Pool({ connectionString, max: 2, connectionTimeoutMillis: 2000, query_timeout: 2000, statement_timeout: 2000 });
  // Driver errors can contain connection details; never log their raw messages.
  pool.on('error', () => console.error('PostgreSQL idle connection unavailable'));
  return { ready: async () => { await pool.query('SELECT 1'); }, close: () => pool.end() };
}
