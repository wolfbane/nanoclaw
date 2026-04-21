import { IncomingMessage, ServerResponse } from 'http';

import type { DAVClient } from 'tsdav';

import { logger } from './logger.js';

export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

export async function readJsonBody<T>(req: IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8');
      if (!raw) return resolve({} as T);
      try {
        resolve(JSON.parse(raw) as T);
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

export function extractDisplayName(o: { displayName?: unknown }): string {
  const dn = o.displayName;
  if (typeof dn === 'string') return dn;
  if (dn && typeof dn === 'object' && '_cdata' in dn) {
    return String((dn as { _cdata: unknown })._cdata);
  }
  return '';
}

export type LoginStatus = 'pending' | 'ok' | 'failed';

export interface DavLoginManager<R> {
  attemptLogin(): Promise<void>;
  getStatus(): LoginStatus;
  getLastError(): string | undefined;
  getResources(): R;
}

export function createDavLoginManager<R>(opts: {
  client: DAVClient;
  serviceName: string;
  fetchResources: () => Promise<R>;
  initialResources: R;
}): DavLoginManager<R> {
  let status: LoginStatus = 'pending';
  let lastError: string | undefined;
  let resources: R = opts.initialResources;
  let inFlight: Promise<void> | null = null;

  const run = async (): Promise<void> => {
    try {
      await opts.client.login();
      resources = await opts.fetchResources();
      status = 'ok';
      lastError = undefined;
      logger.info(`${opts.serviceName} login succeeded`);
    } catch (err) {
      status = 'failed';
      const msg = err instanceof Error ? err.message : String(err);
      lastError = msg;
      if (/401|unauthorized/i.test(msg)) {
        logger.error(
          { err: msg },
          `${opts.serviceName} login failed (401). Regenerate the app-specific password at appleid.apple.com and update ICLOUD_APP_PASSWORD in .env.`,
        );
      } else {
        logger.warn(
          { err: msg },
          `${opts.serviceName} login failed — will retry`,
        );
      }
    }
  };

  return {
    attemptLogin(): Promise<void> {
      if (inFlight) return inFlight;
      inFlight = run().finally(() => {
        inFlight = null;
      });
      return inFlight;
    },
    getStatus: () => status,
    getLastError: () => lastError,
    getResources: () => resources,
  };
}
