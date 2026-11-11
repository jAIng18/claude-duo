// `duo log`: history of the work handed between the peers — how long each
// task waited and ran, and what it cost on the receiving side.
import { listMessages, WORK_TYPES } from './mailbox.mjs';
import { taskUsage } from './usage.mjs';

function ms(a, b) {
  const x = Date.parse(a || ''); const y = Date.parse(b || '');
  return Number.isFinite(x) && Number.isFinite(y) && y >= x ? y - x : null;
}

/** One history row per task/question. filter: { to, since (ms epoch) } */
export function historyRows(cfg, { to = null, since = null, usage = true } = {}) {
  let list = listMessages(to ? { to } : {}).filter((m) => WORK_TYPES.includes(m.type));
  if (since) list = list.filter((m) => Date.parse(m.created_at) >= since);
  return list.map((m) => {
    const started = m.meta.picked_up_at || m.meta.accepted_at || null;
    const u = usage ? taskUsage(cfg, m) : null;
    return {
      id: m.id,
      created_at: m.created_at,
      from: m.from,
      to: m.to,
      type: m.type,
      title: m.title,
      status: m.status,
      result_status: m.result ? m.result.status : null,
      auto_result: !!(m.result && m.result.auto_result),
      via: m.meta.delivered_via || null,
      error: m.meta.error || null,
      wait_ms: ms(m.created_at, started),
      work_ms: ms(started, m.meta.replied_at),
      usage: u ? {
        input: u.input, cache_write: u.cache_write, cache_read: u.cache_read, output: u.output,
        total_in: u.total_in, turns: u.turns, models: u.models, cost_usd: u.cost_usd,
      } : null,
    };
  });
}

export function totals(rows) {
  const t = { count: rows.length, done: 0, failed: 0, open: 0, work_ms: 0, total_in: 0, output: 0, cost_usd: 0, with_usage: 0, with_cost: 0 };
  for (const r of rows) {
    if (r.status === 'done') t.done++;
    else if (['failed', 'rejected', 'cancelled', 'expired'].includes(r.status)) t.failed++;
    else t.open++;
    if (r.work_ms) t.work_ms += r.work_ms;
    if (r.usage) {
      t.with_usage++; t.total_in += r.usage.total_in; t.output += r.usage.output;
      if (r.usage.cost_usd !== null) { t.with_cost++; t.cost_usd += r.usage.cost_usd; }
    }
  }
  t.cost_usd = Math.round(t.cost_usd * 10000) / 10000;
  return t;
}

// ------------------------------------------------------------------ format
export function fmtDuration(v) {
  if (v === null || v === undefined) return '-';
  const s = Math.round(v / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
}

export function fmtTokens(n) {
  if (n === null || n === undefined) return '-';
  if (n < 1000) return String(n);
  if (n < 1e6) return `${(n / 1000).toFixed(n < 10000 ? 1 : 0)}k`;
  return `${(n / 1e6).toFixed(1)}M`;
}

export function fmtCost(v) {
  if (v === null || v === undefined) return '-';
  return `$${v.toFixed(v < 1 ? 3 : 2)}`;
}

export function fmtTime(iso) {
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function statusText(r) {
  if (r.status === 'done' && r.auto_result) return 'done*';
  if (r.status === 'queued' && r.error) return `queued (${r.error})`;
  return r.status;
}

// Display width: count each code point once (good enough for Vietnamese
// with precomposed characters and for arrows/emoji-free text).
function width(s) { return [...String(s)].length; }
function pad(s, n, right = false) {
  const str = String(s); const w = width(str);
  if (w >= n) return str;
  return right ? ' '.repeat(n - w) + str : str + ' '.repeat(n - w);
}
function cut(s, n) {
  const c = [...String(s || '')];
  return c.length > n ? `${c.slice(0, n - 1).join('')}…` : c.join('');
}

export function formatHistory(cfg, rows, { all = rows, limit = rows.length, titleWidth = 48 } = {}) {
  if (!all.length) return '(chưa có việc nào được giao)';
  const head = ['Lúc', 'Chiều', 'Loại', 'Trạng thái', 'Chờ', 'Làm', 'Token vào', 'Ra', 'Chi phí~', 'Tiêu đề'];
  const body = rows.map((r) => [
    fmtTime(r.created_at), `${r.from}→${r.to}`, r.type, statusText(r),
    fmtDuration(r.wait_ms), fmtDuration(r.work_ms),
    r.usage ? fmtTokens(r.usage.total_in) : '-', r.usage ? fmtTokens(r.usage.output) : '-',
    r.usage ? fmtCost(r.usage.cost_usd) : '-', cut(r.title, titleWidth),
  ]);
  const right = new Set([4, 5, 6, 7, 8]);
  const w = head.map((h, i) => Math.max(width(h), ...body.map((b) => width(b[i]))));
  const line = (cells) => cells.map((c, i) => (i === cells.length - 1 ? c : pad(c, w[i], right.has(i)))).join('  ').trimEnd();
  const out = [line(head), line(w.map((n, i) => '─'.repeat(i === w.length - 1 ? Math.max(width(head[i]), 8) : n))), ...body.map(line)];

  if (all.length > rows.length) out.push(`… còn ${all.length - rows.length} việc cũ hơn (thêm --limit ${all.length} để xem hết)`);
  out.push('');
  for (const dir of [['A', 'B'], ['B', 'A']]) {
    const sub = all.filter((r) => r.from === dir[0] && r.to === dir[1]);
    if (!sub.length) continue;
    const t = totals(sub);
    const who = `${dir[0]}→${dir[1]} (${cfg.peers[dir[1]].name || dir[1]} làm)`;
    const usage = t.with_usage
      ? ` · token vào ${fmtTokens(t.total_in)}, ra ${fmtTokens(t.output)}${t.with_usage < t.count ? ` (đo được ${t.with_usage}/${t.count} việc)` : ''}`
        + (t.with_cost ? ` · chi phí~ ${fmtCost(t.cost_usd)}${t.with_cost < t.with_usage ? ` (có số cho ${t.with_cost}/${t.with_usage} việc)` : ''}` : '')
      : '';
    out.push(`${who}: ${t.count} việc · ${t.done} xong · ${t.failed} lỗi/hủy · ${t.open} chưa xong · tổng thời gian làm ${fmtDuration(t.work_ms)}${usage}`);
  }
  out.push('');
  out.push('Chờ = từ lúc gửi tới lúc bên nhận bắt đầu làm. Làm = từ lúc bắt đầu tới lúc trả kết quả. done* = kết quả do claude-duo tự tạo.');
  out.push('Token vào gồm cả cache. Chi phí~ là ước tính của Claude Code theo giá API, chỉ tính phía bên nhận; gói Pro/Max không bị tính tiền theo token.');
  out.push('Chi phí "-": Claude Code chỉ ghi chi phí khi phiên dừng. Hoặc phiên còn mở (sẽ có số khi phiên nhận việc kế tiếp hoặc tắt), hoặc phiên đã làm thêm việc khác trước khi dừng nên không tách riêng được. Token vẫn chính xác.');
  out.push(`Lịch sử giữ ${cfg.retention_days} ngày (retention_days).`);
  return out.join('\n');
}
