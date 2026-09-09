import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { writeLedger } from '../services/worker/ledger.mjs';

// Test-only transaction stand-in: serial execution, commit acknowledgment, rollback.
function memoryStore() {
  let rows = [], tail = Promise.resolve();
  return {
    failCommit: false,
    get rows() { return structuredClone(rows); },
    transaction(work) {
      const pending = tail.then(async () => {
        const copy = structuredClone(rows);
        const result = await work({
          findJob: async (id) => copy.find((row) => row.id === id),
          lastRow: async () => copy.at(-1),
          insert: async (row) => { copy.push(row); },
        });
        if (this.failCommit) throw new Error('Commit failed');
        rows = copy;
        return structuredClone(result);
      });
      tail = pending.catch(() => {});
      return pending;
    },
  };
}

test('ordered writer produces the independent expected hash manifest', async () => {
  const fixture = JSON.parse(await readFile(new URL('../fixtures/ledger.json', import.meta.url), 'utf8'));
  const store = memoryStore();
  const result = await Promise.all(fixture.jobs.map((job) => writeLedger(store, job)));
  assert.deepEqual(result, fixture.rows);
  assert.deepEqual(store.rows, fixture.rows);
});

test('concurrent retries do not duplicate jobs; conflicting payload fails', async () => {
  const store = memoryStore();
  const job = { id: 'retry', payload: 'hello' };
  const [first, retry] = await Promise.all([writeLedger(store, job), writeLedger(store, job)]);
  assert.deepEqual(first, retry);
  assert.equal(store.rows.length, 1);
  await assert.rejects(writeLedger(store, { ...job, payload: 'different' }), /payload conflict/);
  assert.equal(store.rows.length, 1);
});

test('failed commit is not acknowledged and does not create a sequence gap', async () => {
  const store = memoryStore();
  await writeLedger(store, { id: 'first', payload: 'one' });
  store.failCommit = true;
  await assert.rejects(writeLedger(store, { id: 'second', payload: 'two' }), /Commit failed/);
  assert.equal(store.rows.length, 1);
  store.failCommit = false;
  const second = await writeLedger(store, { id: 'second', payload: 'two' });
  assert.equal(second.sequence, 2);
  assert.equal(second.previousHash, store.rows[0].rowHash);
});

test('invalid jobs, oversized UTF-8 payloads and exhausted entry bounds fail', async () => {
  const store = memoryStore();
  for (const job of [{ id: '', payload: 'a' }, { id: '../bad', payload: 'a' }, { id: 'a', payload: 'é'.repeat(513) }, { id: 'a', payload: {} }]) {
    await assert.rejects(writeLedger(store, job));
  }
  assert.equal(store.rows.length, 0);
  let inserted = false;
  const full = { transaction: (work) => work({ findJob: async () => undefined, lastRow: async () => ({ sequence: 10000 }), insert: async () => { inserted = true; } }) };
  await assert.rejects(writeLedger(full, { id: 'overflow', payload: '' }), /entry limit/);
  assert.equal(inserted, false);
});
