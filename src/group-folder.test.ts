import fs from 'fs';
import path from 'path';

import { describe, expect, it } from 'vitest';

import {
  hasPendingIpcInput,
  isValidGroupFolder,
  resolveGroupFolderPath,
  resolveGroupIpcPath,
} from './group-folder.js';

describe('group folder validation', () => {
  it('accepts normal group folder names', () => {
    expect(isValidGroupFolder('main')).toBe(true);
    expect(isValidGroupFolder('family-chat')).toBe(true);
    expect(isValidGroupFolder('Team_42')).toBe(true);
  });

  it('rejects traversal and reserved names', () => {
    expect(isValidGroupFolder('../../etc')).toBe(false);
    expect(isValidGroupFolder('/tmp')).toBe(false);
    expect(isValidGroupFolder('global')).toBe(false);
    expect(isValidGroupFolder('')).toBe(false);
  });

  it('resolves safe paths under groups directory', () => {
    const resolved = resolveGroupFolderPath('family-chat');
    expect(resolved.endsWith(`${path.sep}groups${path.sep}family-chat`)).toBe(
      true,
    );
  });

  it('resolves safe paths under data ipc directory', () => {
    const resolved = resolveGroupIpcPath('family-chat');
    expect(
      resolved.endsWith(`${path.sep}data${path.sep}ipc${path.sep}family-chat`),
    ).toBe(true);
  });

  it('throws for unsafe folder names', () => {
    expect(() => resolveGroupFolderPath('../../etc')).toThrow();
    expect(() => resolveGroupIpcPath('/tmp')).toThrow();
  });
});

describe('hasPendingIpcInput', () => {
  const folder = 'test_3q4_pending_tmp';
  const inputDir = path.join(resolveGroupIpcPath(folder), 'input');

  it('is false for invalid folders and when the input dir is absent', () => {
    expect(hasPendingIpcInput('../../etc')).toBe(false);
    fs.rmSync(resolveGroupIpcPath(folder), { recursive: true, force: true });
    expect(hasPendingIpcInput(folder)).toBe(false);
  });

  it('detects a pending .json message and ignores non-json/empty', () => {
    try {
      fs.mkdirSync(inputDir, { recursive: true });
      expect(hasPendingIpcInput(folder)).toBe(false); // empty dir
      fs.writeFileSync(path.join(inputDir, '_close'), ''); // sentinel, not .json
      expect(hasPendingIpcInput(folder)).toBe(false);
      fs.writeFileSync(path.join(inputDir, 'msg-1.json'), '{}');
      expect(hasPendingIpcInput(folder)).toBe(true);
    } finally {
      fs.rmSync(resolveGroupIpcPath(folder), { recursive: true, force: true });
    }
  });
});
