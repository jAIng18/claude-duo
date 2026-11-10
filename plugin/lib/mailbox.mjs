// File-per-message mailbox. SPEC §5–6.
//   mail/<to>/new/<id>.json   queued | delivered | unread
//   mail/<to>/cur/<id>.json   accepted | in_progress | needs_info
//   mail/<to>/done/<id>.json  done | failed | rejected | cancelled | expired | read
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { paths } from './paths.mjs';
import { readJSON, writeJSONAtomic, withLock, ensureDir, log } from './fsutil.mjs';
import { PEERS, DuoError } from './config.mjs';

export const TYPES = ['task', 'question', 'result', 'info', 'cancel'];
export const WORK_TYPES = ['task', 'question'];
export const BOXES = ['new', 'cur', 'done'];
const BOX_OF = {
  queued: 'new', delivered: 'new', unread: 'new',
  accepted: 'cur', in_progress: 'cur', needs_info: 'cur',
  done: 'done', failed: 'done', rejected: 'done', cancelled: 'done', expired: 'done', read: 'done',
};
export const TERMINAL = ['done', 'failed', 'rejected', 'cancelled', 'expired', 'read'];
export const BODY_INLINE_MAX = 16 * 1024;
export const ID_RE = /\b(\d{8}-\d{6}-[a-z0-9]{4})\b/g;

export function boxOf(status) {
  const b = BOX_OF[status];
  if (!b) throw new Error(`unknown status ${status}`);
  return b;
}

export function newId(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}-${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}`;
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = crypto.randomBytes(4);
  let rnd = '';
  for (const b of bytes) rnd += alphabet[b % alphabet.length];
  return `${stamp}-${rnd}`;
}

export function isId(s) {
  return typeof s === 'string' && /^\d{8}-\d{6}-[a-z0-9]{4}$/.test(s);
}

function fileFor(peer, status, id) {
  return path.join(paths.mail(peer, boxOf(status)), `${id}.json`);
}

/** Create a message. `fields` must contain from, to, type, title, body. */
export function createMessage(fields) {
  const now = new Date().toISOString();
  if (!PEERS.includes(fields.from) || !PEERS.includes(fields.to) || fields.from === fields.to) {
    throw new DuoError('bad_peer', `invalid from/to: ${fields.from} → ${fields.to}`);
  }
  if (!TYPES.includes(fields.type)) throw new DuoError('bad_type', `invalid type: ${fields.type}`);
  const id = fields.id || newId();
  const initial = WORK_TYPES.includes(fields.type) ? 'queued' : 'unread';
  let body = String(fields.body ?? '');
  const meta = { delivery_log: [], ...(fields.meta || {}) };
  if (Buffer.byteLength(body, 'utf8') > BODY_INLINE_MAX) {
    const dir = ensureDir(paths.attachments(id));
    const f = path.join(dir, 'body.md');
    fs.writeFileSync(f, body, { mode: 0o600 });
    meta.body_file = f;
    body = `(Long content, ${Buffer.byteLength(body, 'utf8')} bytes, stored in the file ${f} — read that file.)`;
  }
  const msg = {
    id,
    thread_id: fields.thread_id || id,
    reply_to: fields.reply_to || null,
    from: fields.from,
    to: fields.to,
    type: fields.type,
    title: String(fields.title || '').slice(0, 300),
    body,
    acceptance: Array.isArray(fields.acceptance) ? fields.acceptance.map(String) : [],
    attachments: Array.isArray(fields.attachments) ? fields.attachments : [],
    cwd: fields.cwd || null,
    expects_reply: WORK_TYPES.includes(fields.type),
    delivery: fields.delivery || null,
    hop: Number.isInteger(fields.hop) ? fields.hop : 0,
    status: initial,
    created_at: now,
    updated_at: now,
    deadline_s: fields.deadline_s ?? null,
    result: fields.result ?? null,
    meta,
  };
  withLock(`msg-${id}`, () => writeJSONAtomic(fileFor(msg.to, msg.status, id), msg));
  log('create', id, `${msg.from}->${msg.to}`, msg.type);
  return msg;
}

function locate(id) {
  if (!isId(id)) return null;
  const hits = [];
  for (const peer of PEERS) {
    for (const box of BOXES) {
      const f = path.join(paths.mail(peer, box), `${id}.json`);
      if (fs.existsSync(f)) {
        const msg = readJSON(f, null);
        if (msg) hits.push({ msg, file: f });
      }
    }
  }
  if (!hits.length) return null;
  // A crash between rename and unlink can leave two copies: newest wins.
  hits.sort((a, b) => String(b.msg.updated_at).localeCompare(String(a.msg.updated_at)));
  return hits[0];
}

export function getMessage(id) {
  const hit = locate(id);
  return hit ? hit.msg : null;
}

export function requireMessage(id) {
  const m = getMessage(id);
  if (!m) throw new DuoError('not_found', `Message ${id} not found`);
  return m;
}

/** Atomically read-modify-write. fn(msg) mutates or returns a new message. */
export function updateMessage(id, fn) {
  return withLock(`msg-${id}`, () => {
    const hit = locate(id);
    if (!hit) throw new DuoError('not_found', `Message ${id} not found`);
    const before = hit.msg;
    const draft = structuredClone(before);
    const out = fn(draft) || draft;
    out.updated_at = new Date().toISOString();
    const target = fileFor(out.to, out.status, id);
    writeJSONAtomic(target, out);
    // Remove every other copy (normally exactly one: the old location).
    for (const peer of PEERS) {
      for (const box of BOXES) {
        const f = path.join(paths.mail(peer, box), `${id}.json`);
        if (f !== target && fs.existsSync(f)) fs.rmSync(f, { force: true });
      }
    }
    if (before.status !== out.status) log('status', id, before.status, '->', out.status);
    return out;
  });
}

export function addDeliveryLog(msg, entry) {
  msg.meta.delivery_log = [...(msg.meta.delivery_log || []), { at: new Date().toISOString(), ...entry }].slice(-20);
  return msg;
}

/** List messages. filter: { to, from, boxes, types, statuses } */
export function listMessages(filter = {}) {
  const peers = filter.to ? [filter.to] : PEERS;
  const boxes = filter.boxes || BOXES;
  const out = new Map();
  for (const peer of peers) {
    for (const box of boxes) {
      const dir = paths.mail(peer, box);
      let names = [];
      try { names = fs.readdirSync(dir); } catch { continue; }
      for (const n of names) {
        if (!n.endsWith('.json')) continue;
        const m = readJSON(path.join(dir, n), null);
        if (!m) continue;
        if (filter.from && m.from !== filter.from) continue;
        if (filter.types && !filter.types.includes(m.type)) continue;
        if (filter.statuses && !filter.statuses.includes(m.status)) continue;
        const prev = out.get(m.id);
        if (!prev || String(m.updated_at) > String(prev.updated_at)) out.set(m.id, m);
      }
    }
  }
  return [...out.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export function thread(threadId) {
  return listMessages().filter((m) => m.thread_id === threadId);
}

export function isExpired(msg, now = Date.now()) {
  if (!['queued', 'delivered'].includes(msg.status) || !msg.deadline_s) return false;
  return now - Date.parse(msg.created_at) > msg.deadline_s * 1000;
}

export function ensureMailDirs() {
  for (const p of PEERS) for (const b of BOXES) ensureDir(paths.mail(p, b));
}

/** One-line summary used in inboxes, hook context and notifications. */
export function summary(m) {
  const t = m.type;
  const st = m.type === 'result' && m.result?.status ? ` [${m.result.status}]` : '';
  return `${m.id} · ${t}${st} ${m.from}→${m.to} · ${m.title || '(no title)'} · ${m.status}`;
}
