/**
 * Per-data-dir singleton guard.
 *
 * Two NanoClaw instances sharing one data dir (same store/, ipc/, sessions/)
 * race on the scheduler, IPC watcher, and container tracking — a split-brain
 * that strands containers and double-runs tasks (the 2026-06-14 orphan
 * incident: a stray instance bound ports during a restart window, then kept
 * running alongside the managed one). This refuses to start a second instance
 * for the same data dir.
 *
 * Intentional multi-instance via NANOCLAW_DATA_DIR still works: the lock lives
 * in DATA_DIR, so distinct data dirs hold distinct locks.
 *
 * Uses a PID file rather than flock to avoid a native dependency. A stale lock
 * (holder no longer alive) is taken over, and the liveness check makes leftover
 * files self-healing, so a hard-killed instance never blocks the next start.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { logger } from './logger.js';

const LOCK_PATH = path.join(DATA_DIR, 'nanoclaw.lock');

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH = no such process (dead). EPERM = exists but not signalable by us
    // (still alive). Anything else: assume not alive.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Acquire the singleton lock, or exit(1) if another live instance already holds
 * it for this data dir. Call once at startup, before binding services or
 * starting the scheduler/IPC loops.
 */
export function acquireSingletonLock(): void {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const existing = fs.existsSync(LOCK_PATH)
      ? parseInt(fs.readFileSync(LOCK_PATH, 'utf8').trim(), 10)
      : NaN;

    if (existing && existing !== process.pid && isAlive(existing)) {
      logger.fatal(
        { holderPid: existing, lockPath: LOCK_PATH, dataDir: DATA_DIR },
        'Another NanoClaw instance is already running for this data dir — ' +
          'exiting to avoid split-brain. (Use a separate NANOCLAW_DATA_DIR ' +
          'to run a second instance intentionally.)',
      );
      process.exit(1);
    }

    if (existing && existing !== process.pid) {
      logger.warn(
        { stalePid: existing, lockPath: LOCK_PATH },
        'Taking over stale singleton lock from a dead instance',
      );
    }

    fs.writeFileSync(LOCK_PATH, String(process.pid));
  } catch (err) {
    // A filesystem hiccup on the lock shouldn't block startup; the proxy
    // port bind is still a backstop against a concurrent instance.
    logger.warn(
      { err, lockPath: LOCK_PATH },
      'Singleton lock check failed — continuing without it',
    );
  }
}

/** Best-effort release on graceful shutdown (only if we still hold it). */
export function releaseSingletonLock(): void {
  try {
    const held = parseInt(fs.readFileSync(LOCK_PATH, 'utf8').trim(), 10);
    if (held === process.pid) fs.unlinkSync(LOCK_PATH);
  } catch {
    /* already gone or unreadable — nothing to do */
  }
}
