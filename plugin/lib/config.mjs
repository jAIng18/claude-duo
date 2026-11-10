// ~/.claude-duo/config.json: defaults, validation, peer lookup.
import fs from 'node:fs';
import { paths, normalizeDir, currentConfigDir } from './paths.mjs';
import { readJSON, writeJSONAtomic, ensureDir } from './fsutil.mjs';

export const PEERS = ['A', 'B'];
export const MODES = ['background', 'new-tab', 'live-session'];
export const PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions'];
// Modes the setup wizard / duo_config tool may set. bypassPermissions is only
// possible by editing the file by hand, and `duo doctor` warns about it.
export const SAFE_PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'auto'];
export const TERMINAL_APPS = ['Terminal', 'iTerm2'];
export const DUO_MCP_RULE = 'mcp__plugin_duo_duo';

export function defaultConfig() {
  return {
    version: 1,
    peers: {
      A: { name: 'A', config_dir: '~/.claude', role: 'Lập kế hoạch, chia việc, review kết quả' },
      B: { name: 'B', config_dir: '~/.claude-b', role: 'Thực thi task được giao, báo cáo chi tiết' },
    },
    delivery: { A_to_B: 'new-tab', B_to_A: 'new-tab', fallback: 'new-tab' },
    background: { keep_context: true },
    new_tab: { reuse_live: true, use_tmux: true, activate: true },
    approval: { before_send: 'ask', before_accept: 'auto' },
    spawn: {
      permission_mode: 'acceptEdits',
      allowed_tools: ['Read', 'Edit', 'Write', 'Grep', 'Glob'],
      model: null,
    },
    limits: {
      max_hops: 3,
      max_concurrent: 2,
      max_messages_per_10min: 20,
      default_deadline_s: 3600,
      max_auto_continue: 5,
      max_reply_reminders: 2,
    },
    auto_continue: true,
    wake_on_result: true,
    notify: true,
    terminal_app: 'Terminal',
    retention_days: 30,
    dev: { plugin_dir: null },
  };
}

function isObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }

export function deepMerge(base, over) {
  if (!isObj(base) || !isObj(over)) return over === undefined ? base : over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = isObj(v) && isObj(base[k]) ? deepMerge(base[k], v) : v;
  return out;
}

/** Returns a list of human-readable problems (empty = valid). */
export function validate(cfg) {
  const errs = [];
  if (!isObj(cfg)) return ['config không phải object'];
  for (const p of PEERS) {
    const peer = cfg.peers && cfg.peers[p];
    if (!isObj(peer)) { errs.push(`thiếu peers.${p}`); continue; }
    if (typeof peer.config_dir !== 'string' || !peer.config_dir) errs.push(`peers.${p}.config_dir trống`);
    if (typeof peer.name !== 'string' || !peer.name.trim()) errs.push(`peers.${p}.name trống`);
  }
  if (!errs.length && normalizeDir(cfg.peers.A.config_dir) === normalizeDir(cfg.peers.B.config_dir)) {
    errs.push('peers.A và peers.B đang dùng cùng một config_dir');
  }
  for (const k of ['A_to_B', 'B_to_A', 'fallback']) {
    if (!MODES.includes(cfg.delivery?.[k])) errs.push(`delivery.${k} phải là một trong: ${MODES.join(', ')}`);
  }
  if (!['ask', 'auto'].includes(cfg.approval?.before_send)) errs.push('approval.before_send phải là ask|auto');
  if (!['ask', 'auto'].includes(cfg.approval?.before_accept)) errs.push('approval.before_accept phải là ask|auto');
  if (!PERMISSION_MODES.includes(cfg.spawn?.permission_mode)) errs.push(`spawn.permission_mode phải là một trong: ${PERMISSION_MODES.join(', ')}`);
  if (!Array.isArray(cfg.spawn?.allowed_tools) || cfg.spawn.allowed_tools.some((t) => typeof t !== 'string' || !t.trim() || t.includes(','))) {
    errs.push('spawn.allowed_tools phải là mảng tên tool (không chứa dấu phẩy)');
  }
  if (!TERMINAL_APPS.includes(cfg.terminal_app)) errs.push(`terminal_app phải là: ${TERMINAL_APPS.join(' | ')}`);
  for (const [k, v] of Object.entries(cfg.limits || {})) {
    if (!Number.isInteger(v) || v < 0) errs.push(`limits.${k} phải là số nguyên ≥ 0`);
  }
  return errs;
}

export function configExists() {
  return fs.existsSync(paths.config());
}

export function loadConfig() {
  const raw = readJSON(paths.config(), null);
  if (raw === null) throw new DuoError('not_configured', 'Chưa có cấu hình claude-duo. Chạy /duo:setup (hoặc `duo init`).');
  const cfg = deepMerge(defaultConfig(), raw);
  const errs = validate(cfg);
  if (errs.length) throw new DuoError('invalid_config', `Cấu hình không hợp lệ (${paths.config()}):\n- ${errs.join('\n- ')}`);
  return cfg;
}

export function saveConfig(cfg) {
  const errs = validate(cfg);
  if (errs.length) throw new DuoError('invalid_config', `Cấu hình không hợp lệ:\n- ${errs.join('\n- ')}`);
  ensureDir(paths.root());
  writeJSONAtomic(paths.config(), cfg);
}

export function initConfig(overrides = {}) {
  if (configExists()) return loadConfig();
  const cfg = deepMerge(defaultConfig(), overrides);
  saveConfig(cfg);
  return cfg;
}

export class DuoError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

/** Which peer is the Claude process we run inside? */
export function whoAmI(cfg, env = process.env) {
  const dir = currentConfigDir(env);
  for (const p of PEERS) if (normalizeDir(cfg.peers[p].config_dir) === dir) return p;
  return null;
}

export function requireMe(cfg, env = process.env) {
  const me = whoAmI(cfg, env);
  if (!me) {
    throw new DuoError('unknown_peer', `Phiên này dùng config dir ${currentConfigDir(env)}, không khớp peer nào trong ${paths.config()}. Kiểm tra peers.A/B.config_dir.`);
  }
  return me;
}

export const other = (p) => (p === 'A' ? 'B' : 'A');
export const label = (cfg, p) => `${p}:${cfg.peers[p].name}`;
export const directionKey = (from, to) => `${from}_to_${to}`;

/** Get/set a dotted key, used by `duo config` and the duo_config tool. */
export function getKey(obj, key) {
  return key.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

export function setKey(obj, key, value) {
  const parts = key.split('.');
  const copy = structuredClone(obj);
  let o = copy;
  for (const k of parts.slice(0, -1)) {
    if (!isObj(o[k])) o[k] = {};
    o = o[k];
  }
  o[parts.at(-1)] = value;
  return copy;
}
