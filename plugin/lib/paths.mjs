// Path + environment helpers. See docs/SPEC.md §4.3 for the config-dir rules
// (they were verified the hard way: a wrong form logs the peer out).
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

export const HOME = os.homedir();
export const DEFAULT_CONFIG_DIR = path.join(HOME, '.claude');

export function expandHome(p) {
  if (typeof p !== 'string' || p === '') throw new Error('empty path');
  if (p === '~') return HOME;
  if (p.startsWith('~/')) return path.join(HOME, p.slice(2));
  return p;
}

/** Absolute, normalised, no trailing slash. Never resolves symlinks (the
 *  keychain hash is computed from the literal string the user logged in with). */
export function normalizeDir(p) {
  return path.resolve(expandHome(p));
}

export function isDefaultConfigDir(p) {
  return normalizeDir(p) === DEFAULT_CONFIG_DIR;
}

export function duoHome() {
  return process.env.DUO_HOME ? normalizeDir(process.env.DUO_HOME) : path.join(HOME, '.claude-duo');
}

export const paths = {
  root: () => duoHome(),
  config: () => path.join(duoHome(), 'config.json'),
  mail: (peer, box) => path.join(duoHome(), 'mail', peer, box),
  registry: (peer) => path.join(duoHome(), 'registry', peer),
  attachments: (id) => path.join(duoHome(), 'attachments', id),
  logs: () => path.join(duoHome(), 'logs'),
  locks: () => path.join(duoHome(), 'locks'),
  state: () => path.join(duoHome(), 'state'),
};

/** The config dir of the Claude process we are running inside. */
export function currentConfigDir(env = process.env) {
  return env.CLAUDE_CONFIG_DIR ? normalizeDir(env.CLAUDE_CONFIG_DIR) : DEFAULT_CONFIG_DIR;
}

// Variables a running Claude session injects into its children (hooks, MCP
// servers, Bash). They must not leak into a session we spawn for the peer.
const LEAKED = [/^CLAUDECODE$/, /^CLAUDE_CODE_/, /^CLAUDE_PID$/, /^CLAUDE_PLUGIN_/, /^CLAUDE_PROJECT_DIR$/,
  /^CLAUDE_EFFORT$/, /^CLAUDE_CONFIG_DIR$/, /^TMUX$/, /^TMUX_PANE$/];

/** Clean environment for launching `claude` as the given peer config dir. */
export function envForConfigDir(configDir, base = process.env) {
  const env = {};
  for (const [k, v] of Object.entries(base)) {
    if (LEAKED.some((re) => re.test(k))) continue;
    env[k] = v;
  }
  if (!isDefaultConfigDir(configDir)) env.CLAUDE_CONFIG_DIR = normalizeDir(configDir);
  if (process.env.DUO_HOME) env.DUO_HOME = duoHome();
  env.DUO_LAUNCHED = '1'; // sessions started by claude-duo get the role via --append-system-prompt
  env.PATH = withBrewPath(env.PATH || '');
  return env;
}

/** Shell prefix (for a fresh Terminal shell) that selects the peer config dir. */
export function shellEnvPrefix(configDir) {
  const parts = [];
  if (isDefaultConfigDir(configDir)) parts.push('env -u CLAUDE_CONFIG_DIR');
  else parts.push(`CLAUDE_CONFIG_DIR=${shq(normalizeDir(configDir))}`);
  if (process.env.DUO_HOME) parts.push(`DUO_HOME=${shq(duoHome())}`);
  return parts.join(' ');
}

export function withBrewPath(p) {
  const extra = ['/opt/homebrew/bin', '/usr/local/bin'];
  const have = p.split(':').filter(Boolean);
  for (const e of extra) if (!have.includes(e) && fs.existsSync(e)) have.push(e);
  return have.join(':');
}

/** POSIX single-quote a string for sh/zsh. */
export function shq(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/** Is `dir` (or an ancestor) trusted in the given config dir? null = unknown. */
export function isTrusted(configDir, dir) {
  const file = isDefaultConfigDir(configDir) ? path.join(HOME, '.claude.json') : path.join(normalizeDir(configDir), '.claude.json');
  let data;
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
  const projects = data && data.projects;
  if (!projects || typeof projects !== 'object') return false;
  let cur = path.resolve(dir);
  for (;;) {
    if (projects[cur] && projects[cur].hasTrustDialogAccepted === true) return true;
    const parent = path.dirname(cur);
    if (parent === cur) return false;
    cur = parent;
  }
}
