// Thin wrappers around the `claude` CLI, always run with a clean env for the
// target peer's config dir (paths.envForConfigDir).
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { envForConfigDir, normalizeDir, isDefaultConfigDir, HOME } from './paths.mjs';

export const MIN_VERSION = '2.1.322';

export function run(cmd, args, { env, cwd, timeoutMs = 60000, input } = {}) {
  return new Promise((resolve) => {
    const child = execFile(cmd, args, { env, cwd, timeout: timeoutMs, maxBuffer: 20 * 1024 * 1024, encoding: 'utf8' }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: stdout || '', stderr: stderr || '', error: err && typeof err.code !== 'number' ? String(err.code || err.message) : null });
    });
    if (input !== undefined) { child.stdin.end(input); }
  });
}

export function runClaude(configDir, args, opts = {}) {
  return run('claude', args, { ...opts, env: envForConfigDir(configDir) });
}

export async function version() {
  const r = await run('claude', ['--version'], { timeoutMs: 15000 });
  const m = r.stdout.match(/(\d+\.\d+\.\d+)/);
  return m ? m[1] : null;
}

export function cmpVersion(a, b) {
  const pa = a.split('.').map(Number); const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
}

/** Config dir existence: `claude auth status` would CREATE a missing dir. */
export function configDirExists(configDir) {
  if (isDefaultConfigDir(configDir)) return fs.existsSync(`${HOME}/.claude.json`);
  return fs.existsSync(normalizeDir(configDir));
}

export async function authStatus(configDir) {
  if (!configDirExists(configDir)) return { loggedIn: false, missing: true };
  const r = await runClaude(configDir, ['auth', 'status', '--json'], { timeoutMs: 20000 });
  try { return JSON.parse(r.stdout); } catch { return { loggedIn: false, error: (r.stderr || r.stdout).trim().slice(0, 300) }; }
}

/** Active (+ completed with all=true) sessions of a config dir. */
export async function agents(configDir, { all = true } = {}) {
  const args = ['agents', '--json'];
  if (all) args.push('--all');
  const r = await runClaude(configDir, args, { timeoutMs: 20000 });
  try { const v = JSON.parse(r.stdout); return Array.isArray(v) ? v : []; } catch { return []; }
}

export async function stopBg(configDir, id) {
  return runClaude(configDir, ['stop', id], { timeoutMs: 30000 });
}

export function classifyFailure(text) {
  const t = String(text);
  if (/Workspace not trusted/i.test(t)) return 'workspace_not_trusted';
  if (/not logged in|run .*login|authenticate/i.test(t)) return 'auth_required';
  if (/usage limit|rate limit|limit reached/i.test(t)) return 'rate_limited';
  return 'launch_failed';
}

/**
 * Start a background session. IMPORTANT (SPEC §17.1-8): the prompt goes right
 * after --bg, and --allowedTools (variadic) goes LAST with a single
 * comma-joined value, otherwise it swallows the prompt.
 */
export async function launchBg(configDir, o) {
  const args = ['--bg', o.prompt];
  if (o.name) args.push('-n', o.name);
  if (o.permissionMode) args.push('--permission-mode', o.permissionMode);
  if (o.model) args.push('--model', o.model);
  if (o.appendSystemPrompt) args.push('--append-system-prompt', o.appendSystemPrompt);
  if (o.settings) args.push('--settings', JSON.stringify(o.settings));
  if (o.pluginDir) args.push('--plugin-dir', o.pluginDir);
  if (o.allowedTools && o.allowedTools.length) args.push('--allowedTools', o.allowedTools.join(','));
  const r = await runClaude(configDir, args, { cwd: o.cwd, timeoutMs: 90000 });
  return parseBgOutput(r);
}

/** Continue an existing background session (keeps id + context; NO extra flags). */
export async function resumeBg(configDir, sessionId, prompt, cwd) {
  const r = await runClaude(configDir, ['--bg', '--resume', sessionId, prompt], { cwd, timeoutMs: 90000 });
  return parseBgOutput(r);
}

export function parseBgOutput(r) {
  const text = `${r.stdout}\n${r.stderr}`;
  const copy = text.match(/started a copy as ([0-9a-f]{8})/);
  const m = text.match(/backgrounded\s+·\s+([0-9a-f]{8})/);
  if (r.code === 0 && m) return { ok: true, id: copy ? copy[1] : m[1], copied: !!copy, raw: text.trim() };
  return { ok: false, error: classifyFailure(text), raw: text.trim().slice(0, 1000) };
}
