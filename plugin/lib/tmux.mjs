// tmux helpers + the SAFE 5-step injection protocol (SPEC §7.3).
// Typing into a pane that shows a permission dialog APPROVES it (verified),
// so every step below is mandatory.
import { execFileSync } from 'node:child_process';
import { sleepSync } from './fsutil.mjs';
import { withBrewPath } from './paths.mjs';

export const SOCKET_NAME = 'claude-duo';

function tmuxBin() {
  const p = withBrewPath(process.env.PATH || '');
  for (const dir of p.split(':')) {
    try { execFileSync('test', ['-x', `${dir}/tmux`]); return `${dir}/tmux`; } catch { /* next */ }
  }
  return null;
}

export function hasTmux() { return !!tmuxBin(); }

export function tmux(socket, args, { timeoutMs = 3000 } = {}) {
  const bin = tmuxBin();
  if (!bin) throw new Error('tmux not installed');
  const base = socket ? ['-S', socket] : [];
  return execFileSync(bin, [...base, ...args], {
    encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PATH: withBrewPath(process.env.PATH || '') },
  });
}

export function capture(socket, pane) {
  return tmux(socket, ['capture-pane', '-p', '-t', pane]);
}

export function paneExists(socket, pane) {
  try { tmux(socket, ['display-message', '-p', '-t', pane, '#{pane_id}']); return true; } catch { return false; }
}

const DIALOG_MARKERS = [/Do you want to/i, /Esc to cancel/i, /❯\s*\d+\.\s/, /Enter to confirm/i, /Press Enter to continue/i, /Tab to amend/i];
const RULE = /^\s*─{10,}/;

/**
 * An idle Claude Code screen ends with the input box:
 *     ──────────── <session name> ─      (top rule)
 *     ❯ <input text>
 *     ────────────────────────────       (bottom rule)
 *       ⏸ manual mode on · ? for shortcuts   (≤ 4 status lines)
 * When a dialog (permission prompt, menu) is open, that box is replaced by
 * the dialog, so the structure check fails. Dialog markers are only searched
 * inside the box + status area, never in the conversation above it (Claude's
 * own text may contain "Do you want to …").
 */
export function analyzeScreen(screen) {
  const lines = screen.split('\n');
  const rules = [];
  lines.forEach((l, i) => { if (RULE.test(l)) rules.push(i); });
  if (rules.length < 2) return { ok: false, reason: 'no_prompt' };
  const bottom = rules[rules.length - 1];
  const top = rules[rules.length - 2];
  const tail = lines.slice(bottom + 1).filter((l) => l.trim());
  if (tail.length > 4) return { ok: false, reason: 'no_prompt' };
  const box = lines.slice(top + 1, bottom);
  if (!box.length || !/^\s*❯/.test(box[0])) return { ok: false, reason: 'no_prompt' };
  const area = lines.slice(top + 1).join('\n');
  if (DIALOG_MARKERS.some((re) => re.test(area))) return { ok: false, reason: 'dialog_open' };
  const inputText = [box[0].replace(/^\s*❯\s?/, ''), ...box.slice(1).map((l) => l.trim())].join(' ').replace(/\s+$/, '').trim();
  return { ok: true, inputText };
}

/** Placeholder hints like `Try "fix lint errors"` render inside an empty box. */
function looksEmpty(inputText) {
  return inputText === '' || /^Try ".*"$/.test(inputText);
}

/**
 * The 5-step protocol. Returns { ok, reason }. On any doubt it does NOT send.
 *   isIdle(): re-check hook state (step 1) just before typing.
 */
export function safeInject({ socket, pane, text, isIdle }) {
  if (!/^[^\n\r]+$/.test(text)) return { ok: false, reason: 'text_must_be_single_line' };
  if (!paneExists(socket, pane)) return { ok: false, reason: 'pane_gone' };
  // 1. hook state
  if (!isIdle()) return { ok: false, reason: 'not_idle' };
  // 2. screen check
  let a = analyzeScreen(capture(socket, pane));
  if (!a.ok) return { ok: false, reason: a.reason };
  if (!looksEmpty(a.inputText)) return { ok: false, reason: 'input_not_empty' };
  if (!isIdle()) return { ok: false, reason: 'not_idle' };
  // 3. type literally, no Enter, then verify it landed in the input box
  tmux(socket, ['send-keys', '-t', pane, '-l', text]);
  let landed = false;
  const probe = text.slice(0, 40);
  for (let i = 0; i < 20 && !landed; i++) {
    sleepSync(100);
    const now = analyzeScreen(capture(socket, pane));
    if (!now.ok) break;
    // Compare without whitespace: long input wraps inside the box.
    landed = now.inputText.replace(/\s+/g, '').includes(probe.replace(/\s+/g, ''));
  }
  if (!landed) {
    // Never press Enter on a screen we do not understand. Clear what we typed
    // with Ctrl-U (kill line) — not Escape, which could close a menu.
    try { tmux(socket, ['send-keys', '-t', pane, 'C-u']); } catch { /* ignore */ }
    return { ok: false, reason: 'text_not_visible' };
  }
  a = analyzeScreen(capture(socket, pane));
  if (!a.ok) { try { tmux(socket, ['send-keys', '-t', pane, 'C-u']); } catch { /* */ } return { ok: false, reason: a.reason }; }
  // 4. Enter
  tmux(socket, ['send-keys', '-t', pane, 'Enter']);
  // 5. confirmation (UserPromptSubmit hook) is checked by the caller.
  return { ok: true };
}
