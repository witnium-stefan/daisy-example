import { frozenError } from '../../services/database.mjs';

// Test-only serialized commit/rollback stand-in. Running services always use pg.
export function memoryStore(initial = []) {
  let rows = structuredClone(initial), jobs = [], completions = {}, hold = null, tail = Promise.resolve();
  return {
    failCommit: false,
    rows: async () => structuredClone(rows),
    nextJob: async () => structuredClone(jobs.find((job) => !completions[rows.find((row) => row.id === job.id)?.sequence]) ?? null),
    transaction(work, { mode = 'write' } = {}) {
      const pending = tail.then(async () => {
        if (hold && (mode === 'write' || mode === 'hold')) {
          if (this.failCommit) throw new Error('Commit failed');
          hold.refusedWrites++;
          throw frozenError(hold.checkpointId, mode === 'hold' ? 409 : 423);
        }
        let held = structuredClone(hold);
        const copy = structuredClone(rows), queued = structuredClone(jobs), completed = { ...completions };
        const result = await work({
          hold: async (checkpointId) => { held = { checkpointId, held_at: new Date().toISOString(), refusedWrites: 0 }; },
          release: async (checkpointId) => {
            if (!held) throw Object.assign(new Error('EXAMPLE_NOT_FROZEN'), { status: 409 });
            if (held.checkpointId !== checkpointId) throw frozenError(held.checkpointId, 409);
            const result = { refusedWrites: held.refusedWrites };
            held = null;
            return result;
          },
          findJob: async (id) => copy.find((row) => row.id === id),
          lastRow: async () => copy.at(-1),
          insert: async (row) => { copy.push(row); },
          rows: async () => structuredClone(copy),
          complete: async (sequence, fileHash) => {
            if (completed[sequence] && completed[sequence] !== fileHash) throw new Error('Ledger file completion mismatch');
            completed[sequence] = fileHash;
          },
          enqueue: async (job) => {
            const existing = queued.find((entry) => entry.id === job.id);
            if (existing && existing.payload !== job.payload) throw new Error('Job ID payload conflict');
            if (!existing) queued.push(structuredClone(job));
          },
        });
        if (this.failCommit) throw new Error('Commit failed');
        rows = copy; jobs = queued; completions = completed; hold = held;
        return structuredClone(result);
      });
      tail = pending.catch(() => {});
      return pending;
    },
  };
}
