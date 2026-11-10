// AppleScript helpers: open a terminal window running a command, and notify.
import { execFile } from 'node:child_process';

/** Escape a JS string for an AppleScript string literal. */
export function asq(s) {
  return `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function osascript(script, timeoutMs = 15000) {
  if (process.env.DUO_DRY_RUN === '1') return Promise.resolve({ ok: false, error: 'dry_run' });
  return new Promise((resolve) => {
    execFile('osascript', ['-e', script], { timeout: timeoutMs, encoding: 'utf8' }, (err, stdout, stderr) => {
      const text = `${stdout || ''}${stderr || ''}`;
      if (!err) return resolve({ ok: true, out: (stdout || '').trim() });
      const denied = /-1743|not authori[sz]ed/i.test(text);
      resolve({ ok: false, error: denied ? 'automation_denied' : 'osascript_failed', raw: text.trim().slice(0, 500) });
    });
  });
}

/** Run a shell command line in a new Terminal window / iTerm2 tab. */
export function openTerminal(app, commandLine, { activate = true } = {}) {
  let script;
  if (app === 'iTerm2') {
    script = [
      'tell application "iTerm2"',
      '  if (count of windows) = 0 then',
      '    create window with default profile',
      '  else',
      '    tell current window to create tab with default profile',
      '  end if',
      `  tell current session of current window to write text ${asq(commandLine)}`,
      activate ? '  activate' : '',
      'end tell',
    ].join('\n');
  } else {
    script = [
      'tell application "Terminal"',
      `  do script ${asq(commandLine)}`,
      activate ? '  activate' : '',
      'end tell',
    ].join('\n');
  }
  return osascript(script);
}

export function notify(title, message) {
  const t = String(title).slice(0, 120);
  const m = String(message).slice(0, 240);
  return osascript(`display notification ${asq(m)} with title ${asq(t)}`, 5000);
}
