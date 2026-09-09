import { faultFile } from '../faults.mjs';
import { access, open, readFile, readdir, rename, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { join, isAbsolute } from 'node:path';
import { hash } from '../worker/ledger.mjs';

export const fileName = (sequence) => `${String(sequence).padStart(5, '0')}.json`;
export const fileBytes = (row) => JSON.stringify(row) + '\n';

export function files(directory) {
  if (!isAbsolute(directory)) throw new Error('Invalid FILES_PATH: expected an absolute mounted directory');
  const read = (name) => readFile(join(directory, name));
  return {
    async ready() {
      if (!(await stat(directory)).isDirectory()) throw new Error('FILES_PATH is not a directory');
      await access(directory, constants.R_OK | constants.W_OK);
    },
    async write(row) {
      const name = fileName(row.sequence), bytes = fileBytes(row);
      try {
        if (!(await read(name)).equals(Buffer.from(bytes))) throw new Error('Immutable ledger file mismatch');
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        // Only this reserved temporary name is rewritten when recovering an interruption.
        const temporary = join(directory, `.${name}.tmp`);
        const handle = await open(temporary, 'w', 0o600);
        try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
        await rename(temporary, join(directory, name));
      }
      // A retry after rename must still sync the directory before acknowledging.
      const handle = await open(directory, 'r');
      try { await handle.sync(); } finally { await handle.close(); }
      return { name, hash: hash(bytes), bytes: Buffer.byteLength(bytes) };
    },
    async list() {
      const names = (await readdir(directory)).filter((name) => !faultFile(name)).sort();
      return Promise.all(names.map(async (name) => {
        if (!/^\d{5}\.json$/.test(name)) throw new Error('Unexpected file in FILES_PATH');
        const bytes = await read(name);
        return { name, hash: hash(bytes), bytes: bytes.length };
      }));
    },
    read,
  };
}

// The expected manifest must come from outside the restored database/volume.
export async function verifyPrefix(expected, rows, volume) {
  if (!expected || expected.format !== 1 || typeof expected.checkpointId !== 'string' ||
      !Number.isInteger(expected.watermark) || expected.watermark < 0 || expected.watermark > 10000 ||
      !Array.isArray(expected.rows) || !Array.isArray(expected.files) ||
      expected.rows.length !== expected.watermark || expected.files.length !== expected.watermark) {
    throw new Error('Invalid recovery manifest');
  }
  if (rows.length !== expected.watermark) throw new Error('Restore row count differs from selected prefix');
  let previousHash = null;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i], sequence = i + 1;
    if (row.sequence !== sequence || row.previousHash !== previousHash || row.payloadHash !== hash(row.payload) ||
        row.rowHash !== hash(JSON.stringify([sequence, row.id, row.payloadHash, previousHash])) ||
        !isDeepStrictEqual(row, expected.rows[i])) throw new Error('Restore ledger prefix mismatch');
    const bytes = fileBytes(row);
    const wanted = { name: fileName(sequence), hash: hash(bytes), bytes: Buffer.byteLength(bytes) };
    if (!isDeepStrictEqual(expected.files[i], wanted) ||
        !(await volume.read(wanted.name)).equals(Buffer.from(bytes))) throw new Error('Restore file prefix mismatch');
    previousHash = row.rowHash;
  }
  if (!isDeepStrictEqual(await volume.list(), expected.files)) throw new Error('Restore file manifest mismatch');
  return { checkpointId: expected.checkpointId, selectedWatermark: expected.watermark, observedWatermark: rows.length, status: 'complete-prefix' };
}
