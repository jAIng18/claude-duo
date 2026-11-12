// Plan quota (the numbers `/usage` shows) of both accounts, plus live local
// activity, for `duo quota` and the floating `duo monitor` window.
//
// Quota source: each account's OAuth token from the macOS Keychain
//   default dir   → "Claude Code-credentials"
//   any other dir → "Claude Code-credentials-<first 8 hex of sha256(dir)>"
// sent to GET https://api.anthropic.com/api/oauth/usage. That endpoint is
// internal and undocumented: everything here degrades to an error value,
// never an exception. The token goes to that one Anthropic URL only, is never
// logged or written anywhere, and is never refreshed here (refreshing rotates
// it and could log the running Claude Code out). When it has expired we say
// so and wait until Claude Code refreshes it.
//
// Live part (seconds): session states from the duo registry, open duo
// messages, and tokens of the last 5 hours read incrementally from the
// account's transcripts (<config_dir>/projects/**/*.jsonl).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { normalizeDir, isDefaultConfigDir, paths } from './paths.mjs';
import { PEERS, label } from './config.mjs';
import { readJSON, writeJSONAtomic } from './fsutil.mjs';
import { listSessions } from './registry.mjs';
import { listMessages } from './mailbox.mjs';

export const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const WINDOW_MS = 5 * 3600 * 1000;
const ACTIVE_EVERY_MS = 20 * 1000; // re-ask at most this often while an account is working
const IDLE_EVERY_MS = 120 * 1000;
const EXPIRED_RECHECK_MS = 30 * 1000;
const BACKOFF_MS = 5 * 60 * 1000; // after HTTP 429

// ---------------------------------------------------------------- credentials

export function keychainService(configDir) {
  if (isDefaultConfigDir(configDir)) return 'Claude Code-credentials';
  const h = crypto.createHash('sha256').update(normalizeDir(configDir)).digest('hex').slice(0, 8);
  return `Claude Code-credentials-${h}`;
}

export function planLabel(sub, tier) {
  const s = String(sub || '').toLowerCase();
  const m = String(tier || '').match(/(\d+)x/);
  if (s === 'max') return m ? `Max ${m[1]}x` : 'Max';
  if (!s) return null;
  return s[0].toUpperCase() + s.slice(1);
}

function run(cmd, args, timeout = 5000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, encoding: 'utf8', maxBuffer: 1 << 20 }, (err, stdout) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: stdout || '' });
    });
  });
}

/** { token, expires_at, plan } or { error: 'not_logged_in' | 'keychain' } */
export async function readCredentials(configDir, { runImpl = run } = {}) {
  const r = await runImpl('security', ['find-generic-password', '-s', keychainService(configDir), '-w']);
  if (r.code === 44) return { error: 'not_logged_in' };
  if (r.code !== 0) return { error: 'keychain' };
  try {
    const o = JSON.parse(r.stdout.trim()).claudeAiOauth || {};
    if (!o.accessToken) return { error: 'not_logged_in' };
    return { token: o.accessToken, expires_at: Number(o.expiresAt) || null, plan: planLabel(o.subscriptionType, o.rateLimitTier) };
  } catch { return { error: 'keychain' }; }
}

// --------------------------------------------------------------------- usage

const pct = (v) => (Number.isFinite(Number(v)) && v !== null ? Math.round(Number(v)) : null);
const bar = (p, r) => (p === null ? null : { pct: p, resets_at: r || null });

/** Normalise the endpoint's JSON into { session, weekly, scoped[], extra }. */
export function parseUsage(j) {
  const out = { session: null, weekly: null, scoped: [], extra: false };
  if (!j || typeof j !== 'object') return out;
  if (Array.isArray(j.limits) && j.limits.length) {
    for (const l of j.limits) {
      if (!l || typeof l !== 'object') continue;
      const b = bar(pct(l.percent), l.resets_at);
      if (!b) continue;
      if (l.kind === 'session') out.session = b;
      else if (l.kind === 'weekly_all') out.weekly = b;
      else if (l.group === 'weekly' || /weekly/.test(String(l.kind))) {
        const sc = l.scope || {};
        const name = (sc.model && (sc.model.display_name || sc.model.id)) || (sc.surface && (sc.surface.display_name || sc.surface)) || l.kind;
        out.scoped.push({ label: String(name), ...b });
      }
    }
  }
  const util = (k) => j[k] && bar(pct(j[k].utilization), j[k].resets_at);
  if (!out.session) out.session = util('five_hour') || null;
  if (!out.weekly) out.weekly = util('seven_day') || null;
  if (!out.scoped.length) {
    for (const [k, name] of [['seven_day_opus', 'Opus'], ['seven_day_sonnet', 'Sonnet']]) {
      const b = util(k);
      if (b) out.scoped.push({ label: name, ...b });
    }
  }
  out.extra = !!(j.extra_usage && j.extra_usage.is_enabled);
  return out;
}

export async function fetchUsage(token, { fetchImpl = globalThis.fetch, timeoutMs = 10000 } = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetchImpl(USAGE_URL, {
      headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20', 'User-Agent': 'claude-duo', Accept: 'application/json' },
      signal: ac.signal,
    });
    let json = null;
    try { json = await r.json(); } catch { /* not JSON */ }
    return { status: r.status, json };
  } catch {
    return { status: 0, json: null };
  } finally { clearTimeout(t); }
}

/** One account: credentials → endpoint → { ok, plan, ...parsed } or { ok:false, error }. */
export async function quotaFor(configDir, deps = {}) {
  const c = await readCredentials(configDir, deps);
  if (c.error) return { ok: false, error: c.error };
  const base = { plan: c.plan, token_expires_at: c.expires_at ? new Date(c.expires_at).toISOString() : null };
  if (c.expires_at && c.expires_at < Date.now()) return { ok: false, error: 'token_expired', ...base };
  const r = await fetchUsage(c.token, deps);
  if (r.status === 200 && r.json) return { ok: true, ...base, ...parseUsage(r.json), fetched_at: new Date().toISOString() };
  const error = r.status === 401 ? 'token_expired' : r.status === 429 ? 'rate_limited' : r.status === 0 ? 'network' : `http_${r.status}`;
  return { ok: false, error, ...base };
}

// --------------------------------------------------- local tokens (5h window)

/** Incremental reader of one account's transcripts. */
export class LocalUsage {
  constructor(configDir) {
    this.root = path.join(normalizeDir(configDir), 'projects');
    this.files = new Map(); // file → { offset, rest }
    this.msgs = new Map(); // message id → { t, input, output }
    this.last = null;
  }

  _scanDir(dir, depth, since, out) {
    if (depth > 4) return;
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const d of ents) {
      const f = path.join(dir, d.name);
      if (d.isDirectory()) this._scanDir(f, depth + 1, since, out);
      else if (d.name.endsWith('.jsonl')) {
        let st; try { st = fs.statSync(f); } catch { continue; }
        if (st.mtimeMs >= since) out.push([f, st.size]);
      }
    }
  }

  _read(file, size) {
    let s = this.files.get(file);
    if (!s || size < s.offset) { s = { offset: 0, rest: '' }; this.files.set(file, s); }
    if (size === s.offset) return;
    let fd;
    try {
      fd = fs.openSync(file, 'r');
      const buf = Buffer.alloc(size - s.offset);
      fs.readSync(fd, buf, 0, buf.length, s.offset);
      s.offset = size;
      const lines = (s.rest + buf.toString('utf8')).split('\n');
      s.rest = lines.pop();
      for (const raw of lines) {
        if (!raw.includes('"usage"')) continue;
        let e; try { e = JSON.parse(raw); } catch { continue; }
        const m = e && e.message;
        if (e.type !== 'assistant' || !m || !m.usage) continue;
        const t = Date.parse(e.timestamp);
        if (!Number.isFinite(t)) continue;
        const u = m.usage;
        this.msgs.set(m.id || e.uuid, {
          t,
          input: (Number(u.input_tokens) || 0) + (Number(u.cache_creation_input_tokens) || 0) + (Number(u.cache_read_input_tokens) || 0),
          output: Number(u.output_tokens) || 0,
        });
        if (!this.last || t > this.last) this.last = t;
      }
    } catch { /* unreadable: skip */ } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ } }
  }

  update(now = Date.now()) {
    const since = now - WINDOW_MS;
    const found = [];
    this._scanDir(this.root, 0, since, found);
    for (const [f, size] of found) this._read(f, size);
    const tot = { input: 0, output: 0, messages: 0 };
    for (const [id, m] of this.msgs) {
      if (m.t < since) { this.msgs.delete(id); continue; }
      tot.input += m.input; tot.output += m.output; tot.messages++;
    }
    return { tokens_5h: tot, last_activity_at: this.last ? new Date(this.last).toISOString() : null };
  }
}

// --------------------------------------------------------------- duo state

const OPEN = ['queued', 'delivered', 'accepted', 'in_progress', 'needs_info'];

function duoState(peer) {
  const sess = listSessions(peer);
  const states = sess.map((s) => s.state);
  const state = states.includes('busy') ? 'busy' : states.includes('awaiting_user') ? 'awaiting_user' : sess.length ? 'idle' : 'offline';
  const open = listMessages({ to: peer, types: ['task', 'question'], statuses: OPEN });
  return { state, sessions: sess.length, open_tasks: open.length, working_on: open.filter((m) => m.status === 'in_progress').map((m) => m.title).slice(0, 3) };
}

// ------------------------------------------------------------------ watcher

const cacheFile = (peer) => path.join(paths.state(), `quota-${peer}.json`);

/**
 * Keeps a snapshot of both accounts up to date. Calls onChange(snapshot)
 * whenever something visible changed. Quota is re-fetched at most every 20s
 * while an account is active, every 2 min otherwise.
 */
export class QuotaWatcher {
  constructor(cfg, { onChange = () => {}, deps = {} } = {}) {
    this.cfg = cfg; this.onChange = onChange; this.deps = deps;
    this.peers = {};
    for (const p of PEERS) {
      const cached = readJSON(cacheFile(p), null);
      this.peers[p] = {
        local: new LocalUsage(cfg.peers[p].config_dir),
        quota: cached && cached.ok ? { ...cached, stale: true } : null,
        last_try: 0, next_at: 0, active: true, fetching: false, live: null,
      };
    }
    this.watchers = []; this.timers = []; this.lastJson = '';
  }

  snapshot() {
    const out = { at: new Date().toISOString(), peers: {} };
    for (const p of PEERS) {
      const s = this.peers[p];
      out.peers[p] = {
        name: this.cfg.peers[p].name || label(this.cfg, p), config_dir: normalizeDir(this.cfg.peers[p].config_dir),
        quota: s.quota, ...(s.live || {}),
      };
    }
    return out;
  }

  _emit(force = false) {
    const snap = this.snapshot();
    const key = JSON.stringify({ ...snap, at: undefined });
    if (!force && key === this.lastJson) return;
    this.lastJson = key;
    this.onChange(snap);
  }

  refreshLocal(peer) {
    const s = this.peers[peer];
    const prev = s.live && s.live.last_activity_at;
    let duo = { state: 'offline', sessions: 0, open_tasks: 0, working_on: [] };
    try { duo = duoState(peer); } catch { /* no duo home yet */ }
    s.live = { ...duo, ...s.local.update() };
    if (s.live.last_activity_at !== prev || duo.state === 'busy') s.active = true;
  }

  async refreshQuota(peer, { force = false } = {}) {
    const s = this.peers[peer];
    const now = Date.now();
    if (s.fetching || (!force && now < s.next_at) || (force && now - s.last_try < 5000)) return;
    s.fetching = true; s.last_try = now;
    const wasActive = s.active; s.active = false;
    let q;
    try { q = await quotaFor(this.cfg.peers[peer].config_dir, this.deps); } catch { q = { ok: false, error: 'network' }; }
    s.fetching = false;
    if (q.ok) {
      s.quota = q;
      try { writeJSONAtomic(cacheFile(peer), q); } catch { /* cache is optional */ }
      s.next_at = Date.now() + (wasActive ? ACTIVE_EVERY_MS : IDLE_EVERY_MS);
    } else {
      // Keep the last good numbers, flagged as stale, next to the error.
      const keep = s.quota && s.quota.session ? { ...s.quota, stale: true } : {};
      s.quota = { ...keep, ok: false, error: q.error, plan: q.plan || keep.plan || null };
      s.next_at = Date.now() + (q.error === 'rate_limited' ? BACKOFF_MS : q.error === 'token_expired' ? EXPIRED_RECHECK_MS : ACTIVE_EVERY_MS);
      if (q.error !== 'rate_limited') s.active = s.active || wasActive;
    }
    this._emit();
  }

  /** One round: local state for both, quota where due. */
  async tick({ force = false } = {}) {
    for (const p of PEERS) this.refreshLocal(p);
    this._emit();
    for (const p of PEERS) {
      const s = this.peers[p];
      if (s.active && s.quota && s.quota.ok) s.next_at = Math.min(s.next_at, s.last_try + ACTIVE_EVERY_MS);
    }
    await Promise.all(PEERS.map((p) => this.refreshQuota(p, { force })));
  }

  start() {
    let pending = null;
    const soon = () => { if (!pending) pending = setTimeout(() => { pending = null; this.tick().catch(() => {}); }, 700); };
    const dirs = [];
    for (const p of PEERS) dirs.push(path.join(normalizeDir(this.cfg.peers[p].config_dir), 'projects'), paths.registry(p), paths.mail(p, 'new'), paths.mail(p, 'cur'));
    for (const d of dirs) {
      try { this.watchers.push(fs.watch(d, { recursive: true }, soon)); } catch { /* missing dir: the timer still covers it */ }
    }
    this.timers.push(setInterval(() => this.tick().catch(() => {}), 5000));
    this.timers.push(setInterval(() => this._emit(true), 30000)); // heartbeat
    return this.tick();
  }

  stop() {
    for (const w of this.watchers) try { w.close(); } catch { /* ignore */ }
    for (const t of this.timers) clearInterval(t);
    this.watchers = []; this.timers = [];
  }
}

// ------------------------------------------------------------------ text out

export const ERROR_TEXT = {
  token_expired: 'token hết hạn — mở account này một lần để Claude Code tự làm mới',
  not_logged_in: 'chưa đăng nhập',
  keychain: 'không đọc được Keychain',
  rate_limited: 'bị giới hạn số lần hỏi, thử lại sau 5 phút',
  network: 'không kết nối được',
};

export function fmtTokens(n) {
  if (!n) return '0';
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(n);
}

export function fmtReset(iso, now = Date.now()) {
  const t = Date.parse(iso || '');
  if (!Number.isFinite(t)) return '';
  const m = Math.max(0, Math.round((t - now) / 60000));
  if (m < 60) return `${m}m`;
  if (m < 48 * 60) return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`;
  return `${Math.floor(m / 1440)}d${Math.floor((m % 1440) / 60)}h`;
}

const STATE_TEXT = { busy: 'đang làm', awaiting_user: 'chờ bạn', idle: 'rảnh', offline: 'không mở' };

export function formatQuota(snap, now = Date.now()) {
  const out = [];
  const line = (name, b) => {
    if (!b) return;
    const n = Math.round(Math.min(100, Math.max(0, b.pct)) / 5);
    out.push(`  ${name.padEnd(8)} ${'█'.repeat(n)}${'░'.repeat(20 - n)} ${String(b.pct).padStart(3)}%  reset sau ${fmtReset(b.resets_at, now)}`);
  };
  for (const p of PEERS) {
    const x = snap.peers[p]; const q = x.quota || {};
    out.push(`${x.name === p ? p : `${p} (${x.name})`}${q.plan ? ` · ${q.plan}` : ''} · ${STATE_TEXT[x.state] || x.state}${x.open_tasks ? ` · ${x.open_tasks} việc duo đang mở` : ''}`);
    if (q.error) out.push(`  ⚠ ${ERROR_TEXT[q.error] || q.error}${q.session ? ' (số dưới đây là lần đo trước)' : ''}`);
    line('5 giờ', q.session); line('Tuần', q.weekly);
    for (const s of q.scoped || []) line(s.label, s);
    if (x.tokens_5h) out.push(`  5 giờ qua trên máy này: ${x.tokens_5h.messages} lượt trả lời · ${fmtTokens(x.tokens_5h.output)} token ra`);
    out.push('');
  }
  return out.join('\n').trimEnd();
}
