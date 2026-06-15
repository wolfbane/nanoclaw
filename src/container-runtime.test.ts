import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock logger
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock child_process — store the mock fns so tests can configure them.
// stopContainer uses promisify(execFile); the default mock invokes the
// callback with success so the promisified wrapper resolves.
const mockExecSync = vi.fn();
const mockExecFile = vi.fn(
  (
    _file: string,
    _args: string[],
    cb: (e: Error | null, r?: unknown) => void,
  ) => cb(null, { stdout: '', stderr: '' }),
);
vi.mock('child_process', () => ({
  execSync: (...args: unknown[]) => mockExecSync(...args),
  execFile: (...args: unknown[]) =>
    (mockExecFile as (...a: unknown[]) => unknown)(...args),
}));

import {
  CONTAINER_RUNTIME_BIN,
  readonlyMountArgs,
  stopContainer,
  ensureContainerRuntimeRunning,
  cleanupOrphans,
} from './container-runtime.js';
import { logger } from './logger.js';

beforeEach(() => {
  vi.clearAllMocks();
});

// --- Pure functions ---

describe('readonlyMountArgs', () => {
  it('returns --mount flag with type=bind and readonly', () => {
    const args = readonlyMountArgs('/host/path', '/container/path');
    expect(args).toEqual([
      '--mount',
      'type=bind,source=/host/path,target=/container/path,readonly',
    ]);
  });
});

describe('stopContainer', () => {
  it('calls container stop (via execFile, no shell) for valid names', async () => {
    await stopContainer('nanoclaw-test-123');
    expect(mockExecFile).toHaveBeenCalledWith(
      CONTAINER_RUNTIME_BIN,
      ['stop', 'nanoclaw-test-123'],
      expect.any(Function),
    );
  });

  it('rejects names with shell metacharacters', async () => {
    await expect(stopContainer('foo; rm -rf /')).rejects.toThrow(
      'Invalid container name',
    );
    await expect(stopContainer('foo$(whoami)')).rejects.toThrow(
      'Invalid container name',
    );
    await expect(stopContainer('foo`id`')).rejects.toThrow(
      'Invalid container name',
    );
    expect(mockExecFile).not.toHaveBeenCalled();
  });
});

// --- ensureContainerRuntimeRunning ---

describe('ensureContainerRuntimeRunning', () => {
  it('does nothing when runtime is already running', () => {
    mockExecSync.mockReturnValueOnce('');

    ensureContainerRuntimeRunning();

    expect(mockExecSync).toHaveBeenCalledTimes(1);
    expect(mockExecSync).toHaveBeenCalledWith(
      `${CONTAINER_RUNTIME_BIN} system status`,
      { stdio: 'pipe' },
    );
    expect(logger.debug).toHaveBeenCalledWith(
      'Container runtime already running',
    );
  });

  it('auto-starts when system status fails', () => {
    // First call (system status) fails
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('not running');
    });
    // Second call (system start) succeeds
    mockExecSync.mockReturnValueOnce('');

    ensureContainerRuntimeRunning();

    expect(mockExecSync).toHaveBeenCalledTimes(2);
    expect(mockExecSync).toHaveBeenNthCalledWith(
      2,
      `${CONTAINER_RUNTIME_BIN} system start`,
      { stdio: 'pipe', timeout: 30000 },
    );
    expect(logger.info).toHaveBeenCalledWith('Container runtime started');
  });

  it('throws when both status and start fail', () => {
    mockExecSync.mockImplementation(() => {
      throw new Error('failed');
    });

    expect(() => ensureContainerRuntimeRunning()).toThrow(
      'Container runtime is required but failed to start',
    );
    expect(logger.error).toHaveBeenCalled();
  });
});

// --- cleanupOrphans ---

describe('cleanupOrphans', () => {
  it('stops orphaned nanoclaw containers from JSON output', async () => {
    // Apple Container ls returns JSON
    const lsOutput = JSON.stringify([
      { status: 'running', configuration: { id: 'nanoclaw-group1-111' } },
      { status: 'stopped', configuration: { id: 'nanoclaw-group2-222' } },
      { status: 'running', configuration: { id: 'nanoclaw-group3-333' } },
      { status: 'running', configuration: { id: 'other-container' } },
    ]);
    mockExecSync.mockReturnValueOnce(lsOutput);

    await cleanupOrphans();

    // ls via execSync; 2 stops via execFile (only running nanoclaw- containers)
    expect(mockExecSync).toHaveBeenCalledTimes(1);
    expect(mockExecFile).toHaveBeenCalledTimes(2);
    expect(mockExecFile).toHaveBeenCalledWith(
      CONTAINER_RUNTIME_BIN,
      ['stop', 'nanoclaw-group1-111'],
      expect.any(Function),
    );
    expect(mockExecFile).toHaveBeenCalledWith(
      CONTAINER_RUNTIME_BIN,
      ['stop', 'nanoclaw-group3-333'],
      expect.any(Function),
    );
    expect(logger.info).toHaveBeenCalledWith(
      { count: 2, names: ['nanoclaw-group1-111', 'nanoclaw-group3-333'] },
      'Stopped orphaned containers',
    );
  });

  it('does nothing when no orphans exist', async () => {
    mockExecSync.mockReturnValueOnce('[]');

    await cleanupOrphans();

    expect(mockExecSync).toHaveBeenCalledTimes(1);
    expect(mockExecFile).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('warns and continues when ls fails', async () => {
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('container not available');
    });

    await cleanupOrphans(); // should not throw

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'Failed to clean up orphaned containers',
    );
  });

  it('continues stopping remaining containers when one stop fails', async () => {
    const lsOutput = JSON.stringify([
      { status: 'running', configuration: { id: 'nanoclaw-a-1' } },
      { status: 'running', configuration: { id: 'nanoclaw-b-2' } },
    ]);
    mockExecSync.mockReturnValueOnce(lsOutput);
    // First stop fails, second succeeds — the .catch in cleanupOrphans swallows it.
    mockExecFile.mockImplementationOnce(
      (_file: string, _args: string[], cb: (e: Error | null) => void) =>
        cb(new Error('already stopped')),
    );

    await cleanupOrphans(); // should not throw

    expect(mockExecFile).toHaveBeenCalledTimes(2);
    expect(logger.info).toHaveBeenCalledWith(
      { count: 2, names: ['nanoclaw-a-1', 'nanoclaw-b-2'] },
      'Stopped orphaned containers',
    );
  });
});
