import { describe, it, expect, beforeEach } from 'vitest';

import {
  _initTestDatabase,
  setRouterState,
  setSession,
  storeChatMetadata,
  storeMessage,
} from './db.js';
import {
  clearSession,
  getCursor,
  getLastTimestamp,
  getSession,
  getSessions,
  loadState,
  peekCursor,
  sessionKey,
  setCursor,
  setLastTimestamp,
  setSessionId,
} from './state.js';

const ASSISTANT_NAME_FROM_CONFIG = 'Andy'; // must match the default in src/config.ts

beforeEach(() => {
  _initTestDatabase();
});

describe('loadState', () => {
  it('reads lastTimestamp and cursors from router_state', () => {
    setRouterState('last_timestamp', '2026-04-01T00:00:00.000Z');
    setRouterState(
      'last_agent_timestamp',
      JSON.stringify({ 'chat@test': '2026-04-01T00:00:00.000Z' }),
    );
    loadState();
    expect(getLastTimestamp()).toBe('2026-04-01T00:00:00.000Z');
    expect(peekCursor('chat@test')).toBe('2026-04-01T00:00:00.000Z');
  });

  it('falls back to empty map on corrupted last_agent_timestamp JSON', () => {
    setRouterState('last_agent_timestamp', 'not json');
    loadState();
    expect(peekCursor('chat@test')).toBe('');
  });

  it('loads all persisted sessions into memory', () => {
    setSession('whatsapp_family', 'sess-1');
    setSession('telegram_dev', 'sess-2');
    loadState();
    expect(getSession('whatsapp_family', 'claude')).toBe('sess-1');
    expect(getSession('telegram_dev', 'claude')).toBe('sess-2');
    expect(Object.keys(getSessions())).toHaveLength(2);
  });
});

describe('setLastTimestamp', () => {
  it('updates in-memory and persists to router_state', () => {
    loadState();
    setLastTimestamp('2026-04-15T12:00:00.000Z');
    expect(getLastTimestamp()).toBe('2026-04-15T12:00:00.000Z');
    // Re-load to verify persistence
    loadState();
    expect(getLastTimestamp()).toBe('2026-04-15T12:00:00.000Z');
  });
});

describe('setCursor / peekCursor', () => {
  it('stores and retrieves a per-chat cursor without recovery', () => {
    loadState();
    setCursor('chat@test', '2026-04-10T00:00:00.000Z');
    expect(peekCursor('chat@test')).toBe('2026-04-10T00:00:00.000Z');
  });

  it('peekCursor returns empty string for unknown chat', () => {
    loadState();
    expect(peekCursor('never-seen@test')).toBe('');
  });
});

describe('getCursor (with recovery)', () => {
  it('returns the stored cursor when one exists', () => {
    loadState();
    setCursor('chat@test', '2026-04-10T00:00:00.000Z');
    expect(getCursor('chat@test')).toBe('2026-04-10T00:00:00.000Z');
  });

  it('recovers from last bot message when no cursor is set', () => {
    storeChatMetadata('chat@test', '2026-04-05T00:00:00.000Z');
    storeMessage({
      id: 'bot-1',
      chat_jid: 'chat@test',
      sender: 'me',
      sender_name: ASSISTANT_NAME_FROM_CONFIG,
      content: 'hello',
      timestamp: '2026-04-05T00:00:00.000Z',
      is_from_me: true,
      is_bot_message: true,
    });

    loadState();
    const recovered = getCursor('chat@test');
    expect(recovered).toBe('2026-04-05T00:00:00.000Z');
    // Recovery should also persist the cursor so the next call is cheap
    expect(peekCursor('chat@test')).toBe('2026-04-05T00:00:00.000Z');
  });

  it('returns empty string when no cursor and no bot history exists', () => {
    loadState();
    expect(getCursor('never-seen@test')).toBe('');
  });
});

describe('session mutations', () => {
  it('setSessionId stores in memory and persists', () => {
    loadState();
    setSessionId('whatsapp_family', 'claude', 'sess-abc');
    expect(getSession('whatsapp_family', 'claude')).toBe('sess-abc');
    // Re-load to verify persistence
    loadState();
    expect(getSession('whatsapp_family', 'claude')).toBe('sess-abc');
  });

  it('clearSession removes from memory and DB', () => {
    loadState();
    setSessionId('whatsapp_family', 'claude', 'sess-abc');
    clearSession('whatsapp_family', 'claude');
    expect(getSession('whatsapp_family', 'claude')).toBeUndefined();
    loadState();
    expect(getSession('whatsapp_family', 'claude')).toBeUndefined();
  });

  it('getSession returns undefined for unknown folder', () => {
    loadState();
    expect(getSession('missing', 'claude')).toBeUndefined();
  });

  it('keys sessions per-provider so a provider switch never reuses the wrong id', () => {
    loadState();
    setSessionId('grp', 'claude', 'claude-session');
    setSessionId('grp', 'codex', 'codex-thread');
    // Same folder, different providers → independent slots.
    expect(getSession('grp', 'claude')).toBe('claude-session');
    expect(getSession('grp', 'codex')).toBe('codex-thread');
    // Claude keeps the bare-folder key (back-compat); codex is qualified.
    expect(sessionKey('grp', 'claude')).toBe('grp');
    expect(sessionKey('grp', 'codex')).toBe('grp#codex');
    // Clearing one provider leaves the other intact.
    clearSession('grp', 'claude');
    expect(getSession('grp', 'claude')).toBeUndefined();
    expect(getSession('grp', 'codex')).toBe('codex-thread');
  });
});
