// Delivery of messages to the receiving peer. SPEC §7.
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { directionKey, label, launchCmd, DUO_MCP_RULE } from './config.mjs';
import { getMessage, updateMessage, addDeliveryLog, TERMINAL, listMessages } from './mailbox.mjs';
import { listSessions, getSession, getBg, setBg } from './registry.mjs';
import { safeInject, paneExists, hasTmux } from './tmux.mjs';
import { openTerminal, notify } from './macos.mjs';
import { agents, launchBg, resumeBg, stopBg, authStatus } from './claude.mjs';
import { isTrusted, HOME, normalizeDir } from './paths.mjs';
import { bootstrap, appendSystemPrompt } from './prompts.mjs';
import { openCommandLine, DUO_CLI } from './open.mjs';
import { log, sleepSync, readJSON, writeJSONAtomic } from './fsutil.mjs';
import { paths } from './paths.mjs';
import path from 'node:path';

const NOTE_TYPES = ['result', 'info', 'cancel'];

/** Notes wake an existing session; they never spawn one. */
export function isNoteLike(msg) {
  return NOTE_TYPES.includes(msg.type) || (msg.type === 'question' && !!msg.reply_to);
}

function cwdFor(msg) {
  try { if (msg.cwd && fs.statSync(msg.cwd).isDirectory()) return path.resolve(msg.cwd); } catch { /* */ }
  return HOME;
}

function record(id, entry, patch = {}) {
  try {
    return updateMessage(id, (m) => {
      addDeliveryLog(m, entry);
      if (patch.status && m.status === 'queued') m.status = patch.status;
      Object.assign(m.meta, patch.meta || {});
      if (patch.error !== undefined) m.meta.error = patch.error;
    });
  } catch (e) { log('record-failed', id, e.message); return null; }
}

/** Wait for the UserPromptSubmit hook to mark the message picked up. */
function waitPickedUp(id, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const m = getMessage(id);
    if (m && m.meta && m.meta.picked_up_by) return m.meta.picked_up_by;
    sleepSync(150);
  }
  return null;
}

/**
 * Live tmux sessions of `peer`, best first. If `prefer` (the session that
 * sent the original request) is still alive, ONLY that session qualifies —
 * a result must reach the conversation that asked for it. If it is alive but
 * not in tmux, the list is empty and `preferAlive` tells the caller to wait
 * for that session's own hooks instead.
 */
function liveCandidates(peer, { cwd, prefer } = {}) {
  const all = listSessions(peer);
  if (prefer) {
    const p = all.find((s) => s.session_id === prefer);
    if (p) return { list: p.tmux && p.tmux.pane && p.tmux.socket ? [p] : [], preferAlive: true };
  }
  const sess = all.filter((s) => s.tmux && s.tmux.pane && s.tmux.socket);
  sess.sort((a, b) => ((cwd && b.cwd === cwd ? 1 : 0) - (cwd && a.cwd === cwd ? 1 : 0)));
  return { list: sess, preferAlive: false };
}

function injectInto(peer, s, text) {
  const r = safeInject({
    socket: s.tmux.socket,
    pane: s.tmux.pane,
    text,
    isIdle: () => { const cur = getSession(peer, s.session_id); return !!cur && cur.state === 'idle'; },
  });
  return r;
}

async function tryLive(cfg, msg, { queueIfBusy }) {
  const { list: cands, preferAlive } = liveCandidates(msg.to, { cwd: msg.cwd ? path.resolve(msg.cwd) : null, prefer: msg.meta.wake_session });
  if (!cands.length) {
    if (preferAlive && queueIfBusy) return { ok: false, queued: true, error: 'origin_session_not_in_tmux' };
    return { ok: false, error: hasTmux() ? 'no_live_session' : 'tmux_missing' };
  }
  const text = bootstrap(cfg, msg);
  let busy = false;
  for (const s of cands) {
    if (!paneExists(s.tmux.socket, s.tmux.pane)) continue;
    if (s.state !== 'idle') { busy = true; continue; }
    const r = injectInto(msg.to, s, text);
    if (r.ok) {
      const picked = waitPickedUp(msg.id, 6000);
      return { ok: true, via: 'live-session', session: s.session_id, confirmed: !!picked };
    }
    if (['not_idle', 'dialog_open', 'input_not_empty', 'no_prompt'].includes(r.reason)) { busy = true; continue; }
    log('inject-failed', msg.id, s.session_id, r.reason);
  }
  if (busy && queueIfBusy) return { ok: false, queued: true, error: 'peer_busy' };
  return { ok: false, error: busy ? 'peer_busy' : 'no_idle_live_session' };
}

async function tryNewTab(cfg, msg) {
  if (cfg.new_tab.reuse_live) {
    const live = await tryLive(cfg, msg, { queueIfBusy: false });
    if (live.ok) return live;
  }
  const cwd = cwdFor(msg);
  const line = openCommandLine(msg.to, { cwd, prompt: bootstrap(cfg, msg), noTmux: cfg.new_tab.use_tmux === false });
  const r = await openTerminal(cfg.terminal_app, line, { activate: cfg.new_tab.activate !== false });
  if (!r.ok) return { ok: false, error: r.error, raw: r.raw };
  return { ok: true, via: 'new-tab' };
}

/**
 * Is the peer's account logged in? A positive answer is cached for 10 minutes
 * (it costs a `claude auth status` call). Checked BEFORE the trust check:
 * a never-used account also reports "Workspace not trusted", which would send
 * the user to fix the wrong thing.
 */
async function peerLoggedIn(cfg, peer) {
  const f = path.join(paths.state(), `auth-${peer}.json`);
  const cached = readJSON(f, null);
  const dir = normalizeDir(cfg.peers[peer].config_dir);
  if (cached && cached.ok && cached.dir === dir && Date.now() - cached.at < 10 * 60 * 1000) return true;
  const st = await authStatus(cfg.peers[peer].config_dir);
  if (st && st.loggedIn) { try { writeJSONAtomic(f, { ok: true, dir, at: Date.now() }); } catch { /* */ } return true; }
  return false;
}

export function loginHint(cfg, peer) {
  return `Account ${label(cfg, peer)} is not logged in on this Mac. Ask the user to open a new terminal, run: ${launchCmd(cfg, peer)} — then type /login, sign in with that account, and type /exit. The message stays queued and is delivered automatically once that account starts a session.`;
}

async function tryBackground(cfg, msg) {
  const peer = msg.to;
  const configDir = cfg.peers[peer].config_dir;
  const cwd = cwdFor(msg);
  if (!(await peerLoggedIn(cfg, peer))) return { ok: false, error: 'auth_required', hint: loginHint(cfg, peer) };
  const trusted = isTrusted(configDir, cwd);
  if (trusted === false) return { ok: false, error: 'workspace_not_trusted', hint: `Account ${label(cfg, peer)} has not trusted the folder ${cwd} yet. Ask the user to run, once, in a terminal: cd ${cwd} && ${launchCmd(cfg, peer)} — choose "Yes" when asked to trust the folder, then /exit. After that, resend.` };
  const prompt = bootstrap(cfg, msg);
  const bg = cfg.background.keep_context ? getBg(peer) : null;
  if (bg && bg.cwd === cwd && bg.session_id) {
    const list = await agents(configDir);
    const entry = list.find((a) => a.id === bg.id || a.sessionId === bg.session_id);
    if (entry && entry.pid && (entry.status === 'busy' || ['working', 'running'].includes(entry.state))) {
      return { ok: false, queued: true, error: 'worker_busy' };
    }
    if (entry && entry.pid && entry.state === 'blocked') {
      return { ok: false, queued: true, error: 'worker_waiting_permission', hint: `The background session of ${label(cfg, peer)} is waiting for a permission approval. Ask the user to run \`duo attach ${peer}\` to approve it.` };
    }
    if (entry && entry.pid) await stopBg(configDir, entry.id);
    const r = await resumeBg(configDir, bg.session_id, prompt, cwd);
    if (r.ok) {
      setBg(peer, { id: r.id, session_id: r.copied ? null : bg.session_id, cwd });
      if (r.copied) await refreshBgSession(cfg, peer, r.id, cwd);
      return { ok: true, via: 'background', bg_id: r.id, resumed: true };
    }
    log('resume-failed', msg.id, r.error, r.raw);
    if (r.error !== 'launch_failed') return { ok: false, error: r.error, raw: r.raw };
  }
  const r = await launchBg(configDir, {
    prompt,
    cwd,
    name: `duo-${peer}`,
    permissionMode: cfg.spawn.permission_mode,
    model: cfg.spawn.model,
    appendSystemPrompt: appendSystemPrompt(cfg, peer),
    settings: process.env.DUO_HOME ? { env: { DUO_HOME: paths.root() } } : null,
    pluginDir: cfg.dev && cfg.dev.plugin_dir ? normalizeDir(cfg.dev.plugin_dir) : null,
    allowedTools: [...cfg.spawn.allowed_tools, DUO_MCP_RULE],
  });
  if (!r.ok) {
    const hint = r.error === 'auth_required' ? loginHint(cfg, peer)
      : r.error === 'workspace_not_trusted' ? `Account ${label(cfg, peer)} has not trusted the folder ${cwd} yet. Ask the user to run, once, in a terminal: cd ${cwd} && ${launchCmd(cfg, peer)} — choose "Yes" when asked to trust the folder, then /exit.`
        : undefined;
    return { ok: false, error: r.error, raw: r.raw, hint };
  }
  await refreshBgSession(cfg, peer, r.id, cwd);
  return { ok: true, via: 'background', bg_id: r.id };
}

async function refreshBgSession(cfg, peer, id, cwd) {
  const list = await agents(cfg.peers[peer].config_dir);
  const entry = list.find((a) => a.id === id);
  setBg(peer, { id, session_id: entry ? entry.sessionId : null, cwd });
}

const TRY = { 'live-session': (c, m) => tryLive(c, m, { queueIfBusy: true }), 'new-tab': tryNewTab, background: tryBackground };

/** Deliver a work message (task / new question). */
async function deliverWork(cfg, msg) {
  let mode = msg.delivery || cfg.delivery[directionKey(msg.from, msg.to)];
  // A background session has nobody to ask, so "ask before accepting" needs a visible window.
  if (mode === 'background' && cfg.approval.before_accept === 'ask') mode = 'new-tab';
  const fb = cfg.delivery.fallback;
  const chain = fb && fb !== 'none' && fb !== mode ? [mode, fb] : [mode];
  let last = null;
  for (const m of chain) {
    let r;
    try { r = await TRY[m](cfg, msg); } catch (e) { r = { ok: false, error: 'exception', raw: String(e && e.stack || e).slice(0, 500) }; }
    record(msg.id, { mode: m, ok: !!r.ok, queued: !!r.queued, error: r.error || null, via: r.via || null });
    if (r.ok) {
      record(msg.id, { event: 'delivered' }, { status: 'delivered', error: null, meta: { delivered_via: r.via, bg_id: r.bg_id || msg.meta.bg_id || null, live_session: r.session || null, hard_failure: false } });
      return r;
    }
    if (r.queued) {
      record(msg.id, { event: 'queued' }, { error: r.error, meta: { queued_reason: r.error, queued_mode: m, hard_failure: false } });
      if (r.hint && cfg.notify && msg.meta.queued_reason !== r.error) notify('claude-duo', r.hint);
      return r;
    }
    last = r;
  }
  // Hard failure (not logged in, folder not trusted, launch failed…): the
  // message stays queued; kick() retries it rarely, or as soon as the target
  // peer starts a session. Notify only the first time.
  const err = last ? last.error : 'unknown';
  record(msg.id, { event: 'failed' }, { error: err, meta: { queued_reason: err, queued_mode: null, hard_failure: true, failure_notified: true, last_hint: last && last.hint ? last.hint : null } });
  if (cfg.notify && !msg.meta.failure_notified) {
    const short = err === 'auth_required' ? `${label(cfg, msg.to)} is not logged in. Run ${launchCmd(cfg, msg.to)} then /login.`
      : err === 'workspace_not_trusted' ? `${label(cfg, msg.to)} has not trusted ${cwdFor(msg)}. Run ${launchCmd(cfg, msg.to)} there once.`
        : `${msg.id}: ${err}`;
    notify('claude-duo: not delivered yet', short);
  }
  return last || { ok: false, error: 'unknown' };
}

/** Wake the receiver for a note (result / info / needs_info question). */
async function deliverNote(cfg, msg) {
  const peer = msg.to;
  if (cfg.notify) notify(`claude-duo → ${label(cfg, peer)}`, `${msg.type === 'result' ? 'Result' : msg.type === 'question' ? 'Question' : 'Notice'} from ${label(cfg, msg.from)}: ${msg.title}`);
  if (!cfg.wake_on_result) return { ok: true, via: 'mailbox' };
  // 1) the session that sent the original request, if it is a live tmux session
  const live = await tryLive(cfg, msg, { queueIfBusy: true });
  if (live.ok) { record(msg.id, { event: 'woken', via: 'live-session' }, { meta: { live_session: live.session } }); return live; }
  if (live.queued) { record(msg.id, { event: 'wait_for_stop_hook' }); return live; }
  // 2) the background worker that sent the original request
  const bg = getBg(peer);
  if (bg && bg.session_id && msg.meta.wake_session === bg.session_id) {
    const r = await tryBackground(cfg, msg);
    record(msg.id, { event: 'woken', via: 'background', ok: !!r.ok, error: r.error || null });
    return r;
  }
  record(msg.id, { event: 'stored' });
  return { ok: true, via: 'mailbox' };
}

export const DRY_RUN = () => process.env.DUO_DRY_RUN === '1';

export async function deliver(cfg, id) {
  if (DRY_RUN()) return { ok: false, error: 'dry_run' };
  const msg = getMessage(id);
  if (!msg) return { ok: false, error: 'not_found' };
  if (TERMINAL.includes(msg.status)) return { ok: false, error: 'terminal' };
  if (isNoteLike(msg)) return deliverNote(cfg, msg);
  if (msg.status !== 'queued') return { ok: true, already: msg.status };
  return deliverWork(cfg, msg);
}

/**
 * Fire-and-forget retry of queued messages (used by hooks, which must stay
 * fast). Throttled via state/kick.json.
 */
/**
 * Fire-and-forget retry of queued messages (used by hooks, which must stay
 * fast). Throttled via state/kick*.json. With `peer`, that peer just started a
 * session: its messages are retried right away, even after a hard failure.
 */
export function kickDetached(minIntervalMs = 20000, peer = null) {
  if (process.env.DUO_DRY_RUN === '1') return false;
  try {
    const f = path.join(paths.state(), peer ? `kick-${peer}.json` : 'kick.json');
    const last = readJSON(f, { at: 0 }).at || 0;
    if (Date.now() - last < (peer ? 5000 : minIntervalMs)) return false;
    writeJSONAtomic(f, { at: Date.now() });
    const child = spawn(process.execPath, [DUO_CLI, 'kick', ...(peer ? ['--peer', peer] : [])], { detached: true, stdio: 'ignore', env: process.env });
    child.unref();
    return true;
  } catch (e) { log('kick-failed', e.message); return false; }
}

const HARD_RETRY_MS = 10 * 60 * 1000;

/**
 * Retry delivery of queued work messages. Transient reasons (peer busy…) are
 * retried after minAgeMs; hard failures (not logged in, not trusted…) only
 * every 10 minutes — unless `peer` is the target (it just started a session).
 */
export async function kick(cfg, { minAgeMs = 15000, peer = null } = {}) {
  const out = [];
  for (const m of listMessages({ boxes: ['new'], statuses: ['queued'] })) {
    if (isNoteLike(m)) continue;
    const claimed = m.meta.claimed_by;
    if (claimed && listSessions(m.to).some((s) => s.session_id === claimed)) continue; // a live session took it
    const lastAt = (m.meta.delivery_log || []).map((e) => Date.parse(e.at)).filter(Boolean).pop() || 0;
    const wait = peer && m.to === peer ? 0 : m.meta.hard_failure ? HARD_RETRY_MS : minAgeMs;
    if (Date.now() - lastAt < wait) continue;
    out.push({ id: m.id, r: await deliver(cfg, m.id) });
  }
  return out;
}
