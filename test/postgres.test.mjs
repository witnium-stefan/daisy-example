import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { database } from '../services/database.mjs';
import { writeLedger } from '../services/worker/ledger.mjs';
import { configuration } from '../services/common.mjs';

const supplied = Object.hasOwn(process.env, 'DATABASE_URL');
test('real PostgreSQL: commit acknowledgment, second session, rollback, and application restart retain the exact ledger', {
  skip: supplied ? false : 'DATABASE_URL absent: real PostgreSQL evidence unavailable (no default URL)',
}, async () => {
  // A supplied empty/invalid value is an error, never an optional skip.
  configuration('worker', { SOURCE_REVISION: 'a'.repeat(40), EXAMPLE_TOKEN: 'test-process-only', FILES_PATH: '/data', API_URL: 'http://api:9090', DATABASE_URL: process.env.DATABASE_URL });
  const writer = database(process.env.DATABASE_URL), observer = database(process.env.DATABASE_URL);
  let phase = 'initialize';
  try {
    await writer.initialize();
    assert.deepEqual(await writer.rows(), [], 'DATABASE_URL must name an empty disposable fixture database; existing data is never deleted');
    phase = 'commit and independent session read';
    const first = await writeLedger(writer, { id: 'postgres-first', payload: 'acknowledged' });
    assert.deepEqual(await observer.rows(), [first]);
    phase = 'rollback';
    await assert.rejects(writer.transaction(async (tx) => {
      await tx.insert({ ...first, sequence: 2, id: 'rolled-back' });
      throw new Error('intentional rollback');
    }), /intentional rollback/);
    assert.deepEqual(await observer.rows(), [first]);
    const [second, retry] = await Promise.all([
      writeLedger(writer, { id: 'postgres-second', payload: 'retained' }),
      writeLedger(observer, { id: 'postgres-second', payload: 'retained' }),
    ]);
    assert.deepEqual(second, retry);
    assert.equal(second.sequence, 2);
    phase = 'durable hold and independent writer refusal';
    await observer.transaction((tx) => tx.hold('postgres-checkpoint'), { mode: 'hold' });
    await assert.rejects(writeLedger(writer, { id: 'held-writer', payload: '' }), (error) => error.status === 423 && error.checkpointId === 'postgres-checkpoint');
    phase = 'application restart';
    await writer.close();
    const moduleUrl = new URL('../services/database.mjs', import.meta.url).href;
    const script = `import { database } from ${JSON.stringify(moduleUrl)};
      const db = database(process.env.DATABASE_URL);
      try {
        await db.initialize();
        let refused = false;
        try { await db.transaction((tx) => tx.enqueue({ id: 'restarted-writer', payload: '' })); }
        catch (error) { if (error.status !== 423 || error.checkpointId !== 'postgres-checkpoint') throw error; refused = true; }
        if (!refused) throw new Error('Restart cleared durable hold');
        process.stdout.write(JSON.stringify(await db.rows()));
      }
      catch { process.stderr.write('Restarted PostgreSQL reader failed'); process.exitCode = 1; }
      finally { await db.close(); }`;
    const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], { env: process.env });
    assert.deepEqual(JSON.parse(stdout), [first, second]);
    phase = 'release persists refusal count and thaws writes';
    assert.deepEqual(await observer.transaction((tx) => tx.release('postgres-checkpoint'), { mode: 'release' }), { refusedWrites: 2 });
    assert.equal((await writeLedger(observer, { id: 'after-release', payload: '' })).sequence, 3);
  } catch {
    // pg errors can contain DATABASE_URL credentials; report only the failed phase.
    throw new Error(`Disposable DATABASE_URL real-commit check failed: ${phase}`);
  } finally {
    await observer.close();
    await writer.close().catch(() => {});
  }
});
