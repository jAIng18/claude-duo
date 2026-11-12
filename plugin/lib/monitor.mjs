// `duo monitor`: a small window (native AppKit/SwiftUI app, built once with the
// Command Line Tools' swiftc into ~/.claude-duo/bin/ClaudeDuoMonitor.app) that
// shows both accounts' quota. It behaves like any app: Dock icon, Cmd+Tab, goes
// behind other apps unless pinned.
// The window only draws: it runs `duo quota --watch` and reads one JSON
// snapshot per line, so all data logic stays in quota.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { paths } from './paths.mjs';
import { pidAlive } from './registry.mjs';
import { DuoError } from './config.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SOURCE = path.join(HERE, '..', 'monitor', 'DuoMonitor.swift');
const DUO_BIN = path.join(HERE, '..', 'bin', 'duo.mjs');
const appDir = () => path.join(paths.root(), 'bin', 'ClaudeDuoMonitor.app');
const binary = () => path.join(appDir(), 'Contents', 'MacOS', 'duo-monitor');
const OLD_BINARY = () => path.join(paths.root(), 'bin', 'duo-monitor'); // before it became an .app

const INFO_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleExecutable</key><string>duo-monitor</string>
  <key>CFBundleIdentifier</key><string>local.claude-duo.monitor</string>
  <key>CFBundleName</key><string>claude-duo</string>
  <key>CFBundleDisplayName</key><string>claude-duo</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>NSHighResolutionCapable</key><true/>
</dict></plist>
`;
const pidFile = () => path.join(paths.state(), 'monitor.pid');

function isFresh() {
  try { return fs.statSync(binary()).mtimeMs >= fs.statSync(SOURCE).mtimeMs; } catch { return false; }
}

function runningPid() {
  let pid = null;
  try { pid = Number(fs.readFileSync(pidFile(), 'utf8').trim()); } catch { return null; }
  if (!pidAlive(pid)) return null;
  // The pid may have been reused by another program.
  const r = spawnSync('ps', ['-o', 'comm=', '-p', String(pid)], { encoding: 'utf8' });
  return /duo-monitor/.test(r.stdout || '') ? pid : null;
}

export function buildMonitor({ force = false } = {}) {
  const out = binary();
  if (isFresh() && !force) return out;
  const which = spawnSync('xcrun', ['--find', 'swiftc'], { encoding: 'utf8' });
  if (which.status !== 0) {
    throw new DuoError('no_swiftc', 'Cần Xcode Command Line Tools để dựng khung theo dõi. Chạy: xcode-select --install');
  }
  fs.mkdirSync(path.dirname(out), { recursive: true }); // …/ClaudeDuoMonitor.app/Contents/MacOS
  process.stdout.write('Đang dựng khung theo dõi (chỉ lần đầu, khoảng 30 giây)…\n');
  const r = spawnSync('xcrun', ['swiftc', '-O', '-parse-as-library', '-o', out, SOURCE], { encoding: 'utf8' });
  if (r.status !== 0) throw new DuoError('build_failed', `Không dựng được khung theo dõi:\n${(r.stderr || '').slice(-3000)}`);
  fs.writeFileSync(path.join(appDir(), 'Contents', 'Info.plist'), INFO_PLIST);
  fs.rmSync(OLD_BINARY(), { force: true });
  return out;
}

export function startMonitor(cfg, { rebuild = false } = {}) {
  const cur = runningPid();
  if (cur && !rebuild && isFresh()) {
    try { process.kill(cur, 'SIGUSR1'); } catch { /* it just quit */ }
    return { already: true, pid: cur };
  }
  if (cur) stopMonitor(); // rebuild, or the source changed since it started
  const bin = buildMonitor({ force: rebuild });
  if (process.env.DUO_DRY_RUN === '1') return { already: false, pid: 0, dry_run: true };
  const child = spawn(bin, [process.execPath, DUO_BIN], { detached: true, stdio: 'ignore', env: process.env });
  child.unref();
  fs.mkdirSync(paths.state(), { recursive: true });
  fs.writeFileSync(pidFile(), String(child.pid));
  return { already: false, pid: child.pid };
}

export function stopMonitor() {
  const pid = runningPid();
  try { fs.rmSync(pidFile(), { force: true }); } catch { /* ignore */ }
  if (!pid) return false;
  try { process.kill(pid, 'SIGTERM'); } catch { return false; }
  return true;
}
