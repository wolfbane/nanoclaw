import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';
import { isValidTimezone } from './timezone.js';

// Read config values from .env (falls back to process.env).
// Secrets (API keys, tokens) are NOT read here — they are loaded only
// by the credential proxy (credential-proxy.ts), never exposed to containers.
const envConfig = readEnvFile([
  'ASSISTANT_NAME',
  'ASSISTANT_HAS_OWN_NUMBER',
  'TZ',
]);

export const ASSISTANT_NAME =
  process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME || 'Andy';
export const ASSISTANT_HAS_OWN_NUMBER =
  (process.env.ASSISTANT_HAS_OWN_NUMBER ||
    envConfig.ASSISTANT_HAS_OWN_NUMBER) === 'true';
// How often the message loop polls SQLite for new inbound messages. Lower =
// snappier replies but more idle DB reads; higher = laggier. Env-overridable.
export const POLL_INTERVAL = Math.max(
  1,
  parseInt(process.env.POLL_INTERVAL || '2000', 10) || 2000,
);
// How often the scheduler checks for due tasks. Tasks fire on a minute
// granularity, so polling faster than ~60s buys nothing.
export const SCHEDULER_POLL_INTERVAL = Math.max(
  1,
  parseInt(process.env.SCHEDULER_POLL_INTERVAL || '60000', 10) || 60000,
);

// Absolute paths needed for container mounts
export const PROJECT_ROOT = process.cwd();
const HOME_DIR = process.env.HOME || os.homedir();

// Support multiple instances sharing the same codebase.
// NANOCLAW_DATA_DIR overrides where store/, groups/, and data/ live so a
// second instance can use a separate data directory without a separate clone.
const DATA_ROOT = process.env.NANOCLAW_DATA_DIR
  ? path.resolve(process.env.NANOCLAW_DATA_DIR)
  : PROJECT_ROOT;

// Mount security: allowlist stored OUTSIDE project root, never mounted into containers
export const MOUNT_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'mount-allowlist.json',
);
export const SENDER_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'sender-allowlist.json',
);
export const STORE_DIR = path.resolve(DATA_ROOT, 'store');
export const GROUPS_DIR = path.resolve(DATA_ROOT, 'groups');
export const DATA_DIR = path.resolve(DATA_ROOT, 'data');

export const CONTAINER_IMAGE =
  process.env.CONTAINER_IMAGE || 'nanoclaw-agent:latest';
// Hard ceiling on a single container run (default 30min). The grace logic in
// container-runner keeps this ≥ IDLE_TIMEOUT + 30s so the graceful _close fires
// first. Raise for long agent tasks; lower to reclaim a wedged container sooner.
export const CONTAINER_TIMEOUT = parseInt(
  process.env.CONTAINER_TIMEOUT || '1800000',
  10,
);
// Max bytes buffered from a container's stdout/stderr (default 10MB). A runaway
// agent can't exhaust host memory; output past this is truncated (with a WARN).
export const CONTAINER_MAX_OUTPUT_SIZE = parseInt(
  process.env.CONTAINER_MAX_OUTPUT_SIZE || '10485760',
  10,
); // 10MB default
export const CREDENTIAL_PROXY_PORT = parseInt(
  process.env.CREDENTIAL_PROXY_PORT || '3001',
  10,
);
export const CALDAV_SERVICE_PORT = parseInt(
  process.env.CALDAV_SERVICE_PORT || '3002',
  10,
);
export const CARDDAV_SERVICE_PORT = parseInt(
  process.env.CARDDAV_SERVICE_PORT || '3003',
  10,
);
export const MAX_MESSAGES_PER_PROMPT = Math.max(
  1,
  parseInt(process.env.MAX_MESSAGES_PER_PROMPT || '10', 10) || 10,
);
// How often the host polls the per-group IPC dirs for agent→host requests and
// the host writes follow-ups. Lower = snappier mid-session piping, more polling.
export const IPC_POLL_INTERVAL = Math.max(
  1,
  parseInt(process.env.IPC_POLL_INTERVAL || '1000', 10) || 1000,
);
// How long a container stays warm waiting for the next message after its last
// result (default 30min). Higher = fewer cold starts, more idle containers.
export const IDLE_TIMEOUT = parseInt(process.env.IDLE_TIMEOUT || '1800000', 10); // 30min default — how long to keep container alive after last result
export const MAX_CONCURRENT_CONTAINERS = Math.max(
  1,
  parseInt(process.env.MAX_CONCURRENT_CONTAINERS || '5', 10) || 5,
);

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function buildTriggerPattern(trigger: string): RegExp {
  return new RegExp(`^${escapeRegex(trigger.trim())}\\b`, 'i');
}

export const DEFAULT_TRIGGER = `@${ASSISTANT_NAME}`;

export function getTriggerPattern(trigger?: string): RegExp {
  const normalizedTrigger = trigger?.trim();
  return buildTriggerPattern(normalizedTrigger || DEFAULT_TRIGGER);
}

export const TRIGGER_PATTERN = buildTriggerPattern(DEFAULT_TRIGGER);

// Explicit `requiresTrigger` overrides the main-group bypass, so a main
// group that shares a channel with sibling bots can opt into gated
// triggers and stay silent on messages meant for those siblings.
export function resolveRequiresTrigger(
  group: { requiresTrigger?: boolean },
  isMainGroup: boolean,
): boolean {
  return group.requiresTrigger ?? !isMainGroup;
}

// Timezone for scheduled tasks, message formatting, etc.
// Validates each candidate is a real IANA identifier before accepting.
function resolveConfigTimezone(): string {
  const candidates = [
    process.env.TZ,
    envConfig.TZ,
    Intl.DateTimeFormat().resolvedOptions().timeZone,
  ];
  for (const tz of candidates) {
    if (tz && isValidTimezone(tz)) return tz;
  }
  return 'UTC';
}
export const TIMEZONE = resolveConfigTimezone();
