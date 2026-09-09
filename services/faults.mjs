import { open, rename, unlink, statfs, stat, lstat, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { authorized, body, containsSecret, send } from './common.mjs';

export const MAX_LATENCY_MS = 2000;
export const MAX_LEASE_MS = 300000;
export const MAX_CRASHES = 3;
export const faultFile = (name) => /^\.fault-(web|api|worker)\.json(?:\.tmp)?$/.test(name) || name === '.fault-api.fill';
const identifier = (value) => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(value);

// One bounded record per service; no token, headers, or raw exception text is retained.
export function faults(service, config, { exit = (code) => process.exit(code), log = (line) => console.log(line), now = Date.now } = {}) {
  const recordPath = join(config.filesPath, `.fault-${service}.json`);
  const fillPath = join(config.filesPath, '.fault-api.fill');
  let active = null, lastSet = null, lastReset = null, denial = null, busy = false, crashing = false, timer;
  const snapshot = () => ({ service, active, lastSet, lastReset, denial });
  const emit = (event, detail) => {
    const value = { event, service, sourceRevision: config.revision, time: new Date(now()).toISOString(), ...detail };
    if (!containsSecret(value, config.token)) log(JSON.stringify(value));
  };
  const save = async () => {
    const value = { active: ['disk-full', 'crash-loop'].includes(active?.fault) ? active : null, lastSet, lastReset };
    const bytes = JSON.stringify(value);
    if (Buffer.byteLength(bytes) > 8192 || containsSecret(value, config.token)) throw new Error('Fault record refused');
    const file = await open(recordPath + '.tmp', constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
    try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
    await rename(recordPath + '.tmp', recordPath);
    const directory = await open(config.filesPath, 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  };
  const reset = async (actor, reason, context = {}) => {
    if (!active) return;
    if (active.fault === 'disk-full' && active.parameters.created) {
      try { await unlink(fillPath); } catch (error) { if (error.code !== 'ENOENT') throw new Error('Fault filler reset failed'); }
    }
    const previous = active, previousReset = lastReset;
    active = null;
    lastReset = { ...previous, resetContext: context, resetActor: actor, resetAt: new Date(now()).toISOString(), reason };
    try { await save(); } catch (error) { active = previous; lastReset = previousReset; throw error; }
    clearTimeout(timer);
    emit('fault-reset', lastReset);
  };
  const expire = async () => {
    if (active && now() >= Date.parse(active.expiresAt)) await reset('lease-expiration', 'expired');
  };
  const schedule = () => {
    clearTimeout(timer);
    if (!active) return;
    timer = setTimeout(async () => {
      if (busy) { schedule(); return; }
      busy = true;
      try { await expire(); } catch { emit('fault-reset-failed', { fault: active?.fault, reason: 'Reset failed; residual fault requires operator intervention' }); }
      finally { busy = false; }
    }, Math.max(10, Date.parse(active.expiresAt) - now()));
    timer.unref();
  };
  const crash = async () => {
    if (crashing || !active || !['crash', 'crash-loop'].includes(active.fault)) return;
    crashing = true;
    busy = true;
    if (active.fault === 'crash') await reset('process-exit', 'one-shot-complete');
    emit('fault-exit', { fault: lastSet.fault, reason: 'Injected nonzero exit', code: 1 });
    exit(1);
    busy = false;
  };
  const metadata = (input) => {
    if (!input || !identifier(input.actor) || !identifier(input.runId) || !identifier(input.operationId) ||
        !identifier(input.targetScope) || !/^sha256:[a-f0-9]{64}$/.test(input.imageDigest ?? '') ||
        typeof input.expiresAt !== 'string' || !Number.isFinite(Date.parse(input.expiresAt)) ||
        Date.parse(input.expiresAt) <= now() || Date.parse(input.expiresAt) - now() > MAX_LEASE_MS) {
      throw new Error('Invalid fault metadata or lease');
    }
    return Object.fromEntries(['actor', 'runId', 'operationId', 'targetScope', 'imageDigest', 'expiresAt'].map((key) => [key, input[key]]));
  };
  const fill = async () => {
    const available = async () => { const info = await statfs(config.filesPath, { bigint: true }); return info.bavail * info.bsize; };
    const requested = active.parameters.bytes;
    if (await available() - BigInt(requested) < BigInt(config.fillFloorBytes)) throw new Error('Fault free-space floor refused');
    try { await lstat(fillPath); throw new Error('Unowned fault filler: creation refused'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    active.parameters.created = true;
    await save();
    let file;
    try { file = await open(fillPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
    catch (error) { active.parameters.created = false; throw error; }
    try {
      const chunk = Buffer.alloc(Math.min(requested, 1024 * 1024));
      while (active.parameters.writtenBytes < requested) {
        if (now() >= Date.parse(active.expiresAt)) throw new Error('Disk-fill lease expired');
        const length = Math.min(chunk.length, requested - active.parameters.writtenBytes);
        if (await available() - BigInt(length) < BigInt(config.fillFloorBytes)) throw new Error('Fault free-space floor refused');
        const { bytesWritten } = await file.write(chunk, 0, length);
        if (bytesWritten <= 0) throw new Error('Fault filler write made no progress');
        active.parameters.writtenBytes += bytesWritten;
      }
      await file.sync();
    } finally { await file.close(); }
  };
  const controller = {
    async start() {
      try { return await controller.load(); }
      catch (error) {
        if (/^(Invalid|Unowned|FILES_PATH|Fault filler)/.test(error.message) && !containsSecret(error.message, config.token)) throw error;
        throw new Error('Fault startup failed: cannot read or persist fault storage');
      }
    },
    async load() {
      try {
        if (!(await stat(config.filesPath)).isDirectory()) throw new Error();
        await access(config.filesPath, constants.R_OK | constants.W_OK);
      } catch { throw new Error('FILES_PATH unavailable: fault storage must be an existing writable directory'); }
      let saved;
      try {
        const file = await open(recordPath, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const info = await file.stat();
          if (!info.isFile() || info.size > 8192) throw new Error('Invalid fault record');
          saved = JSON.parse(await file.readFile('utf8'));
        } finally { await file.close(); }
      } catch (error) {
        if (error.code !== 'ENOENT') throw new Error('Invalid fault record: startup refused');
      }
      if (saved) {
        if (containsSecret(saved, config.token) || !Object.hasOwn(saved, 'active') || !Object.hasOwn(saved, 'lastSet') || !Object.hasOwn(saved, 'lastReset')) throw new Error('Invalid fault record: startup refused');
        ({ active, lastSet, lastReset } = saved);
        if ([active, lastSet, lastReset].some((record) => record !== null && (typeof record !== 'object' || Array.isArray(record)))) throw new Error('Invalid fault record: startup refused');
        for (const record of [active, lastSet, lastReset].filter(Boolean)) {
          if (!identifier(record.actor) || !identifier(record.runId) || !identifier(record.operationId) || !identifier(record.targetScope) ||
              !/^sha256:[a-f0-9]{64}$/.test(record.imageDigest ?? '') || !Number.isFinite(Date.parse(record.setAt)) ||
              !Number.isFinite(Date.parse(record.expiresAt)) || Date.parse(record.expiresAt) - Date.parse(record.setAt) > MAX_LEASE_MS ||
              !['crash', 'crash-loop', 'latency', 'disk-full', 'database-down'].includes(record.fault)) throw new Error('Invalid fault record: startup refused');
        }
        if (active && !['crash-loop', 'disk-full'].includes(active.fault)) throw new Error('Invalid persistent fault');
      }
      if (active?.fault === 'crash-loop' && (!Number.isInteger(active.parameters?.remaining) || active.parameters.remaining < 0 || active.parameters.remaining >= MAX_CRASHES)) throw new Error('Invalid crash-loop counter');
      if (active?.fault === 'disk-full') {
        if (service !== 'api' || typeof active.parameters?.created !== 'boolean' || !Number.isSafeInteger(active.parameters?.bytes) || active.parameters.bytes < 1 || active.parameters.bytes > config.fillCapBytes) throw new Error('Invalid disk-fill record');
        try {
          const file = await open(fillPath, constants.O_RDONLY | constants.O_NOFOLLOW);
          try {
            const info = await file.stat();
            if (!active.parameters.created || !info.isFile() || info.size > active.parameters.bytes) throw new Error();
            active.parameters.writtenBytes = info.size;
          } finally { await file.close(); }
        } catch (error) { if (error.code !== 'ENOENT') throw new Error('Invalid fault filler: startup refused'); active.parameters.writtenBytes = 0; }
      } else if (service === 'api') {
        try { await stat(fillPath); } catch (error) { if (error.code === 'ENOENT') return controller.finishStart(); throw new Error('Fault filler inspection failed'); }
        throw new Error('Unowned fault filler: startup refused');
      }
      return controller.finishStart();
    },
    async finishStart() {
      await expire();
      if (active?.fault === 'crash-loop') {
        if (active.parameters.remaining === 0) await reset('restart-counter', 'crash-loop-complete');
        else {
          active.parameters.remaining--;
          await save();
          await crash();
          return false;
        }
      }
      // Transient switches are deliberately not rearmed after a process restart.
      if (!active && lastSet && (!lastReset || lastReset.operationId !== lastSet.operationId)) {
        active = lastSet;
        await reset('process-restart', 'transient-cleared');
      }
      schedule();
      return true;
    },
    close() { clearTimeout(timer); },
    status: snapshot,
    reason() { return active ? (active.fault === 'database-down' ? 'EXAMPLE_DATABASE_DOWN' : `fault:${active.fault}${active.parameters?.failed ? ':fill-failed' : ''}`) : null; },
    assertDatabase() { if (active?.fault === 'database-down') throw new Error('EXAMPLE_DATABASE_DOWN'); },
    async beforeWork() {
      if (!busy) {
        busy = true;
        try { await expire(); } finally { busy = false; }
      }
      if (active?.fault === 'crash' && active.parameters.mode === 'next-request') await crash();
      if (active?.fault === 'latency') await delay(active.parameters.ms);
    },
    wrap(requestHandler) {
      const wrapped = async (req, res) => {
        if (req.url === '/faults' || req.url === '/faults/reset') {
          const reply = (status, value) => send(res, status, value, config.token);
          if (!authorized(req, config.token)) {
            denial = { time: new Date(now()).toISOString(), reason: 'Unauthorized fault request' };
            emit('fault-denied', denial);
            return reply(401, { error: 'Unauthorized fault request' });
          }
          if (req.method === 'GET' && req.url === '/faults') return reply(200, snapshot());
          if (req.method !== 'POST') return reply(405, { error: 'method-not-allowed' });
          let input, context;
          try { input = await body(req, config.token, 4096); context = metadata(input); }
          catch { return reply(400, { error: 'Invalid fault metadata, secret-bearing content, or lease' }); }
          if (busy) return reply(409, { error: 'Fault control busy' });
          busy = true;
          try {
            await expire();
            if (req.url === '/faults/reset') { await reset(context.actor, 'operator-reset', context); return reply(200, snapshot()); }
            if (active) return reply(409, { error: 'Reset the active fault first' });
            let parameters;
            if (input.fault === 'latency' && Number.isInteger(input.ms) && input.ms >= 1 && input.ms <= MAX_LATENCY_MS) parameters = { ms: input.ms };
            else if (input.fault === 'crash' && ['immediate', 'next-request'].includes(input.mode)) parameters = { mode: input.mode };
            else if (input.fault === 'crash-loop' && Number.isInteger(input.starts) && input.starts >= 1 && input.starts <= MAX_CRASHES) parameters = { starts: input.starts, remaining: input.starts - 1 };
            else if (input.fault === 'database-down' && service === 'api') parameters = {};
            else if (input.fault === 'disk-full' && service === 'api' && Number.isSafeInteger(input.bytes) && input.bytes >= 1 && input.bytes <= config.fillCapBytes) parameters = { bytes: input.bytes, writtenBytes: 0, created: false };
            else return reply(400, { error: 'Unsupported fault or parameter outside bound' });
            active = { ...context, fault: input.fault, parameters, setAt: new Date(now()).toISOString() };
            lastSet = structuredClone(active);
            await save();
            emit('fault-set', active);
            schedule();
            if (active.fault === 'disk-full') {
              try { await fill(); } catch { active.parameters.failed = true; await save(); emit('fault-fill-failed', active); return reply(503, { error: 'Disk fill failed: capacity floor or filesystem refused', ...snapshot() }); }
              await save();
              emit('fault-filled', active);
            }
            reply(202, snapshot());
            if (active.fault === 'crash-loop' || (active.fault === 'crash' && active.parameters.mode === 'immediate')) {
              setImmediate(() => { void crash().catch(() => emit('fault-exit-failed', { reason: 'Fault record write failed' })); });
            }
            return;
          } catch { emit('fault-control-failed', { reason: 'Fault storage or reset failed' }); return reply(503, { error: 'Fault storage or reset failed; inspect residual fault', ...snapshot() }); }
          finally { busy = false; }
        }
        if (req.url === '/health/ready' && req.method === 'GET' && active) return send(res, 503, { service, status: 'not-ready', reason: controller.reason() }, config.token);
        if (!['/health/live', '/health/ready', '/version'].includes(req.url)) {
          try { await controller.beforeWork(); } catch { return send(res, 503, { error: 'Fault reset or storage failed' }, config.token); }
        }
        return requestHandler(req, res);
      };
      wrapped.faults = controller;
      return wrapped;
    },
  };
  return controller;
}
