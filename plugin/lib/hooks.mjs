// Hook handlers. SPEC §8. Each returns the JSON object Claude Code expects
// (or {}); they never throw to the caller.
import path from 'node:path';
import { configExists, loadConfig, whoAmI, label } from './config.mjs';
import { listMessages, updateMessage, getMessage, summary, ID_RE, TERMINAL, WORK_TYPES } from './mailbox.mjs';
import { upsertSession, getSession, removeSession, findClaudePid, tmuxFromEnv, listSessions, getBg } from './registry.mjs';
import { BOOT_PREFIX, bootstrap } from './prompts.mjs';
import { reply } from './actions.mjs';
import { kickDetached, isNoteLike } from './dispatch.mjs';
import { notify } from './macos.mjs';
import { log, readJSON, writeJSONAtomic } from './fsutil.mjs';
import { paths } from './paths.mjs';
import { gc } from './gc.mjs';

function ctx(event, text) {
  return text ? { hookSpecificOutput: { hookEventName: event, additionalContext: text } } : {};
}

/** Messages waiting for `me` that this session may pick up. */
function pendingFor(me, sid) {
  const alive = new Set(listSessions(me).map((s) => s.session_id));
  const bg = getBg(me);
  return listMessages({ to: me, boxes: ['new'] }).filter((m) => {
    if (TERMINAL.includes(m.status)) return false;
    const ws = m.meta.wake_session;
    const mineToWake = !ws || ws === sid || !alive.has(ws);
    if (isNoteLike(m)) return (m.status === 'unread' || m.status === 'queued') && mineToWake;
    // plain work: only messages nobody has been started for yet
    if (m.status !== 'queued') return false;
    // queued for the background worker → only the worker may take it
    if (m.meta.queued_mode === 'background' && (!bg || bg.session_id !== sid)) return false;
    const claimed = m.meta.claimed_by;
    return !claimed || claimed === sid || !alive.has(claimed);
  });
}

function sessionStart(cfg, me, input) {
  const sid = input.session_id;
  upsertSession(me, sid, {
    pid: findClaudePid(),
    cwd: input.cwd ? path.resolve(input.cwd) : null,
    tmux: tmuxFromEnv(),
    state: 'idle',
    last_event: 'SessionStart',
    transcript_path: input.transcript_path || null,
    entrypoint: process.env.CLAUDE_CODE_ENTRYPOINT || null,
  });
  maybeGc(cfg);
  kickDetached();
  const pend = pendingFor(me, sid);
  const lines = [`${BOOT_PREFIX} Phiên này là peer ${label(cfg, me)} trong claude-duo. Peer còn lại: ${label(cfg, me === 'A' ? 'B' : 'A')}. Dùng các tool duo_* để giao việc / trả lời.`];
  if (pend.length) lines.push(`Có ${pend.length} message đang chờ bạn:`, ...pend.slice(0, 5).map((m) => `- ${summary(m)}`), 'Hỏi người dùng có muốn xử lý không (tool duo_get).');
  return ctx('SessionStart', lines.join('\n'));
}

function userPromptSubmit(cfg, me, input) {
  const sid = input.session_id;
  const prompt = String(input.prompt || '');
  const fromDuo = prompt.startsWith(BOOT_PREFIX);
  const ids = fromDuo ? [...new Set([...prompt.matchAll(ID_RE)].map((x) => x[1]))] : [];
  for (const id of ids) {
    const m = getMessage(id);
    if (!m || m.to !== me) continue;
    try {
      updateMessage(id, (x) => {
        x.meta.picked_up_by = sid;
        x.meta.picked_up_at = new Date().toISOString();
        if (x.status === 'queued') x.status = 'delivered';
      });
    } catch (e) { log('pickup-failed', id, e.message); }
  }
  const cur = getSession(me, sid) || {};
  const injected = new Set(cur.injected || []);
  const fresh = pendingFor(me, sid).filter((m) => !ids.includes(m.id) && !injected.has(m.id));
  for (const m of fresh) injected.add(m.id);
  upsertSession(me, sid, {
    state: 'busy',
    last_event: 'UserPromptSubmit',
    injected: [...injected].slice(-100),
    // A real prompt (from the user or a dispatcher delivery) starts a new
    // turn; only Stop-hook chains inside one turn count towards the limit.
    auto_continue_count: 0,
    ...(cur.pid ? {} : { pid: findClaudePid(), tmux: tmuxFromEnv(), cwd: input.cwd ? path.resolve(input.cwd) : null }),
  });
  if (!fresh.length) return {};
  return ctx('UserPromptSubmit', [`${BOOT_PREFIX} Có message mới cho bạn (chưa xử lý):`, ...fresh.slice(0, 5).map((m) => `- ${summary(m)}`),
    'Không cần xử lý ngay; cuối lượt này hãy nhắc người dùng.'].join('\n'));
}

function notification(cfg, me, input) {
  const sid = input.session_id;
  if (input.notification_type !== 'permission_prompt') return {};
  upsertSession(me, sid, { state: 'awaiting_user', last_event: 'Notification' });
  const bg = getBg(me);
  if (cfg.notify && bg && bg.session_id === sid) {
    notify(`claude-duo: ${label(cfg, me)} cần bạn duyệt quyền`, `Phiên nền đang chờ. Chạy: duo attach ${me}`);
  }
  return {};
}

async function stop(cfg, me, input) {
  const sid = input.session_id;
  const cur = upsertSession(me, sid, { state: 'idle', last_event: 'Stop' });
  kickDetached();
  if (!cfg.auto_continue) return {};
  const count = cur.auto_continue_count || 0;
  const block = (reason) => {
    upsertSession(me, sid, { auto_continue_count: count + 1, state: 'busy' });
    return { decision: 'block', reason };
  };
  if (count >= cfg.limits.max_auto_continue) return {};

  // 1) background work started in this session but never answered
  const unanswered = listMessages({ to: me, boxes: ['cur'], types: WORK_TYPES, statuses: ['accepted', 'in_progress'] })
    .filter((m) => m.meta.handler_session === sid && m.meta.delivered_via === 'background');
  for (const m of unanswered) {
    const n = m.meta.reminders || 0;
    if (n < cfg.limits.max_reply_reminders) {
      updateMessage(m.id, (x) => { x.meta.reminders = n + 1; });
      return block(`${BOOT_PREFIX} Bạn chưa gọi duo_reply cho message ${m.id} ("${m.title}"). Nếu đã xong, gọi duo_reply (status "done" hoặc "failed") với tóm tắt kết quả. Nếu cần hỏi thêm, gọi duo_reply với status "needs_info".`);
    }
    await reply(cfg, me, sid, {
      id: m.id, status: 'done', auto_result: true,
      summary: String(input.last_assistant_message || '(phiên kết thúc mà không có câu trả lời)').slice(0, 20000),
    }, { deliverMode: 'detached' });
    log('auto-result', m.id);
  }

  // 2) pick up the next waiting message
  const announced = new Set(cur.announced || []);
  const next = pendingFor(me, sid).find((m) => !announced.has(m.id));
  if (!next) return {};
  announced.add(next.id);
  upsertSession(me, sid, { announced: [...announced].slice(-100) });
  if (!isNoteLike(next)) {
    try { updateMessage(next.id, (x) => { x.meta.claimed_by = sid; x.meta.claimed_at = new Date().toISOString(); }); } catch { /* */ }
  }
  return block(bootstrap(cfg, next));
}

function sessionEnd(cfg, me, input) {
  removeSession(me, input.session_id);
  return {};
}

function maybeGc(cfg) {
  try {
    const f = path.join(paths.state(), 'gc.json');
    const last = readJSON(f, { at: 0 }).at || 0;
    if (Date.now() - last < 24 * 3600 * 1000) return;
    writeJSONAtomic(f, { at: Date.now() });
    gc(cfg);
  } catch (e) { log('gc-failed', e.message); }
}

const HANDLERS = { SessionStart: sessionStart, UserPromptSubmit: userPromptSubmit, Notification: notification, Stop: stop, SessionEnd: sessionEnd };

export async function runHook(event, input, env = process.env) {
  try {
    if (!configExists()) return {};
    const cfg = loadConfig();
    const me = whoAmI(cfg, env);
    if (!me || !input || !input.session_id) return {};
    const h = HANDLERS[event];
    if (!h) return {};
    return (await h(cfg, me, input)) || {};
  } catch (e) {
    log('hook-error', event, String(e && e.stack || e));
    return {};
  }
}
