// Business logic shared by the MCP server, hooks and CLI. SPEC §6, §9, §11.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DuoError, other, label, MODES, PEERS } from './config.mjs';
import {
  createMessage, getMessage, requireMessage, updateMessage, listMessages, thread, isExpired,
  WORK_TYPES, TERMINAL, summary,
} from './mailbox.mjs';
import { deliver } from './dispatch.mjs';
import { DUO_CLI } from './open.mjs';
import { log } from './fsutil.mjs';
import { listSessions, getBg } from './registry.mjs';

const ACTIVE = ['accepted', 'in_progress', 'needs_info'];

function str(v, name, { required = false, max = 100000 } = {}) {
  if (v === undefined || v === null || v === '') {
    if (required) throw new DuoError('bad_args', `Thiếu tham số ${name}`);
    return '';
  }
  if (typeof v !== 'string') throw new DuoError('bad_args', `${name} phải là chuỗi`);
  if (v.length > max) throw new DuoError('bad_args', `${name} quá dài (tối đa ${max} ký tự)`);
  return v;
}

function strList(v, name) {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw new DuoError('bad_args', `${name} phải là mảng chuỗi`);
  return v;
}

function attachmentsArg(v) {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new DuoError('bad_args', 'attachments phải là mảng');
  return v.map((a, i) => {
    const p = typeof a === 'string' ? a : a && a.path;
    if (typeof p !== 'string' || !path.isAbsolute(p)) throw new DuoError('bad_args', `attachments[${i}].path phải là đường dẫn tuyệt đối`);
    if (!fs.existsSync(p)) throw new DuoError('bad_args', `attachments[${i}]: file không tồn tại: ${p}`);
    return { path: p, note: typeof a === 'object' && typeof a.note === 'string' ? a.note : '' };
  });
}

/** Tasks the given peer is currently working on (optionally in one session). */
function activeWork(me, sid) {
  return listMessages({ to: me, boxes: ['cur'], types: WORK_TYPES, statuses: ACTIVE })
    .filter((m) => !sid || !m.meta.handler_session || m.meta.handler_session === sid);
}

export function preview(cfg, me, a) {
  return [
    `Gửi tới: ${label(cfg, other(me))}`,
    `Loại: ${a.type}`,
    `Tiêu đề: ${a.title}`,
    `Nội dung:\n${a.body}`,
    a.acceptance && a.acceptance.length ? `Tiêu chí hoàn thành:\n- ${a.acceptance.join('\n- ')}` : null,
    a.attachments && a.attachments.length ? `Đính kèm:\n- ${a.attachments.map((x) => (typeof x === 'string' ? x : x.path)).join('\n- ')}` : null,
  ].filter(Boolean).join('\n');
}

// ---------------------------------------------------------------- send
export async function send(cfg, me, sid, a = {}, { deliverNow = true } = {}) {
  const type = a.type || 'task';
  if (!['task', 'question', 'info'].includes(type)) throw new DuoError('bad_args', 'type phải là task | question | info (kết quả thì dùng duo_reply)');
  const title = str(a.title, 'title', { required: true, max: 300 });
  const body = str(a.body, 'body', { required: type !== 'info', max: 2_000_000 });
  const to = a.to ? String(a.to).toUpperCase() : other(me);
  if (!PEERS.includes(to) || to === me) throw new DuoError('bad_args', `to phải là ${other(me)}`);
  if (a.delivery && !MODES.includes(a.delivery)) throw new DuoError('bad_args', `delivery phải là: ${MODES.join(', ')}`);
  const acceptance = strList(a.acceptance, 'acceptance');
  const attachments = attachmentsArg(a.attachments);
  const cwd = path.resolve(a.cwd ? String(a.cwd) : process.cwd());

  if (cfg.approval.before_send === 'ask' && a.user_confirmed !== true) {
    throw new DuoError('approval_required',
      `Cấu hình yêu cầu người dùng duyệt trước khi gửi. Hãy cho người dùng xem bản nháp dưới đây, hỏi họ có đồng ý không, và CHỈ khi họ đồng ý thì gọi lại duo_send với user_confirmed: true.\n\n${preview(cfg, me, { type, title, body, acceptance, attachments })}`);
  }

  // rate limit
  const since = Date.now() - 10 * 60 * 1000;
  const recent = listMessages({ from: me }).filter((m) => Date.parse(m.created_at) > since && m.type !== 'result');
  if (recent.length >= cfg.limits.max_messages_per_10min) {
    throw new DuoError('rate_limited', `Đã gửi ${recent.length} message trong 10 phút (giới hạn ${cfg.limits.max_messages_per_10min}). Dừng lại và báo người dùng.`);
  }

  // loop prevention
  const mine = activeWork(me, sid);
  let parent = null;
  if (a.parent_id) parent = requireMessage(String(a.parent_id));
  if (type === 'task' && mine.some((m) => m.from === to)) {
    throw new DuoError('loop_blocked', `Bạn đang xử lý việc do ${label(cfg, to)} giao (${mine.filter((m) => m.from === to).map((m) => m.id).join(', ')}). Không được giao task ngược lại. Nếu cần hỏi thêm, gọi duo_reply với status "needs_info".`);
  }
  const hop = parent ? (parent.hop || 0) + 1 : mine.length ? Math.max(...mine.map((m) => m.hop || 0)) + 1 : 0;
  if (hop > cfg.limits.max_hops) throw new DuoError('loop_blocked', `Vượt giới hạn chuyển tiếp (hop ${hop} > max_hops ${cfg.limits.max_hops}). Dừng lại và báo người dùng.`);

  const msg = createMessage({
    from: me, to, type, title, body, acceptance, attachments, cwd, hop,
    delivery: a.delivery || null,
    deadline_s: Number.isInteger(a.deadline_s) && a.deadline_s > 0 ? a.deadline_s : cfg.limits.default_deadline_s,
    meta: { sender_session: sid || null, parent_id: parent ? parent.id : null },
  });
  let delivery = null;
  if (deliverNow) delivery = await deliver(cfg, msg.id);
  return { message: getMessage(msg.id), delivery };
}

// ---------------------------------------------------------------- get / accept
function markExpired(m) {
  if (!isExpired(m)) return m;
  return updateMessage(m.id, (x) => { x.status = 'expired'; x.meta.error = 'deadline_passed'; });
}

function startWork(id, sid) {
  return updateMessage(id, (x) => {
    if (['queued', 'delivered'].includes(x.status)) {
      x.status = 'in_progress';
      x.meta.handler_session = sid || null;
      x.meta.accepted_at = new Date().toISOString();
    }
  });
}

export function get(cfg, me, sid, id) {
  let m = requireMessage(String(id));
  if (m.to !== me && m.from !== me) throw new DuoError('forbidden', 'Message này không thuộc về bạn');
  let needsAccept = false;
  if (m.to === me) {
    m = markExpired(m);
    if (WORK_TYPES.includes(m.type) && ['queued', 'delivered'].includes(m.status)) {
      if (cfg.approval.before_accept === 'ask' && !m.reply_to) needsAccept = true;
      else m = startWork(m.id, sid);
    } else if (m.status === 'unread') {
      m = updateMessage(m.id, (x) => { x.status = 'read'; x.meta.read_at = new Date().toISOString(); });
      resumeAfterAnswer(m);
    }
  }
  return { message: m, needsAccept, thread: thread(m.thread_id).filter((x) => x.id !== m.id) };
}

/** An answer to a needs_info question puts the original task back in progress. */
function resumeAfterAnswer(m) {
  if (m.type !== 'result' || !m.reply_to) return;
  const q = getMessage(m.reply_to);
  if (!q || q.type !== 'question' || !q.reply_to) return;
  const task = getMessage(q.reply_to);
  if (task && task.status === 'needs_info') updateMessage(task.id, (x) => { x.status = 'in_progress'; });
}

export function accept(cfg, me, sid, id) {
  const m = requireMessage(String(id));
  if (m.to !== me) throw new DuoError('forbidden', 'Chỉ bên nhận mới chấp nhận được');
  if (!WORK_TYPES.includes(m.type)) throw new DuoError('bad_args', 'Chỉ task/câu hỏi mới cần chấp nhận');
  if (!['queued', 'delivered'].includes(m.status)) throw new DuoError('bad_state', `Message đang ở trạng thái ${m.status}`);
  return startWork(m.id, sid);
}

// ---------------------------------------------------------------- reply / reject
export function deliverDetached(id) {
  if (process.env.DUO_DRY_RUN === '1') return;
  try {
    const child = spawn(process.execPath, [DUO_CLI, 'deliver', id], { detached: true, stdio: 'ignore', env: process.env });
    child.unref();
  } catch (e) { log('deliver-detached-failed', id, e.message); }
}

async function ship(cfg, id, mode) {
  if (mode === 'detached') { deliverDetached(id); return { detached: true }; }
  if (mode === 'none') return null;
  return deliver(cfg, id);
}

export async function reply(cfg, me, sid, a = {}, { deliverMode = 'sync' } = {}) {
  const id = str(a.id, 'id', { required: true, max: 64 });
  const status = a.status || 'done';
  if (!['done', 'failed', 'needs_info'].includes(status)) throw new DuoError('bad_args', 'status phải là done | failed | needs_info');
  const summaryText = str(a.summary, 'summary', { required: true, max: 20000 });
  const details = str(a.details, 'details', { max: 2_000_000 });
  const outputs = attachmentsArg(a.outputs);
  const openIssues = strList(a.open_issues, 'open_issues');
  let m = requireMessage(id);
  if (m.to !== me) throw new DuoError('forbidden', 'Chỉ bên nhận message mới trả lời được');
  if (!WORK_TYPES.includes(m.type)) throw new DuoError('bad_args', 'Chỉ task/câu hỏi mới cần duo_reply');
  if (TERMINAL.includes(m.status)) throw new DuoError('bad_state', `Message đã ở trạng thái ${m.status}`);
  if (['queued', 'delivered'].includes(m.status)) {
    if (cfg.approval.before_accept === 'ask' && !m.reply_to) throw new DuoError('approval_required', 'Message chưa được chấp nhận. Hỏi người dùng rồi gọi duo_accept trước.');
    m = startWork(m.id, sid);
  }
  const result = { status, summary: summaryText, details, outputs, open_issues: openIssues, auto_result: a.auto_result === true };

  if (status === 'needs_info') {
    if (m.type !== 'task') throw new DuoError('bad_args', 'needs_info chỉ dùng cho task');
    const q = createMessage({
      from: me, to: m.from, type: 'question', reply_to: m.id, thread_id: m.thread_id, hop: m.hop, cwd: m.cwd,
      title: `Cần thêm thông tin: ${m.title}`.slice(0, 300),
      body: details ? `${summaryText}\n\n${details}` : summaryText,
      deadline_s: cfg.limits.default_deadline_s,
      meta: { sender_session: sid || null, wake_session: m.meta.sender_session || null },
    });
    updateMessage(m.id, (x) => { x.status = 'needs_info'; x.result = result; x.meta.question_id = q.id; });
    const delivery = await ship(cfg, q.id, deliverMode);
    return { task: getMessage(m.id), question: getMessage(q.id), delivery };
  }

  updateMessage(m.id, (x) => { x.status = status; x.result = result; x.meta.replied_at = new Date().toISOString(); });
  const r = createMessage({
    from: me, to: m.from, type: 'result', reply_to: m.id, thread_id: m.thread_id, hop: m.hop, cwd: m.cwd,
    title: m.title, body: details ? `${summaryText}\n\n${details}` : summaryText, result,
    meta: { sender_session: sid || null, wake_session: m.meta.sender_session || null },
  });
  const delivery = await ship(cfg, r.id, deliverMode);
  return { task: getMessage(m.id), result: getMessage(r.id), delivery };
}

export async function reject(cfg, me, sid, a = {}) {
  const id = str(a.id, 'id', { required: true, max: 64 });
  const reason = str(a.reason, 'reason', { required: true, max: 5000 });
  const m = requireMessage(id);
  if (m.to !== me) throw new DuoError('forbidden', 'Chỉ bên nhận mới từ chối được');
  if (!WORK_TYPES.includes(m.type) || TERMINAL.includes(m.status)) throw new DuoError('bad_state', `Không từ chối được message ở trạng thái ${m.status}`);
  const result = { status: 'rejected', summary: reason, details: '', outputs: [], open_issues: [] };
  updateMessage(m.id, (x) => { x.status = 'rejected'; x.result = result; });
  const r = createMessage({
    from: me, to: m.from, type: 'result', reply_to: m.id, thread_id: m.thread_id, hop: m.hop, cwd: m.cwd,
    title: m.title, body: `Đã từ chối: ${reason}`, result,
    meta: { sender_session: sid || null, wake_session: m.meta.sender_session || null },
  });
  const delivery = await deliver(cfg, r.id);
  return { task: getMessage(m.id), result: getMessage(r.id), delivery };
}

// ---------------------------------------------------------------- wait / cancel
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function wait(cfg, me, a = {}) {
  const id = str(a.id, 'id', { required: true, max: 64 });
  const timeout = Math.min(Math.max(Number.isInteger(a.timeout_s) ? a.timeout_s : 600, 1), 3600);
  const m0 = requireMessage(id);
  if (m0.from !== me) throw new DuoError('forbidden', 'Chỉ bên gửi mới chờ kết quả được');
  const end = Date.now() + timeout * 1000;
  for (;;) {
    const answer = listMessages({ to: me, boxes: ['new'] }).find((x) => x.reply_to === id && (x.type === 'result' || x.type === 'question'));
    if (answer) {
      const read = answer.type === 'result'
        ? updateMessage(answer.id, (x) => { x.status = 'read'; x.meta.read_at = new Date().toISOString(); })
        : answer;
      return { done: true, task: getMessage(id), answer: read };
    }
    const cur = getMessage(id);
    if (cur && ['cancelled', 'expired'].includes(cur.status)) return { done: true, task: cur, answer: null };
    if (Date.now() >= end) return { done: false, timeout: true, task: cur };
    await sleep(2000);
  }
}

export async function cancel(cfg, me, sid, a = {}) {
  const id = str(a.id, 'id', { required: true, max: 64 });
  const reason = str(a.reason, 'reason', { max: 2000 }) || 'Người gửi đã hủy';
  const m = requireMessage(id);
  if (m.from !== me) throw new DuoError('forbidden', 'Chỉ bên gửi mới hủy được');
  if (TERMINAL.includes(m.status)) throw new DuoError('bad_state', `Message đã ở trạng thái ${m.status}`);
  const wasStarted = ACTIVE.includes(m.status);
  updateMessage(m.id, (x) => { x.status = 'cancelled'; x.meta.cancel_reason = reason; });
  let note = null;
  if (wasStarted || m.status === 'delivered') {
    note = createMessage({
      from: me, to: m.to, type: 'cancel', reply_to: m.id, thread_id: m.thread_id, hop: m.hop, cwd: m.cwd,
      title: `Đã hủy: ${m.title}`.slice(0, 300), body: `${label(cfg, me)} đã hủy message ${m.id}. Lý do: ${reason}. Dừng làm việc này, KHÔNG gọi duo_reply cho nó.`,
      meta: { sender_session: sid || null, wake_session: m.meta.handler_session || null },
    });
    await deliver(cfg, note.id);
  }
  return { task: getMessage(m.id), note };
}

// ---------------------------------------------------------------- inbox / status
export function inbox(cfg, me, a = {}) {
  const box = a.box || 'open';
  const limit = Math.min(Math.max(Number.isInteger(a.limit) ? a.limit : 20, 1), 200);
  const filter = a.sent ? { from: me } : { to: me };
  let list = listMessages(filter);
  if (box === 'open') list = list.filter((m) => !TERMINAL.includes(m.status));
  else if (box !== 'all') list = list.filter((m) => (box === 'new' ? ['queued', 'delivered', 'unread'] : box === 'cur' ? ACTIVE : TERMINAL).includes(m.status));
  return list.slice(-limit).reverse();
}

export function status(cfg, me) {
  const peers = {};
  for (const p of PEERS) {
    const sessions = listSessions(p).map((s) => ({ session_id: s.session_id, state: s.state, cwd: s.cwd, tmux: !!s.tmux, updated_at: s.updated_at }));
    const bg = getBg(p);
    const inboxOpen = listMessages({ to: p }).filter((m) => !TERMINAL.includes(m.status));
    peers[p] = {
      name: cfg.peers[p].name, role: cfg.peers[p].role, config_dir: cfg.peers[p].config_dir,
      sessions, background_worker: bg, open_messages: inboxOpen.map(summary),
    };
  }
  return {
    me, peers,
    delivery: cfg.delivery, approval: cfg.approval, keep_context: cfg.background.keep_context,
    spawn: cfg.spawn, terminal_app: cfg.terminal_app,
  };
}

/** Human/Claude readable rendering of a message. */
export function render(m, { full = true } = {}) {
  const lines = [summary(m)];
  if (full) {
    lines.push(`thread: ${m.thread_id}${m.reply_to ? ` · trả lời cho: ${m.reply_to}` : ''} · hop: ${m.hop} · tạo lúc: ${m.created_at}`);
    if (m.cwd) lines.push(`thư mục làm việc: ${m.cwd}`);
    lines.push('', m.body || '(trống)');
    if (m.acceptance && m.acceptance.length) lines.push('', 'Tiêu chí hoàn thành:', ...m.acceptance.map((x) => `- ${x}`));
    if (m.attachments && m.attachments.length) lines.push('', 'Đính kèm (đọc trực tiếp từ đường dẫn):', ...m.attachments.map((x) => `- ${x.path}${x.note ? ` — ${x.note}` : ''}`));
    if (m.meta && m.meta.body_file) lines.push('', `Nội dung đầy đủ: ${m.meta.body_file}`);
    if (m.result) {
      lines.push('', `Kết quả: ${m.result.status}${m.result.auto_result ? ' (tự tạo vì bên kia không gọi duo_reply)' : ''}`);
      if (m.result.outputs && m.result.outputs.length) lines.push('Sản phẩm:', ...m.result.outputs.map((x) => `- ${x.path}`));
      if (m.result.open_issues && m.result.open_issues.length) lines.push('Vấn đề còn mở:', ...m.result.open_issues.map((x) => `- ${x}`));
    }
  }
  return lines.join('\n');
}
