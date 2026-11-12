import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { sandbox } from './helpers.mjs';

const sb = sandbox();
after(() => sb.cleanup());
const Q = await import('../plugin/lib/quota.mjs');
const P = await import('../plugin/lib/paths.mjs');

test('keychain service: plain name for ~/.claude, sha256 suffix otherwise', () => {
  assert.equal(Q.keychainService('~/.claude'), 'Claude Code-credentials');
  const dir = path.join(P.HOME, '.claude-b');
  const h = crypto.createHash('sha256').update(dir).digest('hex').slice(0, 8);
  assert.equal(Q.keychainService('~/.claude-b/'), `Claude Code-credentials-${h}`);
});

test('planLabel', () => {
  assert.equal(Q.planLabel('max', 'default_claude_max_5x'), 'Max 5x');
  assert.equal(Q.planLabel('max', 'default_claude_max_20x'), 'Max 20x');
  assert.equal(Q.planLabel('pro', 'default_claude_ai'), 'Pro');
  assert.equal(Q.planLabel(null, null), null);
});

test('parseUsage reads `limits`, falls back to five_hour/seven_day', () => {
  const a = Q.parseUsage({
    five_hour: { utilization: 99 },
    limits: [
      { kind: 'session', group: 'session', percent: 16, resets_at: 'r1' },
      { kind: 'weekly_all', group: 'weekly', percent: 11, resets_at: 'r2' },
      { kind: 'weekly_scoped', group: 'weekly', percent: 7, resets_at: 'r3', scope: { model: { display_name: 'Fable' } } },
    ],
    extra_usage: { is_enabled: false },
  });
  assert.deepEqual(a, { session: { pct: 16, resets_at: 'r1' }, weekly: { pct: 11, resets_at: 'r2' }, scoped: [{ label: 'Fable', pct: 7, resets_at: 'r3' }], extra: false });
  const b = Q.parseUsage({ five_hour: { utilization: 15.4, resets_at: 'x' }, seven_day: { utilization: 3, resets_at: 'y' }, seven_day_opus: { utilization: 1 } });
  assert.deepEqual(b.session, { pct: 15, resets_at: 'x' });
  assert.deepEqual(b.weekly, { pct: 3, resets_at: 'y' });
  assert.deepEqual(b.scoped, [{ label: 'Opus', pct: 1, resets_at: null }]);
  assert.deepEqual(Q.parseUsage(null), { session: null, weekly: null, scoped: [], extra: false });
});

test('quotaFor: errors never throw, expired token is not sent', async () => {
  const creds = (o) => async () => ({ code: 0, stdout: JSON.stringify({ claudeAiOauth: { accessToken: 'tok', subscriptionType: 'pro', ...o } }) });
  let calls = 0;
  const fetchImpl = (status, body) => async (url, init) => {
    calls++;
    assert.equal(url, Q.USAGE_URL);
    assert.equal(init.headers.Authorization, 'Bearer tok');
    return { status, json: async () => body };
  };
  assert.deepEqual(await Q.quotaFor(sb.b, { runImpl: async () => ({ code: 44, stdout: '' }) }), { ok: false, error: 'not_logged_in' });
  const exp = await Q.quotaFor(sb.b, { runImpl: creds({ expiresAt: Date.now() - 1000 }), fetchImpl: fetchImpl(200, {}) });
  assert.equal(exp.error, 'token_expired');
  assert.equal(calls, 0);
  assert.equal((await Q.quotaFor(sb.b, { runImpl: creds({}), fetchImpl: fetchImpl(401, {}) })).error, 'token_expired');
  assert.equal((await Q.quotaFor(sb.b, { runImpl: creds({}), fetchImpl: fetchImpl(429, {}) })).error, 'rate_limited');
  assert.equal((await Q.quotaFor(sb.b, { runImpl: creds({}), fetchImpl: async () => { throw new Error('offline'); } })).error, 'network');
  const ok = await Q.quotaFor(sb.b, { runImpl: creds({ expiresAt: Date.now() + 3600e3 }), fetchImpl: fetchImpl(200, { five_hour: { utilization: 40, resets_at: 'z' } }) });
  assert.equal(ok.ok, true);
  assert.equal(ok.plan, 'Pro');
  assert.deepEqual(ok.session, { pct: 40, resets_at: 'z' });
});

test('LocalUsage reads transcripts incrementally, dedupes and drops old turns', () => {
  const dir = path.join(sb.a, 'projects', '-proj');
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, 's.jsonl');
  const now = Date.now();
  const line = (id, ago, out) => JSON.stringify({ type: 'assistant', timestamp: new Date(now - ago).toISOString(), message: { id, usage: { input_tokens: 1, cache_read_input_tokens: 9, output_tokens: out } } });
  fs.writeFileSync(f, `${line('m1', 6 * 3600e3, 100)}\n${line('m2', 60e3, 5)}\n${line('m2', 60e3, 5)}\n`);
  const lu = new Q.LocalUsage(sb.a);
  let r = lu.update(now);
  assert.deepEqual(r.tokens_5h, { input: 10, output: 5, messages: 1 });
  fs.appendFileSync(f, `${line('m3', 1000, 7)}\n{"type":"assist`); // half-written last line
  r = lu.update(now);
  assert.deepEqual(r.tokens_5h, { input: 20, output: 12, messages: 2 });
  assert.equal(r.last_activity_at, new Date(now - 1000).toISOString());
});

test('formatQuota shows bars, errors and stale numbers', () => {
  const now = Date.parse('2026-01-01T00:00:00Z');
  const text = Q.formatQuota({ peers: {
    A: { name: 'A', state: 'busy', open_tasks: 1, tokens_5h: { input: 0, output: 1500, messages: 3 }, quota: { ok: true, plan: 'Max 5x', session: { pct: 50, resets_at: '2026-01-01T01:30:00Z' }, weekly: { pct: 10, resets_at: '2026-01-03T00:00:00Z' }, scoped: [] } },
    B: { name: 'Maker', state: 'offline', quota: { ok: false, error: 'token_expired', session: { pct: 5, resets_at: null } } },
  } }, now);
  assert.match(text, /A · Max 5x · đang làm · 1 việc duo đang mở/);
  assert.match(text, /5 giờ +█{10}░{10} +50% +reset sau 1h30/);
  assert.match(text, /reset sau 2d0h/);
  assert.match(text, /B \(Maker\)/);
  assert.match(text, /token hết hạn.*lần đo trước/);
  assert.match(text, /3 lượt trả lời · 2k token ra/);
});
