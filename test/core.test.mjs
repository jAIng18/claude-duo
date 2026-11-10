import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox, makeConfig } from './helpers.mjs';

const sb = sandbox();
let cfg;
const P = await import('../plugin/lib/paths.mjs');
const C = await import('../plugin/lib/config.mjs');
const M = await import('../plugin/lib/mailbox.mjs');
const A = await import('../plugin/lib/actions.mjs');
const T = await import('../plugin/lib/tmux.mjs');
const CL = await import('../plugin/lib/claude.mjs');
const O = await import('../plugin/lib/open.mjs');
const PR = await import('../plugin/lib/prompts.mjs');
const S = await import('../plugin/lib/settings.mjs');
const G = await import('../plugin/lib/gc.mjs');

before(async () => { cfg = await makeConfig(sb); M.ensureMailDirs(); });
after(() => sb.cleanup());

const SID_A = 'aaaaaaaa-0000-0000-0000-000000000001';
const SID_B = 'bbbbbbbb-0000-0000-0000-000000000002';

// ------------------------------------------------------------------ paths
test('normalizeDir strips trailing slash and expands ~', () => {
  assert.equal(P.normalizeDir('~/.claude-b/'), path.join(P.HOME, '.claude-b'));
  assert.equal(P.normalizeDir(`${P.HOME}/.claude-b//`), path.join(P.HOME, '.claude-b'));
  assert.ok(P.isDefaultConfigDir('~/.claude'));
  assert.ok(P.isDefaultConfigDir(`${P.HOME}/.claude/`));
  assert.ok(!P.isDefaultConfigDir('~/.claude-b'));
});

test('envForConfigDir: default dir UNSETS CLAUDE_CONFIG_DIR; leaked vars removed', () => {
  const base = { PATH: '/usr/bin', CLAUDE_CONFIG_DIR: '/x', CLAUDE_CODE_SESSION_ID: 's', CLAUDECODE: '1', CLAUDE_PID: '9', TMUX: 't', TMUX_PANE: '%1', CLAUDE_PLUGIN_ROOT: 'r', KEEP: 'k' };
  const eA = P.envForConfigDir('~/.claude', base);
  assert.equal(eA.CLAUDE_CONFIG_DIR, undefined);
  for (const k of ['CLAUDE_CODE_SESSION_ID', 'CLAUDECODE', 'CLAUDE_PID', 'TMUX', 'TMUX_PANE', 'CLAUDE_PLUGIN_ROOT']) assert.equal(eA[k], undefined, k);
  assert.equal(eA.KEEP, 'k');
  const eB = P.envForConfigDir('~/.claude-b/', base);
  assert.equal(eB.CLAUDE_CONFIG_DIR, path.join(P.HOME, '.claude-b'));
});

test('isTrusted checks the dir and its ancestors', () => {
  fs.writeFileSync(path.join(sb.b, '.claude.json'), JSON.stringify({ projects: { [sb.root]: { hasTrustDialogAccepted: true }, '/nope': { hasTrustDialogAccepted: false } } }));
  assert.equal(P.isTrusted(sb.b, path.join(sb.root, 'sub', 'dir')), true);
  assert.equal(P.isTrusted(sb.b, '/nope/x'), false);
  assert.equal(P.isTrusted(sb.a, sb.root), null); // no .claude.json → unknown
});

// ------------------------------------------------------------------ config
test('config validation catches bad values', () => {
  const bad = C.deepMerge(C.defaultConfig(), { delivery: { A_to_B: 'carrier-pigeon' }, spawn: { allowed_tools: ['Read,Edit'] } });
  const errs = C.validate(bad);
  assert.ok(errs.some((e) => e.includes('delivery.A_to_B')));
  assert.ok(errs.some((e) => e.includes('allowed_tools')));
  const same = C.deepMerge(C.defaultConfig(), { peers: { B: { config_dir: '~/.claude/' } } });
  assert.ok(C.validate(same).some((e) => e.includes('cùng một config_dir')));
});

test('whoAmI maps CLAUDE_CONFIG_DIR to the peer', () => {
  assert.equal(C.whoAmI(cfg, sb.envA), 'A');
  assert.equal(C.whoAmI(cfg, sb.envB), 'B');
  assert.equal(C.whoAmI(cfg, { CLAUDE_CONFIG_DIR: '/somewhere/else' }), null);
  assert.equal(C.whoAmI(cfg, { CLAUDE_CONFIG_DIR: `${sb.b}/` }), 'B');
});

// ------------------------------------------------------------------ mailbox
test('message lifecycle moves files between boxes atomically', () => {
  const m = M.createMessage({ from: 'A', to: 'B', type: 'task', title: 't', body: 'b' });
  assert.ok(M.isId(m.id));
  assert.ok(fs.existsSync(path.join(sb.home, 'mail', 'B', 'new', `${m.id}.json`)));
  M.updateMessage(m.id, (x) => { x.status = 'in_progress'; });
  assert.ok(!fs.existsSync(path.join(sb.home, 'mail', 'B', 'new', `${m.id}.json`)));
  assert.ok(fs.existsSync(path.join(sb.home, 'mail', 'B', 'cur', `${m.id}.json`)));
  M.updateMessage(m.id, (x) => { x.status = 'done'; });
  assert.ok(fs.existsSync(path.join(sb.home, 'mail', 'B', 'done', `${m.id}.json`)));
  assert.equal(M.getMessage(m.id).status, 'done');
});

test('long bodies are stored as an attachment file', () => {
  const big = 'x'.repeat(M.BODY_INLINE_MAX + 10);
  const m = M.createMessage({ from: 'A', to: 'B', type: 'info', title: 'big', body: big });
  assert.ok(m.meta.body_file && fs.readFileSync(m.meta.body_file, 'utf8') === big);
  assert.ok(m.body.length < 400);
});

test('rejects invalid peers/types', () => {
  assert.throws(() => M.createMessage({ from: 'A', to: 'A', type: 'task', title: 't', body: 'b' }));
  assert.throws(() => M.createMessage({ from: 'A', to: 'B', type: 'nope', title: 't', body: 'b' }));
});

// ------------------------------------------------------------------ actions
test('send → get → reply(done) produces a result for the sender', async () => {
  const { message: task } = await A.send(cfg, 'A', SID_A, { type: 'task', title: 'Viết PRD', body: 'nội dung', acceptance: ['≤2 trang'], cwd: sb.root }, { deliverNow: false });
  assert.equal(task.status, 'queued');
  assert.equal(task.meta.sender_session, SID_A);
  const g = A.get(cfg, 'B', SID_B, task.id);
  assert.equal(g.message.status, 'in_progress');
  assert.equal(g.message.meta.handler_session, SID_B);
  const r = await A.reply(cfg, 'B', SID_B, { id: task.id, status: 'done', summary: 'xong', details: 'chi tiết' }, { deliverMode: 'none' });
  assert.equal(r.task.status, 'done');
  assert.equal(r.result.type, 'result');
  assert.equal(r.result.to, 'A');
  assert.equal(r.result.reply_to, task.id);
  assert.equal(r.result.meta.wake_session, SID_A);
  const w = await A.wait(cfg, 'A', { id: task.id, timeout_s: 1 });
  assert.equal(w.done, true);
  assert.equal(w.answer.status, 'read');
  assert.equal(w.answer.result.summary, 'xong');
});

test('approval before_send=ask requires user_confirmed', async () => {
  const c2 = C.deepMerge(cfg, { approval: { before_send: 'ask' } });
  await assert.rejects(A.send(c2, 'A', SID_A, { type: 'task', title: 't', body: 'b' }, { deliverNow: false }), (e) => e.code === 'approval_required' && e.message.includes('Tiêu đề: t'));
  const ok = await A.send(c2, 'A', SID_A, { type: 'task', title: 't', body: 'b', user_confirmed: true }, { deliverNow: false });
  assert.equal(ok.message.status, 'queued');
});

test('loop prevention: cannot hand a task back to the giver', async () => {
  const { message: t } = await A.send(cfg, 'A', SID_A, { type: 'task', title: 'loop', body: 'b' }, { deliverNow: false });
  A.get(cfg, 'B', SID_B, t.id); // B starts working on it
  await assert.rejects(A.send(cfg, 'B', SID_B, { type: 'task', title: 'back', body: 'b' }, { deliverNow: false }), (e) => e.code === 'loop_blocked');
  // a question is allowed but its hop increases
  const q = await A.send(cfg, 'B', SID_B, { type: 'question', title: 'q', body: 'b' }, { deliverNow: false });
  assert.equal(q.message.hop, 1);
  await A.reply(cfg, 'B', SID_B, { id: t.id, status: 'failed', summary: 'cleanup' }, { deliverMode: 'none' });
});

test('max_hops is enforced via parent_id chains', async () => {
  const c2 = C.deepMerge(cfg, { limits: { max_hops: 1 } });
  const { message: p0 } = await A.send(c2, 'A', SID_A, { type: 'question', title: 'p0', body: 'b' }, { deliverNow: false });
  const { message: p1 } = await A.send(c2, 'A', SID_A, { type: 'question', title: 'p1', body: 'b', parent_id: p0.id }, { deliverNow: false });
  assert.equal(p1.hop, 1);
  await assert.rejects(A.send(c2, 'A', SID_A, { type: 'question', title: 'p2', body: 'b', parent_id: p1.id }, { deliverNow: false }), (e) => e.code === 'loop_blocked');
});

test('needs_info: question to sender, answer resumes the task', async () => {
  const { message: t } = await A.send(cfg, 'A', SID_A, { type: 'task', title: 'cần hỏi', body: 'b' }, { deliverNow: false });
  A.get(cfg, 'B', SID_B, t.id);
  const r = await A.reply(cfg, 'B', SID_B, { id: t.id, status: 'needs_info', summary: 'OTP qua SMS hay email?' }, { deliverMode: 'none' });
  assert.equal(r.task.status, 'needs_info');
  assert.equal(r.question.type, 'question');
  assert.equal(r.question.to, 'A');
  assert.equal(r.question.meta.wake_session, SID_A);
  const w = await A.wait(cfg, 'A', { id: t.id, timeout_s: 1 });
  assert.equal(w.answer.id, r.question.id);
  A.get(cfg, 'A', SID_A, r.question.id);
  const ans = await A.reply(cfg, 'A', SID_A, { id: r.question.id, status: 'done', summary: 'email' }, { deliverMode: 'none' });
  assert.equal(ans.result.to, 'B');
  assert.equal(ans.result.meta.wake_session, SID_B);
  A.get(cfg, 'B', SID_B, ans.result.id); // B reads the answer
  assert.equal(M.getMessage(t.id).status, 'in_progress');
  await A.reply(cfg, 'B', SID_B, { id: t.id, status: 'done', summary: 'đã xong với email' }, { deliverMode: 'none' });
  assert.equal(M.getMessage(t.id).status, 'done');
});

test('before_accept=ask: get does not start work until accept', async () => {
  const c2 = C.deepMerge(cfg, { approval: { before_accept: 'ask' } });
  const { message: t } = await A.send(c2, 'A', SID_A, { type: 'task', title: 'duyệt', body: 'b' }, { deliverNow: false });
  const g = A.get(c2, 'B', SID_B, t.id);
  assert.equal(g.needsAccept, true);
  assert.equal(g.message.status, 'queued');
  await assert.rejects(A.reply(c2, 'B', SID_B, { id: t.id, status: 'done', summary: 'x' }, { deliverMode: 'none' }), (e) => e.code === 'approval_required');
  assert.equal(A.accept(c2, 'B', SID_B, t.id).status, 'in_progress');
  await A.reply(c2, 'B', SID_B, { id: t.id, status: 'done', summary: 'x' }, { deliverMode: 'none' });
});

test('reject and cancel', async () => {
  const { message: t1 } = await A.send(cfg, 'A', SID_A, { type: 'task', title: 'r', body: 'b' }, { deliverNow: false });
  const rj = await A.reject(cfg, 'B', SID_B, { id: t1.id, reason: 'ngoài phạm vi' });
  assert.equal(rj.task.status, 'rejected');
  assert.equal(rj.result.result.status, 'rejected');
  const { message: t2 } = await A.send(cfg, 'A', SID_A, { type: 'task', title: 'c', body: 'b' }, { deliverNow: false });
  A.get(cfg, 'B', SID_B, t2.id);
  const c = await A.cancel(cfg, 'A', SID_A, { id: t2.id, reason: 'đổi ý' });
  assert.equal(c.task.status, 'cancelled');
  assert.equal(c.note.type, 'cancel');
  assert.equal(c.note.meta.wake_session, SID_B);
  await assert.rejects(A.reply(cfg, 'B', SID_B, { id: t2.id, status: 'done', summary: 'x' }, { deliverMode: 'none' }), (e) => e.code === 'bad_state');
  await assert.rejects(A.cancel(cfg, 'B', SID_B, { id: t1.id }), (e) => e.code === 'forbidden');
});

test('rate limit', async () => {
  const c2 = C.deepMerge(cfg, { limits: { max_messages_per_10min: 1 } });
  // other tests already sent messages from A within 10 min
  await assert.rejects(A.send(c2, 'A', SID_A, { type: 'info', title: 'x', body: '' }, { deliverNow: false }), (e) => e.code === 'rate_limited');
});

test('attachments must be absolute and exist', async () => {
  await assert.rejects(A.send(cfg, 'A', SID_A, { type: 'info', title: 'x', body: 'y', attachments: [{ path: 'rel.txt' }] }, { deliverNow: false }), (e) => e.code === 'bad_args');
  await assert.rejects(A.send(cfg, 'A', SID_A, { type: 'info', title: 'x', body: 'y', attachments: [{ path: '/no/such/file' }] }, { deliverNow: false }), (e) => e.code === 'bad_args');
});

test('gc expires overdue queued messages', () => {
  const m = M.createMessage({ from: 'A', to: 'B', type: 'task', title: 'old', body: 'b', deadline_s: 1 });
  const r = G.gc(cfg, Date.now() + 5000);
  assert.ok(r.expired >= 1);
  assert.equal(M.getMessage(m.id).status, 'expired');
});

// ------------------------------------------------------------------ tmux screen analysis (fixtures from real captures)
const RULE = '─'.repeat(60);
const IDLE = ['⏺ Xin chào', '✻ Sautéed for 2s', `${RULE} duo-tmux-test ─`, '❯ ', RULE, '  ⏸ manual mode on · ? for shortcuts', '', ''].join('\n');
const PLACEHOLDER = [`${RULE} duo ─`, '❯ Try "fix lint errors"', RULE, '  ⏸ manual mode on'].join('\n');
const DIALOG = ['⏺ Write(duo-perm-test.txt)', RULE, ' Create file', ' duo-perm-test.txt', '╌'.repeat(40), '  1 hello', '╌'.repeat(40),
  ' Do you want to create duo-perm-test.txt?', ' ❯ 1. Yes', '   2. Yes, and switch to accept edits', '   3. No', ' Esc to cancel · Tab to amend', `${RULE} duo-tmux-test ─`].join('\n');
const TALKY = ['⏺ Do you want to proceed with option 1?', `${RULE} x ─`, '❯ ', RULE, '  status'].join('\n');
const TYPED = [`${RULE} x ─`, '❯ [claude-duo] Ban co TASK moi', '  20261110-010101-abcd', RULE, '  status'].join('\n');

test('analyzeScreen: idle prompt', () => {
  assert.deepEqual(T.analyzeScreen(IDLE), { ok: true, inputText: '' });
  assert.equal(T.analyzeScreen(PLACEHOLDER).ok, true);
});
test('analyzeScreen: permission dialog is NOT idle', () => {
  assert.equal(T.analyzeScreen(DIALOG).ok, false);
});
test('analyzeScreen: Claude text mentioning "Do you want to" above the box is fine', () => {
  assert.equal(T.analyzeScreen(TALKY).ok, true);
});
test('analyzeScreen: wrapped typed input is read back', () => {
  const a = T.analyzeScreen(TYPED);
  assert.equal(a.ok, true);
  assert.ok(a.inputText.replace(/\s+/g, '').includes('[claude-duo]BancoTASKmoi20261110'));
});

// ------------------------------------------------------------------ claude CLI wrappers
test('parseBgOutput', () => {
  assert.deepEqual(CL.parseBgOutput({ code: 0, stdout: 'Starting background service…\nbackgrounded · 64072a3d · duo-test-b\n', stderr: '' }).id, '64072a3d');
  const copy = CL.parseBgOutput({ code: 0, stdout: 'note: background session 98534310 keeps its own saved options, so the flags you passed started a copy as 03082d4c. Without flags…\nbackgrounded · 03082d4c\n', stderr: '' });
  assert.equal(copy.id, '03082d4c'); assert.equal(copy.copied, true);
  assert.equal(CL.parseBgOutput({ code: 1, stdout: '', stderr: 'Workspace not trusted. Run `claude` in /x once' }).error, 'workspace_not_trusted');
  assert.equal(CL.parseBgOutput({ code: 1, stdout: 'Not logged in. Run claude auth login', stderr: '' }).error, 'auth_required');
});

test('claudeArgs: prompt first, --allowedTools last with ONE comma-joined value', () => {
  const args = O.claudeArgs(cfg, 'B', { prompt: '[claude-duo] hi', name: 'duo-B' });
  assert.equal(args[0], '[claude-duo] hi');
  assert.equal(args.at(-2), '--allowedTools');
  assert.equal(args.at(-1), [...cfg.spawn.allowed_tools, C.DUO_MCP_RULE].join(','));
  assert.ok(args.includes('--permission-mode'));
  const user = O.claudeArgs(cfg, 'B', { name: 'duo-B' });
  assert.ok(!user.includes('--permission-mode'), 'user-opened sessions keep their own permission mode');
  assert.equal(user.at(-1), C.DUO_MCP_RULE);
});

test('claudeArgs: extra user flags (claude-b --resume) go before --allowedTools; -n not duplicated', () => {
  const args = O.claudeArgs(cfg, 'B', { name: 'duo-B', extra: ['--resume'] });
  assert.ok(args.indexOf('--resume') < args.indexOf('--allowedTools'));
  assert.equal(args.at(-2), '--allowedTools');
  const named = O.claudeArgs(cfg, 'B', { name: 'duo-B', extra: ['-n', 'mine'] });
  assert.equal(named.filter((x) => x === '-n').length, 1);
});

test('envWords: default peer unsets CLAUDE_CONFIG_DIR, custom peer sets normalised path', () => {
  const c2 = C.deepMerge(cfg, { peers: { A: { config_dir: '~/.claude' }, B: { config_dir: '~/.claude-b/' } } });
  const wa = O.envWords(c2, 'A');
  assert.ok(wa.join(' ').includes('-u CLAUDE_CONFIG_DIR'));
  assert.ok(!wa.some((w) => w.startsWith('CLAUDE_CONFIG_DIR=')));
  assert.ok(O.envWords(c2, 'B').includes(`CLAUDE_CONFIG_DIR=${path.join(P.HOME, '.claude-b')}`));
});

test('bootstrap is a single line and quotes are neutralised', () => {
  const m = { id: '20261110-010101-abcd', type: 'task', from: 'A', title: 'Say "hi"\nnow $HOME `x`' };
  const b = PR.bootstrap(cfg, m);
  assert.ok(!/[\r\n]/.test(b));
  assert.ok(b.startsWith(PR.BOOT_PREFIX));
  assert.ok(!b.includes('`') && !b.includes('$'));
  assert.ok(b.includes(m.id));
});

// ------------------------------------------------------------------ settings.json edits
test('add/remove permission rule keeps other settings and makes a backup', () => {
  const f = path.join(sb.b, 'settings.json');
  fs.writeFileSync(f, JSON.stringify({ theme: 'light', permissions: { defaultMode: 'auto', allow: ['Bash(ls:*)'] } }));
  assert.equal(S.addPermissionRule(sb.b), true);
  assert.equal(S.addPermissionRule(sb.b), false);
  const s = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.equal(s.theme, 'light');
  assert.equal(s.permissions.defaultMode, 'auto');
  assert.deepEqual(s.permissions.allow, ['Bash(ls:*)', C.DUO_MCP_RULE]);
  assert.ok(fs.existsSync(`${f}.bak-claude-duo`));
  assert.equal(S.removePermissionRule(sb.b), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(f, 'utf8')).permissions.allow, ['Bash(ls:*)']);
});

test('never overwrites a settings.json it cannot parse', () => {
  const f = path.join(sb.a, 'settings.json');
  fs.writeFileSync(f, '{ broken');
  assert.throws(() => S.addPermissionRule(sb.a));
  assert.equal(fs.readFileSync(f, 'utf8'), '{ broken');
  fs.rmSync(f);
});
