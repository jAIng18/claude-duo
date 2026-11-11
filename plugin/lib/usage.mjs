// Token usage and cost of one claude-duo task, read from the receiving
// session's Claude Code transcript (<config_dir>/projects/*/<session>.jsonl).
//
// The transcript format is Claude Code's own and undocumented, so everything
// here is best effort: anything missing or unreadable gives `null`, never an
// error. Numbers are an estimate:
//   - window = from the first transcript line that mentions the task id (the
//     bootstrap prompt or the Stop-hook pickup) until the first new prompt after
//     the task was replied to (or the end of the file);
//   - tokens = sum of the usage of every distinct assistant message in that
//     window, plus subagent transcripts of the same session in that window;
//   - cost  = growth of Claude Code's own cumulative `cost-state.totalCostUSD`
//     over the window (API-price estimate, not what a Pro/Max plan is billed).
// In an interactive session where the user keeps chatting while the task runs,
// that chatter is counted too.
import fs from 'node:fs';
import path from 'node:path';
import { normalizeDir } from './paths.mjs';

const fileCache = new Map();

function readLines(file) {
  if (fileCache.has(file)) return fileCache.get(file);
  let out = null;
  try {
    out = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((raw) => {
      try { return { raw, e: JSON.parse(raw) }; } catch { return null; }
    }).filter(Boolean);
  } catch { out = null; }
  fileCache.set(file, out);
  return out;
}

export function clearUsageCache() { fileCache.clear(); }

/** Main transcript + subagent transcripts of a session, or null. */
export function transcriptFiles(configDir, sessionId) {
  if (!configDir || !/^[0-9a-f-]{8,64}$/i.test(String(sessionId || ''))) return null;
  const root = path.join(normalizeDir(configDir), 'projects');
  let projects = [];
  try { projects = fs.readdirSync(root); } catch { return null; }
  for (const p of projects) {
    const main = path.join(root, p, `${sessionId}.jsonl`);
    if (!fs.existsSync(main)) continue;
    const subs = [];
    const walk = (dir, depth) => {
      if (depth > 3) return;
      let names = [];
      try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const d of names) {
        const f = path.join(dir, d.name);
        if (d.isDirectory()) walk(f, depth + 1);
        else if (d.name.endsWith('.jsonl')) subs.push(f);
      }
    };
    walk(path.join(root, p, sessionId), 0);
    return { main, subs };
  }
  return null;
}

function ts(e) {
  const t = Date.parse(e && e.timestamp);
  return Number.isFinite(t) ? t : null;
}

/** A new prompt typed by a person or injected by claude-duo (not a tool result). */
function isNewPrompt(entry) {
  const { e, raw } = entry;
  if (raw.includes('[claude-duo] New ')) return true;
  if (e.type !== 'user' || e.isMeta || e.isSidechain) return false;
  const c = e.message && e.message.content;
  if (typeof c === 'string') return c.trim() !== '';
  return Array.isArray(c) && c.some((x) => x && x.type === 'text') && !c.some((x) => x && x.type === 'tool_result');
}

function emptyTotals() {
  return { input: 0, cache_write: 0, cache_read: 0, output: 0, turns: 0, models: [] };
}

function addUsage(tot, seen, e) {
  const m = e.message;
  if (e.type !== 'assistant' || !m || !m.usage) return;
  const key = m.id || `${e.uuid}`;
  if (seen.has(key)) return; // one API message is logged once per content block
  seen.add(key);
  const u = m.usage;
  tot.input += Number(u.input_tokens) || 0;
  tot.cache_write += Number(u.cache_creation_input_tokens) || 0;
  tot.cache_read += Number(u.cache_read_input_tokens) || 0;
  tot.output += Number(u.output_tokens) || 0;
  tot.turns += 1;
  if (m.model && !tot.models.includes(m.model)) tot.models.push(m.model);
}

/**
 * Usage of one work message (task/question) on the receiving side.
 * Returns { input, cache_write, cache_read, output, turns, models, cost_usd,
 * total_in, file } or null when the transcript cannot be found.
 */
export function taskUsage(cfg, msg) {
  const sid = msg && msg.meta && msg.meta.handler_session;
  if (!sid || !['task', 'question'].includes(msg.type)) return null;
  const peer = cfg.peers[msg.to];
  if (!peer) return null;
  const files = transcriptFiles(peer.config_dir, sid);
  if (!files) return null;
  const lines = readLines(files.main);
  if (!lines) return null;

  const start = lines.findIndex((l) => l.raw.includes(msg.id));
  if (start < 0) return null;
  const replied = Date.parse(msg.meta.replied_at || '') || null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const t = ts(lines[i].e);
    // Before the reply everything belongs to the task (needs_info round trips
    // included); after it, the next prompt starts something else.
    if (replied && t !== null && t > replied && isNewPrompt(lines[i])) { end = i; break; }
  }
  if (!replied) {
    // Unfinished: stop at the next claude-duo task for this session.
    for (let i = start + 1; i < lines.length; i++) {
      if (lines[i].raw.includes('[claude-duo] New ') && !lines[i].raw.includes(msg.id)) { end = i; break; }
    }
  }

  const tot = emptyTotals();
  const seen = new Set();
  let costBefore = null; let costIn = null;
  for (let i = 0; i < end; i++) {
    const { e } = lines[i];
    if (e.type === 'cost-state' && Number.isFinite(e.totalCostUSD)) {
      if (i < start) costBefore = e.totalCostUSD; else costIn = e.totalCostUSD;
    }
    if (i >= start) addUsage(tot, seen, e);
  }

  // Subagents of this session, within the same time window.
  const t0 = ts(lines[start].e) ?? (Date.parse(msg.meta.picked_up_at || msg.meta.accepted_at || msg.created_at) || 0);
  let t1 = Infinity;
  for (let i = end; i < lines.length; i++) { const t = ts(lines[i].e); if (t !== null) { t1 = t; break; } }
  for (const f of files.subs) {
    for (const l of readLines(f) || []) {
      const t = ts(l.e);
      if (t !== null && t >= t0 && t < t1) addUsage(tot, seen, l.e);
    }
  }

  let cost = null;
  if (costIn !== null) {
    const d = costBefore !== null ? costIn - costBefore : costIn;
    cost = d >= 0 ? d : costIn; // counter restarted (new process): best guess
  }
  return {
    ...tot,
    total_in: tot.input + tot.cache_write + tot.cache_read,
    cost_usd: cost === null ? null : Math.round(cost * 10000) / 10000,
    file: files.main,
  };
}
