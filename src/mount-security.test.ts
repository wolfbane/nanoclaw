import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock the allowlist path + logger + fs so the test never touches real paths.
vi.mock('./config.js', () => ({
  MOUNT_ALLOWLIST_PATH: '/fake/mount-allowlist.json',
}));
vi.mock('./logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('fs', () => ({
  default: {
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
    realpathSync: vi.fn(),
  },
}));

import fs from 'fs';
import { validateMount } from './mount-security.js';

// One allowlist for the whole suite (loadMountAllowlist caches after first load,
// so every test validates against the same roots — which is what we want here).
const ALLOWLIST = {
  allowedRoots: [
    {
      path: '/data/projects',
      allowReadWrite: true,
      allowNonMainReadWrite: false,
      description: 'projects',
    },
    {
      path: '/data/shared',
      allowReadWrite: true,
      allowNonMainReadWrite: true,
      description: 'shared',
    },
  ],
  blockedPatterns: [],
  nonMainReadOnly: true,
};

beforeEach(() => {
  vi.mocked(fs.existsSync).mockReturnValue(true);
  vi.mocked(fs.readFileSync).mockReturnValue(
    JSON.stringify(ALLOWLIST) as never,
  );
  // realpathSync: identity for "existing" paths, throw for any "missing" path.
  vi.mocked(fs.realpathSync).mockImplementation(((p: fs.PathLike) => {
    const s = String(p);
    if (s.includes('missing')) throw new Error('ENOENT');
    return s;
  }) as never);
});

describe('mount-security validateMount', () => {
  it('rejects a container path containing ".."', () => {
    const r = validateMount(
      { hostPath: '/data/projects/x', containerPath: '../escape' },
      true,
    );
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/Invalid container path/);
  });

  it('rejects a container path containing ":" (mount-option injection)', () => {
    const r = validateMount(
      { hostPath: '/data/projects/x', containerPath: 'repo:rw' },
      true,
    );
    expect(r.allowed).toBe(false);
  });

  it('rejects a host path outside every allowed root', () => {
    const r = validateMount(
      { hostPath: '/outside/secret', containerPath: 'x' },
      true,
    );
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/not under any allowed root/);
  });

  it('rejects a non-existent host path', () => {
    const r = validateMount(
      { hostPath: '/data/projects/missing', containerPath: 'x' },
      true,
    );
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/does not exist/);
  });

  it('rejects a default blocked pattern (.ssh)', () => {
    const r = validateMount(
      { hostPath: '/data/projects/.ssh', containerPath: 'ssh' },
      true,
    );
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/blocked pattern/);
  });

  it('allows a main-group read-write mount under an allowed root', () => {
    const r = validateMount(
      {
        hostPath: '/data/projects/repo',
        containerPath: 'repo',
        readonly: false,
      },
      true,
    );
    expect(r.allowed).toBe(true);
    expect(r.effectiveReadonly).toBe(false);
  });

  it('forces non-main read-write to read-only on a root without allowNonMainReadWrite', () => {
    const r = validateMount(
      {
        hostPath: '/data/projects/repo',
        containerPath: 'repo',
        readonly: false,
      },
      false,
    );
    expect(r.allowed).toBe(true);
    expect(r.effectiveReadonly).toBe(true);
  });

  it('allows non-main read-write on a root that opts in (allowNonMainReadWrite)', () => {
    const r = validateMount(
      { hostPath: '/data/shared/x', containerPath: 'x', readonly: false },
      false,
    );
    expect(r.allowed).toBe(true);
    expect(r.effectiveReadonly).toBe(false);
  });
});
