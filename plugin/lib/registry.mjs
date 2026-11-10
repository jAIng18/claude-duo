// Registry of live Claude sessions per peer (written by hooks). SPEC §4.4.
//   registry/<peer>/<session_id>.json   one per running session
//   registry/<peer>/_bg.json            the background "worker" session (keep_context)
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { paths } from './paths.mjs';
import { readJSON, writeJSONAtomic, withLock, ensureDir } from './fsutil.mjs';

const SID_RE = /^[0-9a-f-]{8,64}$/i;
export const STATES = ['idle', 'busy', 'awaiting_user', 'offline'];

function sessFile(peer, sid) {
  if (!SID_RE.test(sid)) throw new Error(`bad session id ${sid}`);
  return path.join(paths.registry(peer), `${sid}.json`);
}

export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/** Walk up the process tree to find the `claude` process that owns us. */
export function findClaudePid(start = process.ppid) {
  let pid = start;
  for (let i = 0; i < 8 && pid > 1; i++) {
    let out;
    try { out = execFileSync('ps', ['-o', 'ppid=,comm=', '-p', String(pid)], { encoding: 'utf8', timeout: 1000 }).trim(); } catch { return null; }
    const m = out.match(/^(\d+)\s+(.*)$/);
    if (!m) return null;
    const comm = m[2].trim();
    if (path.basename(comm) === 'claude' || /\/claude\/versions\//.test(comm)) return pid;
    pid = Number(m[1]);
  }
  return null;
}

export function tmuxFromEnv(env = process.env) {
  if (!env.TMUX || !env.TMUX_PANE) return null;
  return { socket: env.TMUX.split(',')[0], pane: env.TMUX_PANE };
}

export function getSession(peer, sid) {
  return readJSON(sessFile(peer, sid), null);
}

export function upsertSession(peer, sid, patch) {
  return withLock(`reg-${peer}-${sid}`, () => {
    const f = sessFile(peer, sid);
    const cur = readJSON(f, null) || { peer, session_id: sid, created_at: new Date().toISOString(), injected: [], auto_continue_count: 0 };
    const next = { ...cur, ...patch, updated_at: new Date().toISOString() };
    writeJSONAtomic(f, next);
    return next;
  });
}

export function removeSession(peer, sid) {
  try { fs.rmSync(sessFile(peer, sid), { force: true }); } catch { /* ignore */ }
}

/** Sessions of a peer whose process is still alive (dead ones are pruned). */
export function listSessions(peer) {
  const dir = paths.registry(peer);
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const n of names) {
    if (!n.endsWith('.json') || n.startsWith('_')) continue;
    const s = readJSON(path.join(dir, n), null);
    if (!s) continue;
    if (s.pid && !pidAlive(s.pid)) { fs.rmSync(path.join(dir, n), { force: true }); continue; }
    out.push(s);
  }
  return out.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
}

export function getBg(peer) {
  return readJSON(path.join(paths.registry(peer), '_bg.json'), null);
}

export function setBg(peer, info) {
  ensureDir(paths.registry(peer));
  if (info === null) { fs.rmSync(path.join(paths.registry(peer), '_bg.json'), { force: true }); return null; }
  const v = { ...info, updated_at: new Date().toISOString() };
  writeJSONAtomic(path.join(paths.registry(peer), '_bg.json'), v);
  return v;
}
