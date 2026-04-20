import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { _initTestDatabase } from './db.js';
import {
  IpcDeps,
  processIpcMessageFile,
  writeIpcAck,
} from './ipc.js';
import { RegisteredGroup } from './types.js';

// Isolated tmp ipcBase per-test so fs state never leaks between cases.
// We avoid the real DATA_DIR entirely — processIpcMessageFile takes the base
// path as an argument specifically so tests don't need to mock config.
let ipcBaseDir: string;

const MAIN_GROUP: RegisteredGroup = {
  name: 'Main',
  folder: 'whatsapp_main',
  trigger: 'always',
  added_at: '2024-01-01T00:00:00.000Z',
  isMain: true,
};

const OTHER_GROUP: RegisteredGroup = {
  name: 'Other',
  folder: 'other-group',
  trigger: '@Andy',
  added_at: '2024-01-01T00:00:00.000Z',
};

function makeDeps(overrides: Partial<IpcDeps> = {}): IpcDeps {
  return {
    sendMessage: async () => {},
    registeredGroups: () => ({}),
    registerGroup: () => {},
    syncGroups: async () => {},
    getAvailableGroups: () => [],
    writeGroupsSnapshot: () => {},
    onTasksChanged: () => {},
    ...overrides,
  };
}

function writeRequestFile(
  sourceGroup: string,
  requestId: string,
  body: Record<string, unknown>,
): { messagesDir: string; file: string } {
  const messagesDir = path.join(ipcBaseDir, sourceGroup, 'messages');
  fs.mkdirSync(messagesDir, { recursive: true });
  const file = `${requestId}.json`;
  fs.writeFileSync(path.join(messagesDir, file), JSON.stringify(body));
  return { messagesDir, file };
}

function readAck(
  sourceGroup: string,
  requestId: string,
): { status: string; error?: string; completedAt: string; requestId: string } {
  const ackPath = path.join(
    ipcBaseDir,
    sourceGroup,
    'acks',
    `${requestId}.json`,
  );
  expect(fs.existsSync(ackPath)).toBe(true);
  return JSON.parse(fs.readFileSync(ackPath, 'utf-8'));
}

beforeEach(() => {
  _initTestDatabase();
  ipcBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-ipc-test-'));
});

afterEach(() => {
  fs.rmSync(ipcBaseDir, { recursive: true, force: true });
});

describe('writeIpcAck', () => {
  it('writes an atomic success ack under {sourceGroup}/acks/', () => {
    writeIpcAck(ipcBaseDir, 'whatsapp_main', 'req-1', 'success');
    const ack = readAck('whatsapp_main', 'req-1');
    expect(ack.status).toBe('success');
    expect(ack.requestId).toBe('req-1');
    expect(ack.completedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // Ensure no .tmp file left behind
    const files = fs.readdirSync(
      path.join(ipcBaseDir, 'whatsapp_main', 'acks'),
    );
    expect(files.some((f) => f.endsWith('.tmp'))).toBe(false);
  });

  it('includes the error message when status is error', () => {
    writeIpcAck(ipcBaseDir, 'other-group', 'req-2', 'error', 'channel offline');
    const ack = readAck('other-group', 'req-2');
    expect(ack.status).toBe('error');
    expect(ack.error).toBe('channel offline');
  });
});

describe('processIpcMessageFile — ack on success', () => {
  it('writes a success ack when the send completes', async () => {
    const sourceGroup = 'whatsapp_main';
    const requestId = 'req-success';
    const { messagesDir, file } = writeRequestFile(sourceGroup, requestId, {
      type: 'message',
      chatJid: 'main@g.us',
      text: 'hello',
      requestId,
    });

    let sendCalled = false;
    const deps = makeDeps({
      sendMessage: async () => {
        sendCalled = true;
      },
      registeredGroups: () => ({ 'main@g.us': MAIN_GROUP }),
    });

    await processIpcMessageFile(
      ipcBaseDir,
      messagesDir,
      file,
      sourceGroup,
      /* isMain */ true,
      { 'main@g.us': MAIN_GROUP },
      deps,
    );

    expect(sendCalled).toBe(true);

    // Ack exists and is a success ack
    const ack = readAck(sourceGroup, requestId);
    expect(ack.status).toBe('success');
    expect(ack.requestId).toBe(requestId);

    // Original request file removed
    expect(fs.existsSync(path.join(messagesDir, file))).toBe(false);
  });
});

describe('processIpcMessageFile — ack on send failure', () => {
  it('writes an error ack when deps.sendMessage throws', async () => {
    const sourceGroup = 'whatsapp_main';
    const requestId = 'req-fail';
    const { messagesDir, file } = writeRequestFile(sourceGroup, requestId, {
      type: 'message',
      chatJid: 'main@g.us',
      text: 'hello',
      requestId,
    });

    const deps = makeDeps({
      sendMessage: async () => {
        throw new Error('network down');
      },
      registeredGroups: () => ({ 'main@g.us': MAIN_GROUP }),
    });

    await processIpcMessageFile(
      ipcBaseDir,
      messagesDir,
      file,
      sourceGroup,
      /* isMain */ true,
      { 'main@g.us': MAIN_GROUP },
      deps,
    );

    const ack = readAck(sourceGroup, requestId);
    expect(ack.status).toBe('error');
    expect(ack.error).toBe('network down');

    // Request file still removed (we handled it — it's not in errors/)
    expect(fs.existsSync(path.join(messagesDir, file))).toBe(false);
    const errorsDir = path.join(ipcBaseDir, 'errors');
    // errors/ is only populated by the outer catch for malformed requests
    expect(fs.existsSync(errorsDir)).toBe(false);
  });
});

describe('processIpcMessageFile — ack on unauthorized send', () => {
  it('writes an error ack when the source group cannot send to the target', async () => {
    const sourceGroup = 'other-group';
    const requestId = 'req-unauth';
    // "other-group" is trying to send to main@g.us, which belongs to a
    // different group (whatsapp_main). Non-main and not the target's folder.
    const { messagesDir, file } = writeRequestFile(sourceGroup, requestId, {
      type: 'message',
      chatJid: 'main@g.us',
      text: 'hello',
      requestId,
    });

    let sendCalled = false;
    const registered: Record<string, RegisteredGroup> = {
      'main@g.us': MAIN_GROUP,
      'other@g.us': OTHER_GROUP,
    };
    const deps = makeDeps({
      sendMessage: async () => {
        sendCalled = true;
      },
      registeredGroups: () => registered,
    });

    await processIpcMessageFile(
      ipcBaseDir,
      messagesDir,
      file,
      sourceGroup,
      /* isMain */ false,
      registered,
      deps,
    );

    expect(sendCalled).toBe(false);

    const ack = readAck(sourceGroup, requestId);
    expect(ack.status).toBe('error');
    expect(ack.error).toMatch(/Unauthorized/);
  });
});

describe('processIpcMessageFile — requestId fallback', () => {
  it('falls back to filename stem when payload omits requestId', async () => {
    const sourceGroup = 'whatsapp_main';
    const fileStem = 'legacy-req-123';
    const { messagesDir, file } = writeRequestFile(sourceGroup, fileStem, {
      type: 'message',
      chatJid: 'main@g.us',
      text: 'hi',
      // no requestId field
    });

    const deps = makeDeps({
      sendMessage: async () => {},
      registeredGroups: () => ({ 'main@g.us': MAIN_GROUP }),
    });

    await processIpcMessageFile(
      ipcBaseDir,
      messagesDir,
      file,
      sourceGroup,
      true,
      { 'main@g.us': MAIN_GROUP },
      deps,
    );

    // Ack file is named after the filename stem
    const ack = readAck(sourceGroup, fileStem);
    expect(ack.status).toBe('success');
    expect(ack.requestId).toBe(fileStem);
  });
});
