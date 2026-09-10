import pg from 'pg';

// One lock covers submissions, the sole ordered writer, and recovery barriers.
const lock = 'SELECT pg_advisory_xact_lock(173528, 2)';
const columns = 'sequence, id, payload, payload_hash AS "payloadHash", previous_hash AS "previousHash", row_hash AS "rowHash"';
export function frozenError(checkpointId, status = 423) {
  return Object.assign(new Error('EXAMPLE_FROZEN'), { checkpointId, status });
}

export function database(connectionString) {
  if (!connectionString) throw new Error('Missing required configuration: DATABASE_URL');
  const pool = new pg.Pool({ connectionString, max: 2, connectionTimeoutMillis: 2000, query_timeout: 10000, statement_timeout: 10000 });
  pool.on('error', () => console.error('PostgreSQL idle connection unavailable'));
  const rows = async (client) => (await client.query(`SELECT ${columns} FROM example_ledger ORDER BY sequence`)).rows;
  const transaction = async (work, { mode = 'write' } = {}) => {
    if (!['write', 'hold', 'read', 'release'].includes(mode)) throw new Error('Invalid ledger transaction mode');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL synchronous_commit = on');
      await client.query(lock);
      if (mode === 'write' || mode === 'hold') {
        const held = (await client.query('SELECT checkpoint_id FROM ledger_hold')).rows[0];
        if (held) {
          await client.query('UPDATE ledger_hold SET refused_writes = refused_writes + 1');
          // Persist the refusal even though the requested write does not run.
          await client.query('COMMIT');
          throw frozenError(held.checkpoint_id, mode === 'hold' ? 409 : 423);
        }
      }
      const result = await work({
        hold: async (checkpointId) => {
          await client.query('INSERT INTO ledger_hold (checkpoint_id, held_at) VALUES ($1, CURRENT_TIMESTAMP)', [checkpointId]);
        },
        release: async (checkpointId) => {
          const held = (await client.query('SELECT checkpoint_id FROM ledger_hold')).rows[0];
          if (!held) throw Object.assign(new Error('EXAMPLE_NOT_FROZEN'), { status: 409 });
          if (held.checkpoint_id !== checkpointId) throw frozenError(held.checkpoint_id, 409);
          return (await client.query('DELETE FROM ledger_hold WHERE checkpoint_id = $1 RETURNING refused_writes AS "refusedWrites"', [checkpointId])).rows[0];
        },
        findJob: async (id) => (await client.query(`SELECT ${columns} FROM example_ledger WHERE id = $1`, [id])).rows[0],
        lastRow: async () => (await client.query(`SELECT ${columns} FROM example_ledger ORDER BY sequence DESC LIMIT 1`)).rows[0],
        insert: async (row) => { await client.query('INSERT INTO example_ledger (sequence, id, payload, payload_hash, previous_hash, row_hash) VALUES ($1,$2,$3,$4,$5,$6)', [row.sequence, row.id, row.payload, row.payloadHash, row.previousHash, row.rowHash]); },
        rows: () => rows(client),
        complete: async (sequence, fileHash) => {
          const result = await client.query('UPDATE example_ledger SET file_hash = $2 WHERE sequence = $1 AND (file_hash IS NULL OR file_hash = $2)', [sequence, fileHash]);
          if (result.rowCount !== 1) throw new Error('Ledger file completion mismatch');
        },
        enqueue: async (job) => {
          const existing = (await client.query('SELECT payload FROM example_jobs WHERE id = $1', [job.id])).rows[0];
          if (existing && existing.payload !== job.payload) throw new Error('Job ID payload conflict');
          await client.query('INSERT INTO example_jobs (id, payload) VALUES ($1,$2) ON CONFLICT (id) DO NOTHING', [job.id, job.payload]);
        },
      });
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* The connection is discarded below. */ }
      throw error;
    } finally { client.release(); }
  };
  return {
    async initialize() {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(lock);
        await client.query(`CREATE TABLE IF NOT EXISTS example_jobs (
          position bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
          id text PRIMARY KEY, payload text NOT NULL
        )`);
        await client.query(`CREATE TABLE IF NOT EXISTS example_ledger (
          sequence integer PRIMARY KEY CHECK (sequence BETWEEN 1 AND 10000),
          id text UNIQUE NOT NULL, payload text NOT NULL,
          payload_hash text NOT NULL, previous_hash text, row_hash text NOT NULL,
          file_hash text
        )`);
        await client.query(`CREATE TABLE IF NOT EXISTS ledger_hold (
          singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
          checkpoint_id text NOT NULL, held_at timestamptz NOT NULL,
          refused_writes integer NOT NULL DEFAULT 0 CHECK (refused_writes >= 0)
        )`);
        await client.query('SELECT singleton, checkpoint_id, held_at, refused_writes FROM ledger_hold LIMIT 0');
        // Also fail startup for an incompatible preexisting schema; never reset it.
        await client.query(`SELECT ${columns}, file_hash FROM example_ledger LIMIT 0`);
        await client.query('SELECT position, id, payload FROM example_jobs LIMIT 0');
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally { client.release(); }
    },
    transaction,
    rows: () => rows(pool),
    async nextJob() {
      return (await pool.query(`SELECT j.id, j.payload FROM example_jobs j
        LEFT JOIN example_ledger l ON l.id = j.id
        WHERE l.file_hash IS NULL ORDER BY j.position LIMIT 1`)).rows[0] ?? null;
    },
    ready: async () => { await pool.query('SELECT sequence, file_hash FROM example_ledger LIMIT 0'); },
    close: () => pool.end(),
  };
}
