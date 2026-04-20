/**
 * In-memory cursor and session state, with DB-backed persistence.
 * Extracted from src/index.ts to keep the orchestrator focused on flow control.
 */
import { ASSISTANT_NAME } from './config.js';
import {
  deleteSession as dbDeleteSession,
  getAllSessions,
  getLastBotMessageTimestamp,
  getRouterState,
  setRouterState,
  setSession as dbSetSession,
} from './db.js';
import { logger } from './logger.js';

let lastTimestamp = '';
let sessions: Record<string, string> = {};
let lastAgentTimestamp: Record<string, string> = {};

/** Load all persisted state from the DB into memory. Call once at startup. */
export function loadState(): void {
  lastTimestamp = getRouterState('last_timestamp') || '';
  const agentTs = getRouterState('last_agent_timestamp');
  try {
    lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
  } catch {
    logger.warn('Corrupted last_agent_timestamp in DB, resetting');
    lastAgentTimestamp = {};
  }
  sessions = getAllSessions();
}

/** Persist cursor state to the DB. Sessions are written on mutation, not here. */
export function saveState(): void {
  setRouterState('last_timestamp', lastTimestamp);
  setRouterState('last_agent_timestamp', JSON.stringify(lastAgentTimestamp));
}

export function getLastTimestamp(): string {
  return lastTimestamp;
}

export function setLastTimestamp(ts: string): void {
  lastTimestamp = ts;
  saveState();
}

/**
 * Return the per-chat agent cursor, recovering from the last bot reply if missing
 * (new group, corrupted state, restart).
 */
export function getCursor(chatJid: string): string {
  const existing = lastAgentTimestamp[chatJid];
  if (existing) return existing;

  const botTs = getLastBotMessageTimestamp(chatJid, ASSISTANT_NAME);
  if (botTs) {
    logger.info(
      { chatJid, recoveredFrom: botTs },
      'Recovered message cursor from last bot reply',
    );
    lastAgentTimestamp[chatJid] = botTs;
    saveState();
    return botTs;
  }
  return '';
}

/** Return the stored cursor without recovery (useful for save/restore around a run). */
export function peekCursor(chatJid: string): string {
  return lastAgentTimestamp[chatJid] || '';
}

export function setCursor(chatJid: string, ts: string): void {
  lastAgentTimestamp[chatJid] = ts;
  saveState();
}

export function getSession(folder: string): string | undefined {
  return sessions[folder];
}

export function getSessions(): Record<string, string> {
  return { ...sessions };
}

export function setSessionId(folder: string, sessionId: string): void {
  sessions[folder] = sessionId;
  dbSetSession(folder, sessionId);
}

export function clearSession(folder: string): void {
  delete sessions[folder];
  dbDeleteSession(folder);
}
