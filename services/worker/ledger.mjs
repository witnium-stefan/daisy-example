import { createHash } from 'node:crypto';

export const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

// The store serializes transactions and resolves only after acknowledged commit.
export function validateJob({ id, payload }) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error('Invalid job ID');
  if (typeof payload !== 'string' || Buffer.byteLength(payload) > 1024) throw new Error('Payload must be a string of at most 1024 bytes');
}

export async function writeLedger(store, { id, payload }) {
  validateJob({ id, payload });
  const payloadHash = hash(payload);
  return store.transaction(async (tx) => {
    const existing = await tx.findJob(id);
    if (existing) {
      if (existing.payloadHash !== payloadHash) throw new Error('Job ID payload conflict');
      return existing;
    }
    const previous = await tx.lastRow();
    const sequence = previous ? previous.sequence + 1 : 1;
    if (!Number.isSafeInteger(sequence) || sequence < 1) throw new Error('Invalid committed ledger sequence');
    if (sequence > 10000) throw new Error('Ledger entry limit reached');
    const previousHash = previous ? previous.rowHash : null;
    if (previous && !/^[a-f0-9]{64}$/.test(previousHash)) throw new Error('Invalid previous row hash');
    const row = { sequence, id, payload, payloadHash, previousHash };
    row.rowHash = hash(JSON.stringify([sequence, id, payloadHash, previousHash]));
    await tx.insert(row);
    return row;
  });
}
