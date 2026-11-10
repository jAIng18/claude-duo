// Test sandbox: a temporary DUO_HOME and two fake peer config dirs.
// DUO_DRY_RUN=1 guarantees no Terminal windows, notifications or spawns.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'duo-test-'));
  const home = path.join(root, 'duo');
  const a = path.join(root, 'cfg-a');
  const b = path.join(root, 'cfg-b');
  fs.mkdirSync(a); fs.mkdirSync(b);
  process.env.DUO_HOME = home;
  process.env.DUO_DRY_RUN = '1';
  return {
    root, home, a, b,
    envA: { ...process.env, CLAUDE_CONFIG_DIR: a, CLAUDE_CODE_SESSION_ID: 'aaaaaaaa-0000-0000-0000-000000000001' },
    envB: { ...process.env, CLAUDE_CONFIG_DIR: b, CLAUDE_CODE_SESSION_ID: 'bbbbbbbb-0000-0000-0000-000000000002' },
    cleanup() { fs.rmSync(root, { recursive: true, force: true }); },
  };
}

export async function makeConfig(sb, over = {}) {
  const { initConfig, deepMerge } = await import('../plugin/lib/config.mjs');
  return initConfig(deepMerge({
    peers: { A: { name: 'Planner', config_dir: sb.a, role: 'plan' }, B: { name: 'Maker', config_dir: sb.b, role: 'make' } },
    approval: { before_send: 'auto', before_accept: 'auto' },
  }, over));
}
