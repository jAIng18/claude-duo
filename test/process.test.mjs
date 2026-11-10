// Hooks and the MCP server, exercised as real child processes (the way
// Claude Code runs them).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sandbox, makeConfig } from './helpers.mjs';

const sb = sandbox();
const DUO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugin', 'bin', 'duo.mjs');
const M = await import('../plugin/lib/mailbox.mjs');
const R = await import('../plugin/lib/registry.mjs');
const A = await import('../plugin/lib/actions.mjs');
let cfg;

before(async () => { cfg = await makeConfig(sb); M.ensureMailDirs(); });
after(() => sb.cleanup());

const SID_B = 'bbbbbbbb-0000-0000-0000-000000000002';
const SID_A = 'aaaaaaaa-0000-0000-0000-000000000001';

function hook(event, input, env = sb.envB) {
  const r = spawnSync(process.execPath, [DUO, 'hook', event], { input: JSON.stringify(input), env, encoding: 'utf8', timeout: 20000 });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout ? JSON.parse(r.stdout) : {};
}

const base = (sid = SID_B) => ({ session_id: sid, cwd: sb.root, transcript_path: '/tmp/x.jsonl' });

test('SessionStart registers the session and announces identity + pending work', async () => {
  const { message } = await A.send(cfg, 'A', SID_A, { type: 'task', title: 'việc chờ', body: 'b' }, { deliverNow: false });
  const out = hook('SessionStart', { ...base(), hook_event_name: 'SessionStart', source: 'startup' });
  const ctx = out.hookSpecificOutput.additionalContext;
  assert.equal(out.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.match(ctx, /peer B:Maker/);
  assert.ok(ctx.includes(message.id));
  const s = R.getSession('B', SID_B);
  assert.equal(s.state, 'idle');
  assert.equal(s.cwd, sb.root);
});

test('SessionStart gives the role to a plain `claude` session, not to one claude-duo launched', () => {
  const { DUO_LAUNCHED, ...plain } = sb.envB;
  const own = hook('SessionStart', { ...base('eeeeeeee-0000-0000-0000-000000000005') }, plain).hookSpecificOutput.additionalContext;
  assert.match(own, /Your role, set by the user:/);
  assert.match(own, /ALWAYS finish with duo_reply/);
  const launched = hook('SessionStart', { ...base('eeeeeeee-0000-0000-0000-000000000006') }, { ...plain, DUO_LAUNCHED: '1' }).hookSpecificOutput.additionalContext;
  assert.doesNotMatch(launched, /Your role, set by the user:/);
});

test('UserPromptSubmit with a bootstrap prompt marks the message picked up and busy', async () => {
  const { message } = await A.send(cfg, 'A', SID_A, { type: 'task', title: 'pick me', body: 'b' }, { deliverNow: false });
  hook('UserPromptSubmit', { ...base(), prompt: `[claude-duo] New TASK ${message.id} from A:Planner: "pick me".` });
  const m = M.getMessage(message.id);
  assert.equal(m.meta.picked_up_by, SID_B);
  assert.equal(m.status, 'delivered');
  assert.equal(R.getSession('B', SID_B).state, 'busy');
});

test('Notification(permission_prompt) → awaiting_user; Stop → idle', () => {
  hook('Notification', { ...base(), notification_type: 'permission_prompt', message: 'Claude needs your permission' });
  assert.equal(R.getSession('B', SID_B).state, 'awaiting_user');
  hook('Notification', { ...base(), notification_type: 'idle_prompt' });
  assert.equal(R.getSession('B', SID_B).state, 'awaiting_user');
});

test('Stop picks up a queued message and blocks with its bootstrap (once per message)', () => {
  const pending = M.listMessages({ to: 'B', statuses: ['queued'] });
  assert.ok(pending.length >= 1);
  const out = hook('Stop', { ...base(), stop_hook_active: false, last_assistant_message: 'ok' });
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /^\[claude-duo\] New TASK /);
  const id = out.reason.match(/\d{8}-\d{6}-[a-z0-9]{4}/)[0];
  assert.equal(M.getMessage(id).meta.claimed_by, SID_B);
  // the same message is not announced twice to the same session
  const out2 = hook('Stop', { ...base(), stop_hook_active: true });
  if (out2.decision === 'block') assert.ok(!out2.reason.includes(id));
});

test('Stop respects max_auto_continue; a new prompt resets the counter', () => {
  for (let i = 0; i < 3; i++) M.createMessage({ from: 'A', to: 'B', type: 'task', title: `burst ${i}`, body: 'b' });
  let blocks = 0;
  for (let i = 0; i < 12; i++) if (hook('Stop', { ...base(), stop_hook_active: true }).decision === 'block') blocks++;
  assert.ok(blocks <= cfg.limits.max_auto_continue, `blocked ${blocks} times`);
  const before = R.getSession('B', SID_B).auto_continue_count;
  assert.ok(before >= 1);
  hook('UserPromptSubmit', { ...base(), prompt: 'người dùng gõ gì đó' });
  assert.equal(R.getSession('B', SID_B).auto_continue_count, 0);
});

test('Stop reminds about duo_reply for background work, then auto-replies', async () => {
  const { message } = await A.send(cfg, 'A', SID_A, { type: 'task', title: 'bg work', body: 'b' }, { deliverNow: false });
  const SID = 'cccccccc-0000-0000-0000-000000000003';
  M.updateMessage(message.id, (x) => { x.meta.delivered_via = 'background'; });
  A.get(cfg, 'B', SID, message.id); // handler_session = SID
  hook('SessionStart', { ...base(SID), source: 'startup' });
  const r1 = hook('Stop', { ...base(SID), stop_hook_active: false, last_assistant_message: 'đã làm xong phần 1' });
  assert.equal(r1.decision, 'block');
  assert.match(r1.reason, /have not called duo_reply/);
  const r2 = hook('Stop', { ...base(SID), stop_hook_active: true, last_assistant_message: 'đã làm xong phần 1' });
  assert.equal(r2.decision, 'block');
  hook('Stop', { ...base(SID), stop_hook_active: true, last_assistant_message: 'KẾT QUẢ CUỐI' });
  const m = M.getMessage(message.id);
  assert.equal(m.status, 'done');
  assert.equal(m.result.auto_result, true);
  assert.equal(m.result.summary, 'KẾT QUẢ CUỐI');
  const res = M.listMessages({ to: 'A', types: ['result'] }).find((x) => x.reply_to === message.id);
  assert.ok(res, 'a result message was created for A');
});

test('SessionEnd removes the session from the registry', () => {
  hook('SessionEnd', { ...base(), reason: 'other' });
  assert.equal(R.getSession('B', SID_B), null);
});

test('hooks are a no-op for an unknown config dir and never fail', () => {
  const out = hook('SessionStart', { ...base('dddddddd-0000-0000-0000-000000000004') }, { ...sb.envB, CLAUDE_CONFIG_DIR: path.join(sb.root, 'other') });
  assert.deepEqual(out, {});
  const r = spawnSync(process.execPath, [DUO, 'hook', 'Stop'], { input: 'not json', env: sb.envB, encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '{}');
});

// ------------------------------------------------------------------ MCP
function mcpSession(env) {
  const child = spawn(process.execPath, [DUO, 'mcp'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = '';
  const waiters = new Map();
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      const msg = JSON.parse(line);
      const w = waiters.get(msg.id); if (w) { waiters.delete(msg.id); w(msg); }
    }
  });
  let n = 0;
  return {
    call(method, params) {
      const id = ++n;
      return new Promise((resolve) => { waiters.set(id, resolve); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
    },
    notify(method) { child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n'); },
    close() { child.stdin.end(); child.kill(); },
  };
}

test('MCP: handshake, tools/list, unknown method, tool calls', async () => {
  const s = mcpSession(sb.envA);
  try {
    const init = await s.call('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '0' } });
    assert.equal(init.result.protocolVersion, '2025-11-25');
    assert.equal(init.result.serverInfo.name, 'duo');
    const odd = await s.call('initialize', { protocolVersion: '1999-01-01' });
    assert.equal(odd.result.protocolVersion, '2025-11-25');
    s.notify('notifications/initialized');
    const list = await s.call('tools/list', {});
    const names = list.result.tools.map((t) => t.name);
    assert.deepEqual(names.sort(), ['duo_accept', 'duo_cancel', 'duo_config', 'duo_examples', 'duo_get', 'duo_inbox', 'duo_reject', 'duo_reply', 'duo_send', 'duo_status', 'duo_wait'].sort());
    for (const t of list.result.tools) assert.equal(t.inputSchema.type, 'object');
    const unk = await s.call('server/discover', {});
    assert.equal(unk.error.code, -32601);
    const st = await s.call('tools/call', { name: 'duo_status', arguments: {} });
    assert.equal(JSON.parse(st.result.content[0].text).me, 'A');
    const sent = await s.call('tools/call', { name: 'duo_send', arguments: { type: 'info', title: 'xin chào', body: 'thử' } });
    assert.ok(!sent.result.isError, sent.result.content[0].text);
    assert.match(sent.result.content[0].text, /Created \d{8}-\d{6}-[a-z0-9]{4} → B:Maker/);
    const bad = await s.call('tools/call', { name: 'duo_get', arguments: { id: '20000101-000000-zzzz' } });
    assert.equal(bad.result.isError, true);
    const cfgSet = await s.call('tools/call', { name: 'duo_config', arguments: { action: 'set', key: 'spawn.permission_mode', value: 'bypassPermissions', user_confirmed: true } });
    assert.equal(cfgSet.result.isError, true);
    const cfgNo = await s.call('tools/call', { name: 'duo_config', arguments: { action: 'set', key: 'notify', value: false } });
    assert.match(cfgNo.result.content[0].text, /approval_required/);
    const cfgDev = await s.call('tools/call', { name: 'duo_config', arguments: { action: 'set', key: 'dev.plugin_dir', value: '/x', user_confirmed: true } });
    assert.equal(cfgDev.result.isError, true);
    const ex = await s.call('tools/call', { name: 'duo_examples', arguments: { action: 'list' } });
    assert.match(ex.result.content[0].text, /dev: Dev: Planner ↔ Coder/);
  } finally { s.close(); }
});

test('MCP: duo_examples install copies agents into each peer and sets roles', async () => {
  const s = mcpSession(sb.envA);
  try {
    const r = await s.call('tools/call', { name: 'duo_examples', arguments: { action: 'install', name: 'pm', user_confirmed: true } });
    assert.ok(!r.result.isError, r.result.content[0].text);
    assert.ok(fs.existsSync(path.join(sb.a, 'agents', 'duo-pm-writer.md')));
    assert.ok(fs.existsSync(path.join(sb.b, 'agents', 'duo-pm-reviewer.md')));
    const st = await s.call('tools/call', { name: 'duo_status', arguments: {} });
    const j = JSON.parse(st.result.content[0].text);
    assert.equal(j.peers.A.name, 'PRD Writer');
    assert.equal(j.peers.B.name, 'PRD Reviewer');
  } finally { s.close(); }
});

test('CLI: init refuses to overwrite, config set validates', () => {
  const r = spawnSync(process.execPath, [DUO, 'init'], { env: sb.envA, encoding: 'utf8' });
  assert.match(r.stdout, /Đã có cấu hình/);
  const bad = spawnSync(process.execPath, [DUO, 'config', 'set', 'delivery.A_to_B', 'pigeon'], { env: sb.envA, encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /invalid_config/);
  const ok = spawnSync(process.execPath, [DUO, 'config', 'set', 'delivery.A_to_B', 'background'], { env: sb.envA, encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  const st = spawnSync(process.execPath, [DUO, 'status'], { env: sb.envA, encoding: 'utf8' });
  assert.equal(st.status, 0, st.stderr);
  assert.match(st.stdout, /A→B background/);
});
