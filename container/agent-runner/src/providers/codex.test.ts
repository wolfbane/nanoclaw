import { describe, expect, it } from 'vitest';

import { codexTurnUsageDelta, extractCodexRateLimits } from './codex.js';

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

// Per-turn token accounting. Regression: keeping only `.last` undercounted
// multi-step turns ~6x; the turn total is the cumulative-.total delta.
describe('codexTurnUsageDelta', () => {
  it('single-event turn: total == last → that turn', () => {
    const u = codexTurnUsageDelta([
      {
        total: { inputTokens: 11053, outputTokens: 271, cachedInputTokens: 8576 },
        last: { inputTokens: 11053, outputTokens: 271, cachedInputTokens: 8576 },
      },
    ]);
    expect(u).toMatchObject({ inputTokens: 11053, outputTokens: 271 });
  });

  it('multi-step turn: sums via final .total, not the last step', () => {
    const u = codexTurnUsageDelta([
      {
        total: { inputTokens: 10662, outputTokens: 287, cachedInputTokens: 10112 },
        last: { inputTokens: 10662, outputTokens: 287, cachedInputTokens: 10112 },
      },
      {
        total: { inputTokens: 22632, outputTokens: 700, cachedInputTokens: 20224 },
        last: { inputTokens: 11970, outputTokens: 413, cachedInputTokens: 10112 },
      },
    ]);
    // Final .total (700), NOT the last step's .last (413).
    expect(u?.outputTokens).toBe(700);
    expect(u?.inputTokens).toBe(22632);
  });

  it('resumed thread: baseline strips earlier turns (delta only)', () => {
    const u = codexTurnUsageDelta([
      // thread already had 5000 output; this turn's first step adds 287
      { total: { outputTokens: 5287 }, last: { outputTokens: 287 } },
      { total: { outputTokens: 7088 }, last: { outputTokens: 1801 } },
    ]);
    expect(u?.outputTokens).toBe(2088); // 7088 - (5287-287)
  });

  it('returns undefined when no events', () => {
    expect(codexTurnUsageDelta([])).toBeUndefined();
  });
});
