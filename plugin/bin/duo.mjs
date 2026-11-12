#!/usr/bin/env node
// claude-duo CLI. Also the entry point for hooks (`duo hook <Event>`) and the
// MCP server (`duo mcp`).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  loadConfig, configExists, initConfig, saveConfig, getKey, setKey, PEERS, label, MODES, TERMINAL_APPS, DuoError,
} from '../lib/config.mjs';
import { paths, HOME, normalizeDir, envForConfigDir } from '../lib/paths.mjs';
import { ensureMailDirs, getMessage, listMessages, summary } from '../lib/mailbox.mjs';
import * as A from '../lib/actions.mjs';
import { deliver, kick } from '../lib/dispatch.mjs';
import { runHook } from '../lib/hooks.mjs';
import { serve } from '../lib/mcp.mjs';
import { gc } from '../lib/gc.mjs';
import { doctor, formatDoctor } from '../lib/doctor.mjs';
import { openHere, claudeBin } from '../lib/open.mjs';
import { getBg, setBg } from '../lib/registry.mjs';
import { addPermissionRule, removePermissionRule, pluginState } from '../lib/settings.mjs';
import { runClaude, stopBg } from '../lib/claude.mjs';
import { listExamples, installExample } from '../lib/examples.mjs';
import { tmux, hasTmux, SOCKET_NAME } from '../lib/tmux.mjs';
import { historyRows, formatHistory, totals } from '../lib/history.mjs';
import { QuotaWatcher, formatQuota } from '../lib/quota.mjs';
import { startMonitor, stopMonitor } from '../lib/monitor.mjs';

const VERSION = '0.6.0';
const MARKETPLACE = 'claude-duo';
const PLUGIN_ID = `duo@${MARKETPLACE}`;
const ZSHRC_BEGIN = '# >>> claude-duo >>>';
const ZSHRC_END = '# <<< claude-duo <<<';

function parse(argv) {
  const pos = []; const opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { pos.push(...argv.slice(i + 1)); break; }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) { opt[a.slice(2, eq)] = a.slice(eq + 1); continue; }
      const k = a.slice(2);
      const nxt = argv[i + 1];
      if (nxt !== undefined && !nxt.startsWith('--')) { opt[k] = nxt; i++; } else opt[k] = true;
    } else pos.push(a);
  }
  return { pos, opt };
}

function peerArg(v, what = 'peer') {
  const p = String(v || '').toUpperCase();
  if (!PEERS.includes(p)) throw new DuoError('bad_args', `${what} phải là A hoặc B`);
  return p;
}

function readStdin() {
  try { return fs.readFileSync(0, 'utf8'); } catch { return ''; }
}

const HELP = `claude-duo ${VERSION} — 2 tài khoản Claude Code giao việc cho nhau

Dùng hằng ngày:
  duo status                     Trạng thái 2 peer, phiên đang mở, message đang chờ
  duo inbox [A|B] [--all]        Hộp thư (mặc định: cả hai, chỉ message chưa xong)
  duo show <id>                  Xem một message
  duo log [A|B] [--days N] [--limit N] [--json] [--no-usage]
                                 Lịch sử việc đã giao: thời gian chờ/làm, token, chi phí ước tính
  duo quota [--json] [--watch]   Quota 5 giờ / tuần của 2 account (giống /usage)
  duo monitor [stop|--rebuild]   Cửa sổ nhỏ theo dõi quota 2 account, cập nhật trực tiếp
  duo open <A|B> [--cwd DIR]     Mở phiên Claude của peer (trong tmux nếu có)
  duo attach <A|B>               Xem phiên chạy nền của peer
  duo doctor                     Kiểm tra cài đặt, kèm cách sửa
  duo test [--live]              Kiểm tra nhanh; --live gửi thử 1 task A→B thật

Gửi từ terminal:
  duo send --as A --title "…" --body "…" [--type task|question|info] [--delivery MODE] [--cwd DIR]

Cấu hình:
  duo init [--a-dir ~/.claude] [--b-dir ~/.claude-b] [--a-name …] [--b-name …]
  duo config [get KEY] | set KEY VALUE
  duo examples [install NAME]

Bảo trì:
  duo deliver <id> · duo kick · duo gc
  duo install-permissions · duo uninstall [--purge]
`;

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { pos, opt } = parse(rest);
  switch (cmd) {
    case undefined: case 'help': case '--help': case '-h':
      process.stdout.write(HELP); return 0;
    case 'version': case '--version':
      console.log(VERSION); return 0;

    case 'hook': {
      const input = (() => { try { return JSON.parse(readStdin() || '{}'); } catch { return {}; } })();
      const out = await runHook(pos[0], input);
      process.stdout.write(JSON.stringify(out));
      return 0;
    }
    case 'mcp':
      serve();
      return null; // keep running

    case 'init': {
      if (configExists()) { console.log(`Đã có cấu hình: ${paths.config()} (dùng \`duo config\` để sửa)`); ensureMailDirs(); return 0; }
      const over = { peers: { A: {}, B: {} }, delivery: {} };
      if (opt['a-dir']) over.peers.A.config_dir = String(opt['a-dir']);
      if (opt['b-dir']) over.peers.B.config_dir = String(opt['b-dir']);
      if (opt['a-name']) over.peers.A.name = String(opt['a-name']);
      if (opt['b-name']) over.peers.B.name = String(opt['b-name']);
      if (opt['a-to-b']) over.delivery.A_to_B = String(opt['a-to-b']);
      if (opt['b-to-a']) over.delivery.B_to_A = String(opt['b-to-a']);
      if (opt.terminal) over.terminal_app = String(opt.terminal);
      const cfg = initConfig(over);
      ensureMailDirs();
      console.log(`Đã tạo ${paths.config()}\n  A = ${label(cfg, 'A')} (${cfg.peers.A.config_dir})\n  B = ${label(cfg, 'B')} (${cfg.peers.B.config_dir})`);
      return 0;
    }
    case 'config': {
      const cfg = loadConfig();
      if (!pos[0] || pos[0] === 'get') { console.log(JSON.stringify(pos[1] ? getKey(cfg, pos[1]) : cfg, null, 2)); return 0; }
      if (pos[0] === 'set') {
        if (!pos[1] || pos[2] === undefined) throw new DuoError('bad_args', 'duo config set KEY VALUE');
        let value = pos[2];
        try { value = JSON.parse(pos[2]); } catch { /* plain string */ }
        saveConfig(setKey(cfg, pos[1], value));
        console.log(`Đã đặt ${pos[1]} = ${JSON.stringify(value)}`);
        return 0;
      }
      throw new DuoError('bad_args', 'duo config [get KEY] | set KEY VALUE');
    }

    case 'status': {
      const cfg = loadConfig();
      const s = A.status(cfg, null);
      for (const p of PEERS) {
        const x = s.peers[p];
        console.log(`\n${p}: ${x.name}  (${x.config_dir})\n  vai trò: ${x.role}`);
        console.log(`  phiên đang mở: ${x.sessions.length ? x.sessions.map((q) => `${q.session_id.slice(0, 8)} ${q.state}${q.tmux ? ' [tmux]' : ''} ${q.cwd || ''}`).join('\n                 ') : '(không có)'}`);
        if (x.background_worker) console.log(`  phiên nền: ${x.background_worker.id} (${x.background_worker.cwd})`);
        console.log(`  message chưa xong gửi tới ${p}: ${x.open_messages.length ? `\n    ${x.open_messages.join('\n    ')}` : '0'}`);
      }
      console.log(`\nGiao nhận: A→B ${s.delivery.A_to_B} · B→A ${s.delivery.B_to_A} · dự phòng ${s.delivery.fallback} · duyệt trước khi gửi: ${s.approval.before_send}`);
      return 0;
    }
    case 'inbox': {
      loadConfig();
      const filter = pos[0] ? { to: peerArg(pos[0]) } : {};
      let list = listMessages(filter);
      if (!opt.all) list = list.filter((m) => !['done', 'failed', 'rejected', 'cancelled', 'expired', 'read'].includes(m.status));
      console.log(list.length ? list.map(summary).join('\n') : '(trống)');
      return 0;
    }
    case 'show': {
      const m = getMessage(String(pos[0] || ''));
      if (!m) throw new DuoError('not_found', `Không có message ${pos[0]}`);
      console.log(A.render(m));
      console.log('\n-- giao nhận --');
      for (const e of m.meta.delivery_log || []) console.log(`${e.at} ${JSON.stringify({ ...e, at: undefined })}`);
      return 0;
    }
    case 'log': {
      const cfg = loadConfig();
      const to = pos[0] ? peerArg(pos[0]) : null;
      const days = opt.days !== undefined ? Number(opt.days) : null;
      if (days !== null && !(days > 0)) throw new DuoError('bad_args', '--days phải là số dương');
      const limit = opt.limit !== undefined ? Number(opt.limit) : 20;
      if (!(Number.isInteger(limit) && limit > 0)) throw new DuoError('bad_args', '--limit phải là số nguyên dương');
      const all = historyRows(cfg, { to, since: days ? Date.now() - days * 86400000 : null, usage: !opt['no-usage'] });
      const shown = all.slice(-limit);
      if (opt.json) { console.log(JSON.stringify({ rows: shown, totals: totals(all) }, null, 2)); return 0; }
      console.log(formatHistory(cfg, shown, { all, limit }));
      return 0;
    }
    case 'quota': {
      const cfg = loadConfig();
      if (opt.watch) {
        // One JSON line per change (used by the monitor window). stdin: "refresh" forces
        // a new quota request; stdin closing (the window quit) ends the process.
        const w = new QuotaWatcher(cfg, { onChange: (s) => process.stdout.write(`${JSON.stringify(s)}\n`) });
        process.stdout.on('error', () => process.exit(0));
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', (d) => { if (/refresh/.test(d)) w.tick({ force: true }).catch(() => {}); });
        process.stdin.on('end', () => process.exit(0));
        await w.start();
        return null; // keep running
      }
      const w = new QuotaWatcher(cfg);
      await w.tick({ force: true });
      const snap = w.snapshot();
      console.log(opt.json ? JSON.stringify(snap, null, 2) : formatQuota(snap));
      return 0;
    }
    case 'monitor': {
      const cfg = loadConfig();
      if (pos[0] === 'stop') { console.log(stopMonitor() ? 'Đã tắt khung theo dõi.' : 'Khung theo dõi không chạy.'); return 0; }
      const r = startMonitor(cfg, { rebuild: !!opt.rebuild });
      console.log(r.already ? 'Khung theo dõi đang mở, đã đưa lên trước.' : `Đã mở khung theo dõi (pid ${r.pid}). Gọi lại bằng Cmd+Tab hoặc icon trên Dock; tắt bằng nút ×, Cmd+Q hoặc: duo monitor stop`);
      return 0;
    }
    case 'send': {
      const cfg = loadConfig();
      const me = peerArg(opt.as, '--as');
      const r = await A.send(cfg, me, null, {
        type: opt.type || 'task', title: opt.title, body: opt.body, delivery: opt.delivery,
        cwd: opt.cwd ? String(opt.cwd) : process.cwd(), user_confirmed: true,
      });
      console.log(`${r.message.id} → ${r.message.to}: ${r.message.status}`, JSON.stringify(r.delivery));
      if (opt.wait) {
        const w = await A.wait(cfg, me, { id: r.message.id, timeout_s: Number(opt.wait) || 600 });
        console.log(w.answer ? A.render(w.answer) : JSON.stringify(w));
      }
      return 0;
    }

    case 'open': {
      const cfg = loadConfig();
      const peer = peerArg(pos[0]);
      // Everything after `--` is passed to claude (alias: claude-b → duo open B --).
      const dd = rest.indexOf('--');
      const extra = dd >= 0 ? rest.slice(dd + 1) : [];
      return openHere(cfg, peer, { cwd: opt.cwd ? String(opt.cwd) : process.cwd(), prompt: typeof opt.prompt === 'string' ? opt.prompt : undefined, noTmux: !!opt['no-tmux'], extra });
    }
    case 'attach': {
      const cfg = loadConfig();
      const peer = peerArg(pos[0]);
      const bg = getBg(peer);
      const id = pos[1] || (bg && bg.id);
      if (!id) throw new DuoError('not_found', `${label(cfg, peer)} chưa có phiên nền nào`);
      const r = spawnSync(claudeBin(), ['attach', id], { stdio: 'inherit', env: envForConfigDir(cfg.peers[peer].config_dir) });
      return r.status ?? 1;
    }

    case 'deliver': {
      const cfg = loadConfig();
      const r = await deliver(cfg, String(pos[0] || ''));
      console.log(JSON.stringify(r));
      return r.ok || r.queued ? 0 : 1;
    }
    case 'kick': {
      const cfg = loadConfig();
      const r = await kick(cfg, { peer: opt.peer ? peerArg(opt.peer) : null });
      if (r.length) console.log(JSON.stringify(r));
      return 0;
    }
    case 'gc': {
      const cfg = loadConfig();
      console.log(JSON.stringify(gc(cfg)));
      return 0;
    }

    case 'doctor': {
      const items = await doctor({ cwd: opt.cwd ? String(opt.cwd) : process.cwd() });
      console.log(formatDoctor(items));
      return items.some((i) => i.level === 'fail') ? 1 : 0;
    }
    case 'test':
      return await selfTest(opt);

    case 'examples': {
      if (pos[0] === 'install') {
        const cfg = loadConfig();
        console.log(installExample(cfg, String(pos[1] || ''), { overwrite: !!opt.overwrite }).lines.join('\n'));
        return 0;
      }
      for (const e of listExamples()) console.log(`${e.name.padEnd(10)} ${e.title} — ${e.description}`);
      return 0;
    }

    case 'install-permissions': case 'uninstall-permissions': {
      const cfg = loadConfig();
      for (const p of PEERS) {
        const fn = cmd === 'install-permissions' ? addPermissionRule : removePermissionRule;
        const changed = fn(cfg.peers[p].config_dir);
        console.log(`${label(cfg, p)}: ${changed ? 'đã cập nhật' : 'không cần đổi'} ${normalizeDir(cfg.peers[p].config_dir)}/settings.json`);
      }
      return 0;
    }
    case 'uninstall':
      return await uninstall(opt);

    default:
      process.stderr.write(`Lệnh không rõ: ${cmd}\n\n${HELP}`);
      return 2;
  }
}

async function selfTest(opt) {
  const cfg = loadConfig();
  ensureMailDirs();
  const probe = path.join(paths.state(), `selftest-${process.pid}.json`);
  fs.mkdirSync(path.dirname(probe), { recursive: true });
  fs.writeFileSync(probe, '{"ok":true}');
  const okRw = JSON.parse(fs.readFileSync(probe, 'utf8')).ok === true;
  fs.rmSync(probe, { force: true });
  console.log(`${okRw ? '✅' : '❌'} Đọc/ghi ${paths.root()}`);
  const items = await doctor();
  console.log(formatDoctor(items));
  if (!opt.live) { console.log('\n(Thêm --live để gửi thử một task thật từ A sang B.)'); return items.some((i) => i.level === 'fail') ? 1 : 0; }
  const from = opt.from ? peerArg(opt.from) : 'A';
  const t0 = Date.now();
  const r = await A.send(cfg, from, null, {
    type: 'task', title: 'claude-duo test: pong',
    body: 'This is a claude-duo connectivity test. Do NOT use any other tool and do NOT edit files. Just call duo_reply with status "done" and summary exactly: pong',
    cwd: opt.cwd ? String(opt.cwd) : process.cwd(), delivery: opt.delivery, user_confirmed: true,
  });
  console.log(`\nĐã gửi ${r.message.id} (${from}→${r.message.to}): ${JSON.stringify(r.delivery)}`);
  const w = await A.wait(cfg, from, { id: r.message.id, timeout_s: Number(opt.timeout) || 300 });
  const secs = Math.round((Date.now() - t0) / 1000);
  if (w.answer && w.answer.result && /pong/i.test(w.answer.result.summary)) { console.log(`✅ Nhận "pong" sau ${secs}s qua ${getMessage(r.message.id).meta.delivered_via}`); return 0; }
  console.log(`❌ Không nhận được pong sau ${secs}s: ${JSON.stringify(w.answer ? w.answer.result : w.task.status)}`);
  return 1;
}

async function uninstall(opt) {
  const cfg = configExists() ? loadConfig() : null;
  if (cfg) {
    for (const p of PEERS) {
      const dir = cfg.peers[p].config_dir;
      const bg = getBg(p);
      if (bg && bg.id) { await stopBg(dir, bg.id); setBg(p, null); }
      const ps = pluginState(dir);
      if (ps.installed) console.log(`${p}: gỡ plugin`, (await runClaude(dir, ['plugin', 'uninstall', ps.installed])).code === 0 ? 'OK' : 'lỗi');
      const mk = await runClaude(dir, ['plugin', 'marketplace', 'remove', MARKETPLACE]);
      console.log(`${p}: gỡ marketplace ${mk.code === 0 ? 'OK' : '(không có)'}`);
      try { if (removePermissionRule(dir)) console.log(`${p}: đã bỏ quyền ${'mcp__plugin_duo_duo'}`); } catch (e) { console.log(`${p}: không sửa được settings.json: ${e.message}`); }
    }
  }
  const rc = path.join(HOME, '.zshrc');
  if (fs.existsSync(rc)) {
    const txt = fs.readFileSync(rc, 'utf8');
    const re = new RegExp(`\\n?${ZSHRC_BEGIN}[\\s\\S]*?${ZSHRC_END}\\n?`, 'g');
    if (re.test(txt)) { fs.copyFileSync(rc, `${rc}.bak-claude-duo`); fs.writeFileSync(rc, txt.replace(re, '\n')); console.log('Đã bỏ alias khỏi ~/.zshrc (bản sao lưu: ~/.zshrc.bak-claude-duo)'); }
  }
  if (opt.purge) {
    if (hasTmux()) { try { tmux(null, ['-L', SOCKET_NAME, 'kill-server']); } catch { /* not running */ } }
    fs.rmSync(paths.root(), { recursive: true, force: true });
    console.log(`Đã xóa ${paths.root()}`);
  } else console.log(`Giữ lại dữ liệu ở ${paths.root()} (thêm --purge để xóa).`);
  return 0;
}

// Plugin id/marketplace are used by install.sh too.
export { MARKETPLACE, PLUGIN_ID, ZSHRC_BEGIN, ZSHRC_END, MODES, TERMINAL_APPS };

main().then((code) => { if (code !== null) process.exitCode = code; }).catch((e) => {
  if (e instanceof DuoError) { process.stderr.write(`[${e.code}] ${e.message}\n`); process.exitCode = 1; return; }
  process.stderr.write(`${e && e.stack || e}\n`);
  process.exitCode = 1;
});
