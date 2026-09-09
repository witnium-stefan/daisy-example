// Test-only serialized commit/rollback stand-in. Running services always use pg.
export function memoryStore(initial = []) {
  let rows = structuredClone(initial), jobs = [], completions = {}, tail = Promise.resolve();
  return {
    failCommit: false,
    rows: async () => structuredClone(rows),
    nextJob: async () => structuredClone(jobs.find((job) => !completions[rows.find((row) => row.id === job.id)?.sequence]) ?? null),
    transaction(work) {
      const pending = tail.then(async () => {
        const copy = structuredClone(rows), queued = structuredClone(jobs), completed = { ...completions };
        const result = await work({
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
        rows = copy; jobs = queued; completions = completed;
        return structuredClone(result);
      });
      tail = pending.catch(() => {});
      return pending;
    },
  };
}
