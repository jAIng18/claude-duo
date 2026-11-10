// `duo doctor`: environment checks with Vietnamese fix-it hints. SPEC §13.3.
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { configExists, loadConfig, PEERS, label } from './config.mjs';
import { authStatus, version, cmpVersion, MIN_VERSION, configDirExists } from './claude.mjs';
import { hasTmux } from './tmux.mjs';
import { paths, normalizeDir, isTrusted } from './paths.mjs';
import { hasPermissionRule, pluginState } from './settings.mjs';

export async function doctor({ cwd = process.cwd() } = {}) {
  const out = [];
  const ok = (m) => out.push({ level: 'ok', m });
  const warn = (m, fix) => out.push({ level: 'warn', m, fix });
  const fail = (m, fix) => out.push({ level: 'fail', m, fix });

  if (process.platform !== 'darwin') fail(`Hệ điều hành ${process.platform}: claude-duo hiện chỉ hỗ trợ macOS.`);
  else {
    let ver = os.release();
    try { ver = execFileSync('sw_vers', ['-productVersion'], { encoding: 'utf8', timeout: 3000 }).trim(); } catch { /* keep kernel version */ }
    ok(`macOS ${ver} (${process.arch})`);
  }

  const nodeMajor = Number(process.versions.node.split('.')[0]);
  if (nodeMajor < 18) fail(`Node ${process.versions.node} quá cũ (cần ≥ 18)`, 'brew upgrade node');
  else ok(`Node ${process.versions.node}`);

  const v = await version();
  if (!v) fail('Không tìm thấy lệnh `claude`', 'Cài Claude Code: https://docs.claude.com/claude-code');
  else if (cmpVersion(v, MIN_VERSION) < 0) warn(`Claude Code ${v} cũ hơn bản đã kiểm thử ${MIN_VERSION}`, 'claude update');
  else ok(`Claude Code ${v}`);

  if (hasTmux()) ok('tmux có sẵn'); else warn('Chưa có tmux (cần cho live-session / gom cửa sổ)', 'brew install tmux');

  if (process.env.ANTHROPIC_API_KEY) warn('Biến ANTHROPIC_API_KEY đang được đặt: nó sẽ ghi đè đăng nhập của CẢ HAI tài khoản', 'Xóa export ANTHROPIC_API_KEY khỏi ~/.zshrc');

  if (!configExists()) {
    fail(`Chưa có cấu hình ${paths.config()}`, 'Mở claude-a rồi gõ /duo:setup (hoặc chạy `duo init`)');
    return out;
  }
  let cfg;
  try { cfg = loadConfig(); ok(`Cấu hình hợp lệ: ${paths.config()}`); } catch (e) { fail(e.message, `Sửa file ${paths.config()} hoặc xóa nó rồi chạy /duo:setup`); return out; }

  try {
    const mode = fs.statSync(paths.root()).mode & 0o777;
    if (mode & 0o077) warn(`${paths.root()} có quyền ${mode.toString(8)} (nên là 700)`, `chmod 700 ${paths.root()}`);
  } catch { /* */ }
  if (/Mobile Documents|Dropbox|Google Drive|OneDrive/i.test(paths.root())) warn('Thư mục claude-duo nằm trong thư mục đồng bộ đám mây', 'Đặt DUO_HOME ra ngoài iCloud/Dropbox');

  const accounts = {};
  for (const p of PEERS) {
    const dir = cfg.peers[p].config_dir;
    const nd = normalizeDir(dir);
    if (dir !== nd && !dir.startsWith('~/')) warn(`peers.${p}.config_dir "${dir}" chưa chuẩn hóa (sẽ dùng ${nd})`);
    if (!configDirExists(dir)) { fail(`${label(cfg, p)}: config dir ${nd} chưa tồn tại / chưa đăng nhập`, p === 'A' ? 'Chạy `claude` và /login' : `Chạy claude-${p.toLowerCase()} rồi gõ /login bằng tài khoản thứ 2`); continue; }
    const st = await authStatus(dir);
    if (!st.loggedIn) { fail(`${label(cfg, p)}: chưa đăng nhập (${nd})`, `Chạy claude-${p.toLowerCase()} rồi gõ /login`); continue; }
    accounts[p] = st;
    ok(`${label(cfg, p)}: đăng nhập ${st.subscriptionType || st.authMethod}${st.email ? ` (${st.email})` : ''}`);
    const ps = pluginState(dir);
    if (cfg.dev && cfg.dev.plugin_dir) ok(`${label(cfg, p)}: dùng plugin dev tại ${cfg.dev.plugin_dir}`);
    else if (!ps.installed) fail(`${label(cfg, p)}: chưa cài plugin duo`, 'Chạy lại ./install.sh');
    else if (!ps.enabled) fail(`${label(cfg, p)}: plugin ${ps.installed} đang bị tắt`, `CLAUDE_CONFIG_DIR=… claude plugin enable ${ps.installed}`);
    else ok(`${label(cfg, p)}: plugin ${ps.installed} đã bật`);
    if (!hasPermissionRule(dir)) warn(`${label(cfg, p)}: chưa cho phép sẵn các tool duo (sẽ bị hỏi quyền mỗi lần)`, 'duo install-permissions');
    const t = isTrusted(dir, cwd);
    if (t === false) warn(`${label(cfg, p)} chưa tin cậy thư mục ${cwd} (mode background sẽ không chạy được ở đây)`, `cd ${cwd} && claude-${p.toLowerCase()}  → chọn Yes ở hộp thoại tin cậy`);
  }
  if (accounts.A && accounts.B) {
    const same = (accounts.A.orgId && accounts.A.orgId === accounts.B.orgId) || (accounts.A.email && accounts.A.email === accounts.B.email);
    if (same) warn('A và B đang đăng nhập CÙNG một tài khoản', 'Đăng nhập lại B bằng tài khoản thứ 2');
    else ok('A và B là 2 tài khoản khác nhau');
  }
  if (cfg.spawn.permission_mode === 'bypassPermissions') warn('spawn.permission_mode = bypassPermissions: phiên được mở sẽ KHÔNG hỏi quyền gì cả', 'Chỉ dùng trong máy ảo/sandbox');
  const appPath = cfg.terminal_app === 'iTerm2' ? '/Applications/iTerm.app' : '/System/Applications/Utilities/Terminal.app';
  if (!fs.existsSync(appPath)) warn(`Không thấy ${cfg.terminal_app} (${appPath}) cho mode new-tab`, 'Đổi terminal_app bằng /duo:config');
  return out;
}

export function formatDoctor(items) {
  const icon = { ok: '✅', warn: '⚠️ ', fail: '❌' };
  const lines = items.map((i) => `${icon[i.level]} ${i.m}${i.fix ? `\n     → ${i.fix}` : ''}`);
  const fails = items.filter((i) => i.level === 'fail').length;
  const warns = items.filter((i) => i.level === 'warn').length;
  lines.push('', fails ? `${fails} lỗi, ${warns} cảnh báo.` : warns ? `Chạy được, ${warns} cảnh báo.` : 'Mọi thứ đều ổn.');
  return lines.join('\n');
}
