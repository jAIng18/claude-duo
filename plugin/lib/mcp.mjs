// Minimal, dependency-free MCP server (JSON-RPC 2.0 over newline-delimited
// stdio). Tools: SPEC §9.
import readline from 'node:readline';
import {
  loadConfig, saveConfig, configExists, initConfig, requireMe, DuoError, getKey, setKey,
  SAFE_PERMISSION_MODES, MODES, label, defaultConfig,
} from './config.mjs';
import * as A from './actions.mjs';
import { summary } from './mailbox.mjs';
import { listExamples, installExample } from './examples.mjs';
import { log } from './fsutil.mjs';

const SERVER = { name: 'duo', version: '0.4.0' };
const PROTOCOLS = ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25'];

const idProp = { type: 'string', description: 'Message id, dạng YYYYMMDD-HHMMSS-xxxx' };
const pathList = {
  type: 'array',
  items: { type: 'object', properties: { path: { type: 'string', description: 'Đường dẫn TUYỆT ĐỐI' }, note: { type: 'string' } }, required: ['path'], additionalProperties: false },
};

export const TOOLS = [
  {
    name: 'duo_send',
    description: 'Gửi task / câu hỏi / thông báo cho peer Claude còn lại (tài khoản kia). Nội dung phải TỰ CHỨA ngữ cảnh: bên kia không thấy hội thoại của bạn. Nếu trả về approval_required: cho người dùng xem bản nháp, chỉ gọi lại với user_confirmed=true khi họ đồng ý. Kết quả sẽ quay về như một message "result" (đọc bằng duo_get) hoặc chờ bằng duo_wait.',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['task', 'question', 'info'], description: 'task = giao việc, question = hỏi ý kiến/thông tin, info = thông báo một chiều' },
        title: { type: 'string', description: 'Tiêu đề ngắn (≤ 300 ký tự)' },
        body: { type: 'string', description: 'Mô tả đầy đủ, tự chứa ngữ cảnh: mục tiêu, bối cảnh, file liên quan, ràng buộc' },
        acceptance: { type: 'array', items: { type: 'string' }, description: 'Tiêu chí hoàn thành' },
        attachments: pathList,
        cwd: { type: 'string', description: 'Thư mục bên kia nên làm việc (mặc định: thư mục hiện tại)' },
        delivery: { type: 'string', enum: MODES, description: 'Ghi đè cách giao cho riêng message này (bình thường để trống)' },
        parent_id: { type: 'string', description: 'Id message mà việc này phát sinh từ đó (nếu có)' },
        deadline_s: { type: 'integer', minimum: 60, description: 'Hết hạn sau N giây nếu chưa ai nhận' },
        user_confirmed: { type: 'boolean', description: 'true CHỈ KHI người dùng đã đồng ý bản nháp' },
      },
      required: ['type', 'title', 'body'],
      additionalProperties: false,
    },
  },
  {
    name: 'duo_inbox',
    description: 'Liệt kê message gửi tới bạn (hoặc bạn đã gửi, sent=true).',
    inputSchema: {
      type: 'object',
      properties: {
        box: { type: 'string', enum: ['open', 'new', 'cur', 'done', 'all'], description: 'open = chưa kết thúc (mặc định)' },
        sent: { type: 'boolean' },
        limit: { type: 'integer', minimum: 1, maximum: 200 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'duo_get',
    description: 'Đọc đầy đủ một message. Với task/câu hỏi gửi tới bạn: đọc nghĩa là bắt đầu xử lý (trừ khi cần người dùng chấp nhận trước). Với kết quả/thông báo: đánh dấu đã đọc.',
    inputSchema: { type: 'object', properties: { id: idProp }, required: ['id'], additionalProperties: false },
  },
  {
    name: 'duo_accept',
    description: 'Chấp nhận một task/câu hỏi SAU KHI người dùng đồng ý (chỉ cần khi duo_get báo cần chấp nhận).',
    inputSchema: { type: 'object', properties: { id: idProp }, required: ['id'], additionalProperties: false },
  },
  {
    name: 'duo_reply',
    description: 'Trả kết quả cho task/câu hỏi bạn đã nhận. BẮT BUỘC gọi khi xong. status: done (xong), failed (không làm được, nêu lý do), needs_info (cần hỏi lại bên giao — summary là câu hỏi).',
    inputSchema: {
      type: 'object',
      properties: {
        id: idProp,
        status: { type: 'string', enum: ['done', 'failed', 'needs_info'] },
        summary: { type: 'string', description: 'Tóm tắt kết quả (hoặc câu hỏi nếu needs_info)' },
        details: { type: 'string', description: 'Chi tiết: đã làm gì, lệnh đã chạy, kết quả kiểm tra' },
        outputs: pathList,
        open_issues: { type: 'array', items: { type: 'string' } },
      },
      required: ['id', 'status', 'summary'],
      additionalProperties: false,
    },
  },
  {
    name: 'duo_reject',
    description: 'Từ chối một task/câu hỏi (ví dụ ngoài phạm vi, người dùng không đồng ý).',
    inputSchema: { type: 'object', properties: { id: idProp, reason: { type: 'string' } }, required: ['id', 'reason'], additionalProperties: false },
  },
  {
    name: 'duo_wait',
    description: 'Chờ kết quả của một message bạn đã gửi (chặn tối đa timeout_s giây, mặc định 600). Chỉ dùng khi bạn KHÔNG thể làm tiếp nếu chưa có kết quả.',
    inputSchema: { type: 'object', properties: { id: idProp, timeout_s: { type: 'integer', minimum: 1, maximum: 3600 } }, required: ['id'], additionalProperties: false },
  },
  {
    name: 'duo_cancel',
    description: 'Hủy một message bạn đã gửi mà chưa xong.',
    inputSchema: { type: 'object', properties: { id: idProp, reason: { type: 'string' } }, required: ['id'], additionalProperties: false },
  },
  {
    name: 'duo_status',
    description: 'Trạng thái claude-duo: bạn là peer nào, các phiên đang mở, message đang chờ, cấu hình giao nhận.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'duo_config',
    description: 'Xem / khởi tạo / sửa cấu hình claude-duo. action=get (key tùy chọn, dạng a.b.c), action=init (tạo cấu hình mới, values = các giá trị ghi đè), action=set (key + value). init/set CHỈ gọi sau khi người dùng đồng ý, kèm user_confirmed=true.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['get', 'set', 'init'] },
        key: { type: 'string' },
        value: { description: 'Giá trị mới (JSON bất kỳ)' },
        values: { type: 'object', description: 'Cho action=init: object ghi đè lên cấu hình mặc định' },
        user_confirmed: { type: 'boolean' },
      },
      required: ['action'],
      additionalProperties: false,
    },
  },
  {
    name: 'duo_examples',
    description: 'Bộ agent mẫu theo domain (dev, design, pm, research). action=list để xem; action=install để cài một bộ (copy agent vào đúng tài khoản A/B và đặt vai trò) — chỉ sau khi người dùng đồng ý, kèm user_confirmed=true.',
    inputSchema: {
      type: 'object',
      properties: { action: { type: 'string', enum: ['list', 'install'] }, name: { type: 'string' }, overwrite: { type: 'boolean' }, user_confirmed: { type: 'boolean' } },
      required: ['action'],
      additionalProperties: false,
    },
  },
];

function text(t) { return { content: [{ type: 'text', text: t }] }; }
function errText(t) { return { content: [{ type: 'text', text: t }], isError: true }; }

function deliveryLine(cfg, d) {
  if (!d) return '';
  if (d.ok) return `Đã giao (${d.via || 'ok'}${d.confirmed === false ? ', chưa xác nhận bên kia đã nhận' : ''}).`;
  if (d.queued) return `Đang xếp hàng (${d.error}); sẽ tự giao khi bên kia rảnh.${d.hint ? ` ${d.hint}` : ''}`;
  return `CHƯA giao được (${d.error}).${d.hint ? ` ${d.hint}` : ''} Message vẫn nằm trong hộp thư; báo người dùng.`;
}

const BLOCKED_KEYS = [/^dev\./, /^dev$/, /^version$/];

const handlers = {
  async duo_send(a, cfg, me, sid) {
    const r = await A.send(cfg, me, sid, a);
    return text(`Đã tạo ${r.message.id} → ${label(cfg, r.message.to)}. ${deliveryLine(cfg, r.delivery)}\nTrạng thái: ${r.message.status}. Khi có kết quả bạn sẽ được báo; hoặc gọi duo_wait("${r.message.id}") nếu phải chờ.`);
  },
  async duo_inbox(a, cfg, me) {
    const list = A.inbox(cfg, me, a);
    if (!list.length) return text('(không có message nào)');
    return text(list.map(summary).join('\n'));
  },
  async duo_get(a, cfg, me, sid) {
    const r = A.get(cfg, me, sid, a.id);
    const parts = [A.render(r.message)];
    if (r.needsAccept) parts.push('', '⚠️ CHƯA CHẤP NHẬN: cấu hình yêu cầu người dùng đồng ý trước. Tóm tắt task cho người dùng, hỏi họ; nếu đồng ý gọi duo_accept, nếu không gọi duo_reject.');
    else if (r.message.to === me && ['task', 'question'].includes(r.message.type) && r.message.status === 'in_progress') {
      parts.push('', `➡️ Bạn đang xử lý message này. Làm đúng phạm vi rồi gọi duo_reply(id="${r.message.id}").`);
    }
    if (r.message.type === 'cancel') parts.push('', '➡️ Dừng việc liên quan; KHÔNG gọi duo_reply cho message đã hủy.');
    if (r.thread.length) parts.push('', 'Các message cùng thread:', ...r.thread.map((x) => `- ${summary(x)}`));
    return text(parts.join('\n'));
  },
  async duo_accept(a, cfg, me, sid) {
    const m = A.accept(cfg, me, sid, a.id);
    return text(`Đã chấp nhận ${m.id}. Bắt đầu làm, xong thì gọi duo_reply.`);
  },
  async duo_reply(a, cfg, me, sid) {
    const r = await A.reply(cfg, me, sid, a);
    if (r.question) return text(`Đã gửi câu hỏi ${r.question.id} cho ${label(cfg, r.question.to)}. ${deliveryLine(cfg, r.delivery)} Task ${r.task.id} chuyển sang needs_info; khi có câu trả lời bạn sẽ được báo.`);
    return text(`Đã trả kết quả ${r.result.id} (${a.status}) cho ${label(cfg, r.result.to)}. ${deliveryLine(cfg, r.delivery)}`);
  },
  async duo_reject(a, cfg, me, sid) {
    const r = await A.reject(cfg, me, sid, a);
    return text(`Đã từ chối ${r.task.id}. ${deliveryLine(cfg, r.delivery)}`);
  },
  async duo_wait(a, cfg, me) {
    const r = await A.wait(cfg, me, a);
    if (r.timeout) return text(`Hết thời gian chờ. ${r.task.id} đang ở trạng thái ${r.task.status}. Có thể gọi duo_wait lại hoặc làm việc khác.`);
    if (!r.answer) return text(`${r.task.id} đã kết thúc với trạng thái ${r.task.status}.`);
    if (r.answer.type === 'question') return text(`Bên kia cần thêm thông tin (câu hỏi ${r.answer.id}):\n\n${A.render(r.answer)}\n\n➡️ Trả lời bằng duo_reply(id="${r.answer.id}", status="done", summary=<câu trả lời>).`);
    return text(A.render(r.answer));
  },
  async duo_cancel(a, cfg, me, sid) {
    const r = await A.cancel(cfg, me, sid, a);
    return text(`Đã hủy ${r.task.id}.${r.note ? ` Đã báo bên kia (${r.note.id}).` : ''}`);
  },
  async duo_status(a, cfg, me) {
    return text(JSON.stringify(A.status(cfg, me), null, 2));
  },
  async duo_examples(a, cfg) {
    if (a.action === 'list') return text(listExamples().map((e) => `- ${e.name}: ${e.title} — ${e.description}\n  A: ${e.roles.A.name} · B: ${e.roles.B.name}`).join('\n') || '(không có)');
    if (a.user_confirmed !== true) throw new DuoError('approval_required', 'Hỏi người dùng trước, rồi gọi lại với user_confirmed=true.');
    const r = installExample(cfg, String(a.name || ''), { overwrite: a.overwrite === true });
    return text(r.lines.join('\n'));
  },
};

async function configTool(a) {
  if (a.action === 'get') {
    if (!configExists()) return text('Chưa có cấu hình. Dùng action=init (sau khi người dùng đồng ý) để tạo. Mặc định sẽ là:\n' + JSON.stringify(defaultConfig(), null, 2));
    const cfg = loadConfig();
    return text(JSON.stringify(a.key ? getKey(cfg, a.key) : cfg, null, 2));
  }
  if (a.user_confirmed !== true) throw new DuoError('approval_required', 'Thay đổi cấu hình cần người dùng đồng ý. Trình bày thay đổi, hỏi họ, rồi gọi lại với user_confirmed=true.');
  if (a.action === 'init') {
    if (configExists()) throw new DuoError('exists', 'Đã có cấu hình. Dùng action=set để sửa từng mục.');
    const values = a.values && typeof a.values === 'object' ? a.values : {};
    if (values.dev) throw new DuoError('forbidden', 'Không được đặt dev.* qua tool');
    if (values.spawn && values.spawn.permission_mode && !SAFE_PERMISSION_MODES.includes(values.spawn.permission_mode)) {
      throw new DuoError('forbidden', `spawn.permission_mode qua tool chỉ được: ${SAFE_PERMISSION_MODES.join(', ')}`);
    }
    const cfg = initConfig(values);
    return text('Đã tạo cấu hình:\n' + JSON.stringify(cfg, null, 2));
  }
  if (a.action === 'set') {
    const key = String(a.key || '');
    if (!key || BLOCKED_KEYS.some((re) => re.test(key))) throw new DuoError('forbidden', `Không được sửa key "${key}" qua tool`);
    if (key === 'spawn.permission_mode' && !SAFE_PERMISSION_MODES.includes(a.value)) {
      throw new DuoError('forbidden', `spawn.permission_mode qua tool chỉ được: ${SAFE_PERMISSION_MODES.join(', ')} (bypassPermissions chỉ đặt được bằng tay trong file config)`);
    }
    if (key === 'spawn' && a.value && typeof a.value === 'object' && a.value.permission_mode && !SAFE_PERMISSION_MODES.includes(a.value.permission_mode)) {
      throw new DuoError('forbidden', 'spawn.permission_mode không hợp lệ cho tool');
    }
    const cfg = loadConfig();
    const next = setKey(cfg, key, a.value);
    saveConfig(next);
    return text(`Đã đặt ${key} = ${JSON.stringify(a.value)}`);
  }
  throw new DuoError('bad_args', 'action phải là get | set | init');
}

export async function callTool(name, args, env = process.env) {
  const a = args && typeof args === 'object' ? args : {};
  try {
    if (name === 'duo_config') return await configTool(a);
    if (!handlers[name]) return errText(`Tool không tồn tại: ${name}`);
    const cfg = loadConfig();
    if (name === 'duo_examples' && a.action === 'list') return await handlers[name](a, cfg);
    const me = requireMe(cfg, env);
    const sid = env.CLAUDE_CODE_SESSION_ID || null;
    return await handlers[name](a, cfg, me, sid);
  } catch (e) {
    if (e instanceof DuoError) return errText(`[${e.code}] ${e.message}`);
    log('tool-crash', name, String(e && e.stack || e));
    return errText(`Lỗi nội bộ claude-duo: ${e && e.message}. Xem log: ~/.claude-duo/logs/duo.log`);
  }
}

export function serve(input = process.stdin, output = process.stdout) {
  const send = (o) => output.write(JSON.stringify(o) + '\n');
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  rl.on('line', async (line) => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); return; }
    if (Array.isArray(msg)) { send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Batch not supported' } }); return; }
    const { id, method, params } = msg;
    const isRequest = id !== undefined && id !== null;
    try {
      if (method === 'initialize') {
        const want = params && params.protocolVersion;
        send({ jsonrpc: '2.0', id, result: { protocolVersion: PROTOCOLS.includes(want) ? want : PROTOCOLS.at(-1), capabilities: { tools: { listChanged: false } }, serverInfo: SERVER, instructions: 'claude-duo: giao tiếp với peer Claude ở tài khoản còn lại. Xem skill duo-protocol.' } });
      } else if (method === 'ping') {
        if (isRequest) send({ jsonrpc: '2.0', id, result: {} });
      } else if (method === 'tools/list') {
        send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
      } else if (method === 'tools/call') {
        const result = await callTool(params && params.name, params && params.arguments);
        send({ jsonrpc: '2.0', id, result });
      } else if (isRequest) {
        send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
      }
      // notifications (no id) are ignored
    } catch (e) {
      log('rpc-error', method, String(e && e.stack || e));
      if (isRequest) send({ jsonrpc: '2.0', id, error: { code: -32603, message: String(e && e.message) } });
    }
  });
  return rl;
}
