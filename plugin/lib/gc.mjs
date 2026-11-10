// Housekeeping: expire overdue messages, mark abandoned work as failed,
// delete finished messages older than retention_days. SPEC §5.3, §14.
import fs from 'node:fs';
import path from 'node:path';
import { paths } from './paths.mjs';
import { PEERS } from './config.mjs';
import { listMessages, updateMessage, isExpired } from './mailbox.mjs';
import { listSessions } from './registry.mjs';
import { log } from './fsutil.mjs';

export function gc(cfg, now = Date.now()) {
  const report = { expired: 0, stale: 0, deleted: 0 };
  const alive = new Set(PEERS.flatMap((p) => listSessions(p).map((s) => s.session_id)));
  for (const m of listMessages({ boxes: ['new', 'cur'] })) {
    try {
      if (isExpired(m, now)) {
        updateMessage(m.id, (x) => { x.status = 'expired'; x.meta.error = 'deadline_passed'; });
        report.expired++;
        continue;
      }
      const limit = (m.deadline_s || cfg.limits.default_deadline_s) * 2 * 1000;
      if (['accepted', 'in_progress'].includes(m.status) && now - Date.parse(m.updated_at) > limit
          && (!m.meta.handler_session || !alive.has(m.meta.handler_session))) {
        updateMessage(m.id, (x) => { x.status = 'failed'; x.meta.error = 'stale_no_reply'; });
        report.stale++;
      }
    } catch (e) { log('gc-item-failed', m.id, e.message); }
  }
  const keepMs = cfg.retention_days * 24 * 3600 * 1000;
  for (const p of PEERS) {
    const dir = paths.mail(p, 'done');
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const n of names) {
      const f = path.join(dir, n);
      try {
        if (now - fs.statSync(f).mtimeMs > keepMs) {
          fs.rmSync(f, { force: true });
          fs.rmSync(paths.attachments(n.replace(/\.json$/, '')), { recursive: true, force: true });
          report.deleted++;
        }
      } catch { /* ignore */ }
    }
  }
  log('gc', report);
  return report;
}
