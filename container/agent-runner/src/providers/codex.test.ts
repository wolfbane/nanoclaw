import { describe, expect, it } from 'vitest';

import { extractCodexRateLimits } from './codex.js';

// account/rateLimits/updated parsing (nanoclaw-3yo). Runs from the host vitest
// because codex.ts doesn't import the in-container Claude SDK.
describe('extractCodexRateLimits', () => {
  it('reads the nested rateLimits shape with primary/secondary + plan', () => {
    const snap = extractCodexRateLimits({
      rateLimits: {
        primary: {
          usedPercent: 12.5,
          windowDurationMins: 300,
          resetsAt: '2026-06-15T00:00:00Z',
        },
        secondary: { usedPercent: 3, windowDurationMins: 10080, resetsAt: 999 },
        planType: 'plus',
      },
    });
    expect(snap).toEqual({
      primaryUsedPercent: 12.5,
      secondaryUsedPercent: 3,
      primaryResetsAt: '2026-06-15T00:00:00Z',
      secondaryResetsAt: '999', // numeric epoch stringified so it round-trips
      planType: 'plus',
      raw: expect.any(Object),
    });
  });

  it('also reads a flat shape (fields directly on params)', () => {
    const snap = extractCodexRateLimits({
      primary: { usedPercent: 50 },
      planType: 'pro',
    });
    expect(snap?.primaryUsedPercent).toBe(50);
    expect(snap?.planType).toBe('pro');
    expect(snap?.secondaryUsedPercent).toBeUndefined();
  });

  it('returns undefined when nothing useful is present', () => {
    expect(extractCodexRateLimits({})).toBeUndefined();
    expect(extractCodexRateLimits({ unrelated: 1 })).toBeUndefined();
  });
});
