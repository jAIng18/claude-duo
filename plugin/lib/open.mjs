// Build and run an interactive Claude session for a peer, optionally inside
// the dedicated tmux server (socket name "claude-duo").
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { normalizeDir, isDefaultConfigDir, shq, withBrewPath, duoHome, HOME } from './paths.mjs';
import { DUO_MCP_RULE } from './config.mjs';
import { appendSystemPrompt } from './prompts.mjs';
import { hasTmux, SOCKET_NAME } from './tmux.mjs';

export const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DUO_CLI = path.join(PLUGIN_ROOT, 'bin', 'duo.mjs');
export const TMUX_CONF = path.join(PLUGIN_ROOT, 'tmux', 'claude-duo.tmux.conf');

// Names a running Claude injects into children; stripped inside tmux too
// (the tmux server keeps the env of whoever started it).
const STRIP = ['CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_PID',
  'CLAUDE_PLUGIN_ROOT', 'CLAUDE_PLUGIN_DATA', 'CLAUDE_PROJECT_DIR', 'CLAUDE_EFFORT'];

export function claudeBin() {
  const p = withBrewPath(`${HOME}/.local/bin:${process.env.PATH || ''}`);
  for (const dir of p.split(':')) {
    const f = path.join(dir, 'claude');
    try { fs.accessSync(f, fs.constants.X_OK); return f; } catch { /* next */ }
  }
  return 'claude';
}

/**
 * argv for `claude` (prompt FIRST, --allowedTools LAST: see SPEC §17.1-8).
 * spawned=true  → a session claude-duo opens to handle a message: uses
 *                 cfg.spawn (permission mode, allowed tools, model).
 * spawned=false → the user opened it (alias claude-a / claude-b, or `claude` itself): their own
 *                 permission settings apply; only the duo tools are allowed.
 */
export function claudeArgs(cfg, peer, { prompt, name, spawned = !!prompt, extra = [] } = {}) {
  const args = [];
  if (prompt) args.push(prompt);
  if (name && !extra.some((x) => x === '-n' || x === '--name' || x.startsWith('--name='))) args.push('-n', name);
  // User-supplied claude flags (e.g. `claude-b --resume`). They go before the
  // variadic --allowedTools so nothing can be swallowed by it.
  args.push(...extra);
  if (spawned) {
    args.push('--permission-mode', cfg.spawn.permission_mode);
    if (cfg.spawn.model) args.push('--model', cfg.spawn.model);
  }
  args.push('--append-system-prompt', appendSystemPrompt(cfg, peer));
  if (process.env.DUO_HOME) args.push('--settings', JSON.stringify({ env: { DUO_HOME: duoHome() } }));
  if (cfg.dev && cfg.dev.plugin_dir) args.push('--plugin-dir', normalizeDir(cfg.dev.plugin_dir));
  const tools = spawned ? [...cfg.spawn.allowed_tools, DUO_MCP_RULE] : [DUO_MCP_RULE];
  args.push('--allowedTools', tools.join(','));
  return args;
}

/** `env -u … [CLAUDE_CONFIG_DIR=…]` words selecting the peer config dir. */
export function envWords(cfg, peer) {
  const words = ['/usr/bin/env'];
  for (const n of STRIP) words.push('-u', n);
  const dir = cfg.peers[peer].config_dir;
  if (isDefaultConfigDir(dir)) words.push('-u', 'CLAUDE_CONFIG_DIR');
  else words.push(`CLAUDE_CONFIG_DIR=${normalizeDir(dir)}`);
  if (process.env.DUO_HOME) words.push(`DUO_HOME=${duoHome()}`);
  words.push('DUO_LAUNCHED=1'); // role comes from --append-system-prompt, not the SessionStart hook
  return words;
}

export function shellLine(words) {
  return words.map(shq).join(' ');
}

/** Shell line a fresh Terminal window runs to open `peer` (via `duo open`). */
export function openCommandLine(peer, { cwd, prompt, noTmux = false }) {
  const words = [process.execPath, DUO_CLI, 'open', peer, '--cwd', cwd];
  if (noTmux) words.push('--no-tmux');
  if (prompt) words.push('--prompt', prompt);
  const prefix = process.env.DUO_HOME ? `DUO_HOME=${shq(duoHome())} ` : '';
  return `cd ${shq(cwd)} && ${prefix}${shellLine(words)}`;
}

/**
 * Run the peer interactively in THIS terminal. Inside tmux unless disabled,
 * tmux is missing, or we are already inside a tmux pane.
 */
export function openHere(cfg, peer, { cwd, prompt, noTmux = false, sessionName, extra = [] }) {
  const dir = path.resolve(cwd || process.cwd());
  const name = sessionName || `duo-${peer}-${Date.now().toString(36).slice(-4)}`;
  const cmd = [...envWords(cfg, peer), claudeBin(), ...claudeArgs(cfg, peer, { prompt, name, extra })];
  const useTmux = !noTmux && cfg.new_tab.use_tmux !== false && hasTmux() && !process.env.TMUX;
  const env = { ...process.env, PATH: withBrewPath(process.env.PATH || '') };
  if (!env.LANG || !/UTF-8/i.test(env.LANG)) env.LANG = 'en_US.UTF-8';
  for (const n of STRIP) delete env[n];
  if (!useTmux) {
    const r = spawnSync(cmd[0], cmd.slice(1), { stdio: 'inherit', cwd: dir, env });
    return r.status ?? 1;
  }
  const tmuxPath = execFileSync('/bin/sh', ['-c', 'command -v tmux'], { encoding: 'utf8', env }).trim();
  const r = spawnSync(tmuxPath, ['-u', '-L', SOCKET_NAME, '-f', TMUX_CONF, 'new-session', '-s', name, '-c', dir, shellLine(cmd)], { stdio: 'inherit', cwd: dir, env });
  return r.status ?? 1;
}
