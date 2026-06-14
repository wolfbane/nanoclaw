import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

// Isolate the lock to a throwaway data dir so the test never touches the real
// one. vi.hoisted so the value exists when the hoisted vi.mock factory runs.
const TEST_DATA_DIR = vi.hoisted(
  () => `/tmp/nanoclaw-lock-test-${process.pid}`,
);
vi.mock('./config.js', () => ({ DATA_DIR: TEST_DATA_DIR }));
vi.mock('./logger.js', () => ({
  logger: { fatal: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

import {
  acquireSingletonLock,
  releaseSingletonLock,
} from './singleton-lock.js';

const LOCK_PATH = path.join(TEST_DATA_DIR, 'nanoclaw.lock');

describe('singleton-lock', () => {
  beforeEach(() => {
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  });

  it('writes our PID when no lock exists', () => {
    acquireSingletonLock();
    expect(fs.readFileSync(LOCK_PATH, 'utf8').trim()).toBe(String(process.pid));
  });

  it('takes over a stale lock from a dead PID', () => {
    fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
    fs.writeFileSync(LOCK_PATH, '999999'); // not a live process
    acquireSingletonLock();
    expect(fs.readFileSync(LOCK_PATH, 'utf8').trim()).toBe(String(process.pid));
  });

  it('exits when another live instance holds the lock', () => {
    fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
    fs.writeFileSync(LOCK_PATH, '4242');
    // Pretend PID 4242 is alive; exit() is a no-op spy (real exit() doesn't
    // throw, and acquire's own try/catch would swallow a thrown one anyway).
    vi.spyOn(process, 'kill').mockReturnValue(true as unknown as true);
    const exit = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as never);

    acquireSingletonLock();
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('release removes the lock only when we hold it', () => {
    acquireSingletonLock();
    expect(fs.existsSync(LOCK_PATH)).toBe(true);
    releaseSingletonLock();
    expect(fs.existsSync(LOCK_PATH)).toBe(false);
  });

  it('release leaves a lock held by another PID intact', () => {
    fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
    fs.writeFileSync(LOCK_PATH, '4242');
    releaseSingletonLock();
    expect(fs.existsSync(LOCK_PATH)).toBe(true);
  });
});
