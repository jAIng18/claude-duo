// Example agent packs (plugin/examples/<name>/). Installing one copies its
// subagent files into the right account's agents/ dir and sets peer roles.
import fs from 'node:fs';
import path from 'node:path';
import { PLUGIN_ROOT } from './open.mjs';
import { normalizeDir, isDefaultConfigDir, DEFAULT_CONFIG_DIR } from './paths.mjs';
import { saveConfig, DuoError, PEERS } from './config.mjs';
import { readJSON, ensureDir } from './fsutil.mjs';

export const EXAMPLES_DIR = path.join(PLUGIN_ROOT, 'examples');

export function listExamples() {
  let names = [];
  try { names = fs.readdirSync(EXAMPLES_DIR); } catch { return []; }
  return names.map((n) => {
    const meta = readJSON(path.join(EXAMPLES_DIR, n, 'example.json'), null);
    return meta ? { name: n, ...meta } : null;
  }).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name));
}

export function agentsDirFor(configDir) {
  return path.join(isDefaultConfigDir(configDir) ? DEFAULT_CONFIG_DIR : normalizeDir(configDir), 'agents');
}

export function installExample(cfg, name, { overwrite = false } = {}) {
  if (!/^[a-z0-9-]+$/.test(name)) throw new DuoError('bad_args', 'Tên bộ mẫu không hợp lệ');
  const ex = listExamples().find((e) => e.name === name);
  if (!ex) throw new DuoError('not_found', `Không có bộ mẫu "${name}". Có: ${listExamples().map((e) => e.name).join(', ')}`);
  const lines = [];
  const next = structuredClone(cfg);
  for (const p of PEERS) {
    const dest = ensureDir(agentsDirFor(cfg.peers[p].config_dir));
    for (const file of (ex.agents && ex.agents[p]) || []) {
      if (!/^[a-z0-9-]+\.md$/.test(file)) throw new DuoError('bad_example', `Tên file agent không hợp lệ: ${file}`);
      const src = path.join(EXAMPLES_DIR, name, 'agents', file);
      const target = path.join(dest, file);
      const content = fs.readFileSync(src, 'utf8');
      if (fs.existsSync(target) && fs.readFileSync(target, 'utf8') !== content && !overwrite) {
        lines.push(`- ${p}: BỎ QUA ${target} (đã có file khác cùng tên; dùng overwrite=true để ghi đè)`);
        continue;
      }
      fs.writeFileSync(target, content);
      lines.push(`- ${p}: đã cài agent ${target}`);
    }
    if (ex.roles && ex.roles[p]) {
      next.peers[p].name = ex.roles[p].name;
      next.peers[p].role = ex.roles[p].role;
    }
  }
  saveConfig(next);
  lines.unshift(`Đã cài bộ mẫu "${ex.title}". Vai trò: A = ${next.peers.A.name}, B = ${next.peers.B.name}.`);
  lines.push('Mở lại phiên claude-a / claude-b để nạp agent mới.');
  return { lines };
}
