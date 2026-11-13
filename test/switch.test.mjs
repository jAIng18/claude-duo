import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox, makeConfig } from './helpers.mjs';

const sb = sandbox();
after(() => sb.cleanup());
const S = await import('../plugin/lib/switch.mjs');
const cfg = await makeConfig(sb);
const stateFile = path.join(sb.home, 'state', 'switch.json');

const q = (session, weekly, extra = {}) => ({ ok: true, session: { pct: session, resets_at: null }, weekly: { pct: weekly, resets_at: null }, ...extra });

test('defaults: manual, threshold 90, the peer on ~/.claude (else A)', () => {
  fs.rmSync(stateFile, { force: true });
  assert.deepEqual(S.readSwitch(cfg), { active: 'A', mode: 'manual', threshold: 90, changed_at: null, reason: null });
});

test('useAccount moves the pointer and turns auto off', () => {
  S.setMode(cfg, 'auto', 80);
  const s = S.useAccount(cfg, 'B');
  assert.equal(s.active, 'B');
  assert.equal(s.mode, 'manual');
  assert.equal(s.threshold, 80);
  assert.throws(() => S.useAccount(cfg, 'C'), /A hoặc B/);
  assert.throws(() => S.setMode(cfg, 'auto', 20), /50 đến 100/);
  assert.throws(() => S.setMode(cfg, 'sometimes'), /mode/);
});

test('usedPct: higher of 5h and week, passed resets count as 0, logged out is unknown', () => {
  const now = Date.parse('2026-01-01T00:00:00Z');
  assert.equal(S.usedPct(q(30, 95), now), 95);
  assert.equal(S.usedPct({ session: { pct: 99, resets_at: '2025-12-31T23:00:00Z' }, weekly: { pct: 40, resets_at: '2026-01-05T00:00:00Z' } }, now), 40);
  assert.equal(S.usedPct({ ok: false, error: 'token_expired', stale: true, ...q(50, 10) }, now), 50);
  assert.equal(S.usedPct({ ok: false, error: 'not_logged_in' }, now), null);
  assert.equal(S.usedPct(null, now), null);
});

test('decide: only in auto, only when the other account has room', () => {
  const st = { active: 'A', mode: 'auto', threshold: 90 };
  assert.equal(S.decide({ ...st, mode: 'manual' }, { A: q(100, 0), B: q(0, 0) }).switch, false);
  assert.equal(S.decide(st, { A: q(89, 50), B: q(0, 0) }).switch, false);
  const d = S.decide(st, { A: q(90, 10), B: q(20, 30) });
  assert.equal(d.switch, true);
  assert.equal(d.to, 'B');
  assert.equal(S.decide(st, { A: q(10, 100), B: q(5, 5) }).to, 'B'); // weekly full counts too
  assert.equal(S.decide(st, { A: q(95, 0), B: q(92, 0) }).reason, 'both_full');
  assert.equal(S.decide(st, { A: q(95, 0), B: { ok: false, error: 'not_logged_in' } }).reason, 'other_unknown');
  assert.equal(S.decide(st, { A: null, B: q(0, 0) }).switch, false); // no numbers yet: stay
});

test('applyAuto saves the move; resolveDir prints the dir of the active account', async () => {
  S.useAccount(cfg, 'A');
  S.setMode(cfg, 'auto', 90);
  const r = S.applyAuto(cfg, { A: q(97, 10), B: q(3, 3) });
  assert.equal(r.switched, true);
  assert.equal(S.readSwitch(cfg).active, 'B');
  assert.match(S.readSwitch(cfg).reason, /^auto: A 97% ≥ 90%, B 3%/);
  // Fresh cached quota decides at launch, without fetching.
  const now = new Date().toISOString();
  fs.writeFileSync(path.join(sb.home, 'state', 'quota-A.json'), JSON.stringify({ ...q(5, 5), fetched_at: now }));
  fs.writeFileSync(path.join(sb.home, 'state', 'quota-B.json'), JSON.stringify({ ...q(99, 5), fetched_at: now }));
  let fetched = 0;
  const dir = await S.resolveDir(cfg, { quotaFor: async () => { fetched++; return null; } });
  assert.equal(fetched, 0);
  assert.equal(dir, path.resolve(sb.a)); // B was full, A has room → back to A
  S.useAccount(cfg, 'B');
  assert.equal(await S.resolveDir(cfg), path.resolve(sb.b)); // manual: no quota involved
});

test('resolveDir: a stuck quota request does not hold the launch', async () => {
  S.setMode(cfg, 'auto', 90);
  fs.rmSync(path.join(sb.home, 'state', 'quota-A.json'), { force: true });
  fs.rmSync(path.join(sb.home, 'state', 'quota-B.json'), { force: true });
  const t = Date.now();
  const dir = await S.resolveDir(cfg, { quotaFor: () => new Promise(() => {}), timeoutMs: 100 });
  assert.ok(Date.now() - t < 1000);
  assert.equal(dir, path.resolve(sb.b));
});
