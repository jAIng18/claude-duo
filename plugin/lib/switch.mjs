// Account switching: which account a plain `claude` typed in a terminal opens.
//
// Nothing about the logins changes. Each account keeps its own config dir and
// Keychain item, and no token is copied, swapped or refreshed (refreshing
// rotates the token and logs a running Claude Code out). "Switching" only moves
// a pointer, ~/.claude-duo/state/switch.json. The `claude` shell function that
// install.sh puts in ~/.zshrc asks `duo switch --resolve` on every launch and
// sets CLAUDE_CONFIG_DIR from it, so the change applies to the next `claude` in
// any terminal. Sessions already open stay on their account.
//
// mode "manual": the pointer only moves when the user picks an account.
// mode "auto":   when the current account's quota (the higher of 5h and week)
//                reaches `threshold` %, it moves to the other account, provided
//                that one is logged in and below the threshold.
import fs from 'node:fs';
import path from 'node:path';
import { paths, normalizeDir, isDefaultConfigDir } from './paths.mjs';
import { PEERS, other, DuoError } from './config.mjs';
import { readJSON, writeJSONAtomic } from './fsutil.mjs';

export const SWITCH_MODES = ['manual', 'auto'];
export const DEFAULT_THRESHOLD = 90;
const QUOTA_MAX_AGE_MS = 5 * 60 * 1000; // older cached quota is re-fetched at launch in auto mode

const file = () => path.join(paths.state(), 'switch.json');
const quotaCache = (peer) => path.join(paths.state(), `quota-${peer}.json`);

/** The peer a plain `claude` opened before switching existed. */
export function defaultPeer(cfg) {
  return PEERS.find((p) => isDefaultConfigDir(cfg.peers[p].config_dir)) || 'A';
}

export function readSwitch(cfg) {
  let raw = {};
  try { raw = readJSON(file(), {}) || {}; } catch { raw = {}; }
  const t = Number(raw.threshold);
  return {
    active: PEERS.includes(raw.active) ? raw.active : defaultPeer(cfg),
    mode: SWITCH_MODES.includes(raw.mode) ? raw.mode : 'manual',
    threshold: Number.isInteger(t) && t >= 50 && t <= 100 ? t : DEFAULT_THRESHOLD,
    changed_at: raw.changed_at || null,
    reason: raw.reason || null,
  };
}

function save(state) {
  writeJSONAtomic(file(), state);
  return state;
}

/** Manual pick. Picking an account turns auto off: otherwise auto could move straight back. */
export function useAccount(cfg, peer) {
  if (!PEERS.includes(peer)) throw new DuoError('bad_args', 'account phải là A hoặc B');
  const cur = readSwitch(cfg);
  return save({ ...cur, active: peer, mode: 'manual', changed_at: new Date().toISOString(), reason: 'manual' });
}

export function setMode(cfg, mode, threshold) {
  if (!SWITCH_MODES.includes(mode)) throw new DuoError('bad_args', `mode phải là: ${SWITCH_MODES.join(' | ')}`);
  const cur = readSwitch(cfg);
  const next = { ...cur, mode };
  if (threshold !== undefined && threshold !== null) {
    const t = Number(threshold);
    if (!Number.isInteger(t) || t < 50 || t > 100) throw new DuoError('bad_args', 'ngưỡng phải là số nguyên từ 50 đến 100');
    next.threshold = t;
  }
  return save(next);
}

// ------------------------------------------------------------------ auto rule

/** A bar whose reset time has passed counts as 0 %: the numbers are from before the reset. */
function barPct(b, now) {
  if (!b || !Number.isFinite(Number(b.pct))) return null;
  const r = Date.parse(b.resets_at || '');
  if (Number.isFinite(r) && r <= now) return 0;
  return Number(b.pct);
}

/**
 * How used an account is, 0-100, or null when unknown. Stale numbers (shown
 * next to an error such as an expired token) still count: the token only
 * expires because nobody opened that account lately, Claude Code refreshes it
 * on launch. A logged-out account is never usable.
 */
export function usedPct(q, now = Date.now()) {
  if (!q || q.error === 'not_logged_in') return null;
  const vals = [barPct(q.session, now), barPct(q.weekly, now)].filter((v) => v !== null);
  return vals.length ? Math.max(...vals) : null;
}

/**
 * Pure decision. quotas: { A: quota|null, B: quota|null }.
 * Returns { switch: bool, to, reason }.
 */
export function decide(state, quotas, now = Date.now()) {
  const cur = state.active;
  const alt = other(cur);
  const curUsed = usedPct(quotas[cur], now);
  if (state.mode !== 'auto') return { switch: false, reason: 'manual' };
  if (curUsed === null || curUsed < state.threshold) return { switch: false, reason: 'ok' };
  const altUsed = usedPct(quotas[alt], now);
  if (altUsed === null) return { switch: false, reason: 'other_unknown' };
  if (altUsed >= state.threshold) return { switch: false, reason: 'both_full' };
  return { switch: true, to: alt, reason: `auto: ${cur} ${Math.round(curUsed)}% ≥ ${state.threshold}%, ${alt} ${Math.round(altUsed)}%` };
}

/** Apply the auto rule; returns the (possibly new) state and whether it moved. */
export function applyAuto(cfg, quotas, now = Date.now()) {
  const state = readSwitch(cfg);
  const d = decide(state, quotas, now);
  if (!d.switch) return { state, switched: false, why: d.reason };
  const next = save({ ...state, active: d.to, changed_at: new Date(now).toISOString(), reason: d.reason });
  return { state: next, switched: true, from: state.active, why: d.reason };
}

// ------------------------------------------------------- launch-time resolve

function cachedQuota(peer) {
  try {
    const q = readJSON(quotaCache(peer), null);
    if (!q) return null;
    const age = Date.now() - Date.parse(q.fetched_at || '');
    return { q, fresh: Number.isFinite(age) && age < QUOTA_MAX_AGE_MS };
  } catch { return null; }
}

/**
 * Config dir a plain `claude` should use, as printed for the shell function:
 * '' means "leave CLAUDE_CONFIG_DIR unset" (the default ~/.claude account).
 * In auto mode it re-checks quota first (cache, or a quick fetch when the
 * cache is old). It never throws: any problem falls back to the saved choice.
 */
export async function resolveDir(cfg, { quotaFor = null, timeoutMs = 3000 } = {}) {
  let state = readSwitch(cfg);
  if (state.mode === 'auto') {
    try {
      const quotas = {};
      await Promise.all(PEERS.map(async (p) => {
        const c = cachedQuota(p);
        if (c && c.fresh) { quotas[p] = c.q; return; }
        if (quotaFor) {
          // unref: a pending timer must not keep the launch waiting after the answer came.
          const q = await Promise.race([quotaFor(cfg.peers[p].config_dir), new Promise((r) => setTimeout(() => r(null), timeoutMs).unref())]);
          if (q && q.ok) { quotas[p] = q; try { writeJSONAtomic(quotaCache(p), q); } catch { /* optional */ } return; }
        }
        quotas[p] = c ? c.q : null;
      }));
      state = applyAuto(cfg, quotas).state;
    } catch { /* keep the saved choice */ }
  }
  const dir = cfg.peers[state.active].config_dir;
  return isDefaultConfigDir(dir) ? '' : normalizeDir(dir);
}

export function switchExists() {
  return fs.existsSync(file());
}
