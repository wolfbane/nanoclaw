import { afterEach, describe, it, expect } from 'vitest';

import {
  STALE_THREAD_RE,
  createCodexConfigOverrides,
  tomlBasicString,
} from './codex-app-server.js';

describe('tomlBasicString', () => {
  it('leaves safe strings unchanged inside quotes', () => {
    expect(tomlBasicString('hello')).toBe('"hello"');
    expect(tomlBasicString('bun')).toBe('"bun"');
    expect(tomlBasicString('/usr/local/bin/node')).toBe(
      '"/usr/local/bin/node"',
    );
  });

  it('escapes double-quotes', () => {
    expect(tomlBasicString('a"b')).toBe('"a\\"b"');
    expect(tomlBasicString('"quoted"')).toBe('"\\"quoted\\""');
  });

  it('escapes backslashes', () => {
    expect(tomlBasicString('a\\b')).toBe('"a\\\\b"');
    expect(tomlBasicString('C:\\path\\to\\bin')).toBe(
      '"C:\\\\path\\\\to\\\\bin"',
    );
  });

  it('escapes backslash before quote (order matters)', () => {
    expect(tomlBasicString('\\"')).toBe('"\\\\\\""');
  });

  it('rejects strings containing newlines', () => {
    expect(() => tomlBasicString('line1\nline2')).toThrow(/newline/);
    expect(() => tomlBasicString('trailing\n')).toThrow(/newline/);
    expect(() => tomlBasicString('crlf\r\nhere')).toThrow(/newline/);
  });
});

describe('STALE_THREAD_RE', () => {
  it('matches stale-thread error messages', () => {
    expect(STALE_THREAD_RE.test('thread not found')).toBe(true);
    expect(STALE_THREAD_RE.test('unknown thread xyz')).toBe(true);
    expect(STALE_THREAD_RE.test('No such thread: abc')).toBe(true);
    expect(STALE_THREAD_RE.test('invalid thread_id')).toBe(true);
    expect(STALE_THREAD_RE.test('thread_id not found')).toBe(true);
    expect(STALE_THREAD_RE.test('thread id does not exist')).toBe(true);
    expect(STALE_THREAD_RE.test('unknown thread id 019ec729')).toBe(true);
  });

  it('does not match transient or unrelated errors', () => {
    expect(STALE_THREAD_RE.test('rate limit exceeded')).toBe(false);
    expect(STALE_THREAD_RE.test('authentication failed')).toBe(false);
    expect(STALE_THREAD_RE.test('connection reset by peer')).toBe(false);
    expect(STALE_THREAD_RE.test('internal server error')).toBe(false);
    // A bare thread_id reference must NOT trigger a fresh-thread fallback —
    // these are validation/quota errors, not "this thread is gone".
    expect(STALE_THREAD_RE.test('thread_id must be a string')).toBe(false);
    expect(STALE_THREAD_RE.test('missing required parameter: thread_id')).toBe(
      false,
    );
    expect(
      STALE_THREAD_RE.test('rate limit exceeded for thread_id 019ec729'),
    ).toBe(false);
  });
});

describe('createCodexConfigOverrides — reasoning effort (07l)', () => {
  afterEach(() => {
    delete process.env.CODEX_REASONING_EFFORT;
  });

  it('omits model_reasoning_effort when CODEX_REASONING_EFFORT is unset', () => {
    const ov = createCodexConfigOverrides();
    expect(ov).toContain('features.use_linux_sandbox_bwrap=false');
    expect(ov.some((o) => o.startsWith('model_reasoning_effort='))).toBe(false);
  });

  it('passes a valid effort (case/space-insensitive)', () => {
    process.env.CODEX_REASONING_EFFORT = '  HIGH ';
    expect(createCodexConfigOverrides()).toContain(
      'model_reasoning_effort=high',
    );
  });

  it('accepts every documented level', () => {
    for (const lvl of ['minimal', 'low', 'medium', 'high', 'xhigh']) {
      process.env.CODEX_REASONING_EFFORT = lvl;
      expect(createCodexConfigOverrides()).toContain(
        `model_reasoning_effort=${lvl}`,
      );
    }
  });

  it('ignores an invalid effort rather than passing a bad override', () => {
    process.env.CODEX_REASONING_EFFORT = 'turbo';
    expect(
      createCodexConfigOverrides().some((o) =>
        o.startsWith('model_reasoning_effort='),
      ),
    ).toBe(false);
  });
});
