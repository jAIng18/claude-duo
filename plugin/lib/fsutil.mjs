// Small, dependency-free filesystem helpers: atomic JSON writes and a
// mkdir-based lock that tolerates crashed holders.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { paths } from './paths.mjs';

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function readJSON(file, fallback = undefined) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (fallback !== undefined && (e.code === 'ENOENT' || e instanceof SyntaxError)) return fallback;
    throw e;
  }
}

/** Write JSON atomically: temp file in the same directory, then rename. */
export function writeJSONAtomic(file, data) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}

const sleepBuf = new Int32Array(new SharedArrayBuffer(4));
export function sleepSync(ms) {
  Atomics.wait(sleepBuf, 0, 0, ms);
}

/**
 * Run fn while holding a named lock. Locks older than staleMs are broken
 * (the holder crashed). Throws if the lock cannot be taken within timeoutMs.
 */
export function withLock(name, fn, { timeoutMs = 3000, staleMs = 15000 } = {}) {
  const dir = path.join(ensureDir(paths.locks()), `${name.replace(/[^a-zA-Z0-9_.-]/g, '_')}.lock`);
  const start = Date.now();
  for (;;) {
    try {
      fs.mkdirSync(dir);
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        const age = Date.now() - fs.statSync(dir).mtimeMs;
        if (age > staleMs) { fs.rmSync(dir, { recursive: true, force: true }); continue; }
      } catch { continue; }
      if (Date.now() - start > timeoutMs) throw new Error(`lock timeout: ${name}`);
      sleepSync(25);
    }
  }
  try {
    return fn();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export function log(...parts) {
  try {
    ensureDir(paths.logs());
    const line = `${new Date().toISOString()} [${process.pid}] ${parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ')}\n`;
    fs.appendFileSync(path.join(paths.logs(), 'duo.log'), line, { mode: 0o600 });
  } catch { /* logging must never break anything */ }
}
