// Careful edits of a peer's settings.json: add/remove ONE permission rule,
// keep everything else byte-for-byte equivalent (re-serialised JSON), and
// back the file up first. Also reads plugin install state.
import fs from 'node:fs';
import path from 'node:path';
import { normalizeDir, isDefaultConfigDir, DEFAULT_CONFIG_DIR } from './paths.mjs';
import { DUO_MCP_RULE } from './config.mjs';

export function configRoot(configDir) {
  return isDefaultConfigDir(configDir) ? DEFAULT_CONFIG_DIR : normalizeDir(configDir);
}

export function settingsFile(configDir) {
  return path.join(configRoot(configDir), 'settings.json');
}

function readSettings(file) {
  if (!fs.existsSync(file)) return {};
  const raw = fs.readFileSync(file, 'utf8');
  if (!raw.trim()) return {};
  const v = JSON.parse(raw); // throws on invalid JSON: we never overwrite a file we cannot parse
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error(`${file} không phải JSON object`);
  return v;
}

function writeSettings(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak-claude-duo`);
  const tmp = `${file}.claude-duo.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

export function hasPermissionRule(configDir, rule = DUO_MCP_RULE) {
  try {
    const s = readSettings(settingsFile(configDir));
    return Array.isArray(s.permissions && s.permissions.allow) && s.permissions.allow.includes(rule);
  } catch { return false; }
}

export function addPermissionRule(configDir, rule = DUO_MCP_RULE) {
  const file = settingsFile(configDir);
  const s = readSettings(file);
  if (s.permissions !== undefined && (typeof s.permissions !== 'object' || Array.isArray(s.permissions))) throw new Error(`${file}: "permissions" không phải object`);
  const perms = s.permissions || {};
  const allow = perms.allow === undefined ? [] : perms.allow;
  if (!Array.isArray(allow)) throw new Error(`${file}: permissions.allow không phải mảng`);
  if (allow.includes(rule)) return false;
  s.permissions = { ...perms, allow: [...allow, rule] };
  writeSettings(file, s);
  return true;
}

export function removePermissionRule(configDir, rule = DUO_MCP_RULE) {
  const file = settingsFile(configDir);
  if (!fs.existsSync(file)) return false;
  const s = readSettings(file);
  const allow = s.permissions && s.permissions.allow;
  if (!Array.isArray(allow) || !allow.includes(rule)) return false;
  s.permissions = { ...s.permissions, allow: allow.filter((r) => r !== rule) };
  writeSettings(file, s);
  return true;
}

/** Is a plugin "duo@<any marketplace>" installed and enabled for this config dir? */
export function pluginState(configDir) {
  const root = configRoot(configDir);
  let installed = null;
  try {
    const d = JSON.parse(fs.readFileSync(path.join(root, 'plugins', 'installed_plugins.json'), 'utf8'));
    installed = Object.keys(d.plugins || {}).find((k) => k.startsWith('duo@')) || null;
  } catch { /* none */ }
  let enabled = false;
  try {
    const s = readSettings(path.join(root, 'settings.json'));
    enabled = !!(installed && s.enabledPlugins && s.enabledPlugins[installed] === true);
  } catch { /* */ }
  return { installed, enabled };
}
