import { createServer, IncomingMessage, Server, ServerResponse } from 'http';

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
    return String(dn._cdata);
  }
  return '';
}

export type LoginStatus = 'pending' | 'ok' | 'failed';

export interface DavLoginManager<R> {
  attemptLogin(): Promise<void>;
  getStatus(): LoginStatus;
  getLastError(): string | undefined;
  getResources(): R;
  stop(): void;
}

const DEFAULT_RETRY_INTERVAL_MS = 60_000;

export function createDavLoginManager<R>(opts: {
  client: DAVClient;
  serviceName: string;
  fetchResources: () => Promise<R>;
  initialResources: R;
  retryIntervalMs?: number;
}): DavLoginManager<R> {
  let status: LoginStatus = 'pending';
  let lastError: string | undefined;
  let resources: R = opts.initialResources;
  let inFlight: Promise<void> | null = null;

  const run = async (): Promise<void> => {
    const prevStatus = status;
    try {
      await opts.client.login();
      resources = await opts.fetchResources();
      status = 'ok';
      lastError = undefined;
      if (prevStatus !== 'ok') {
        logger.info(`${opts.serviceName} login succeeded`);
      }
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

  const attemptLogin = (): Promise<void> => {
    if (inFlight) return inFlight;
    inFlight = run().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };

  const retryTimer = setInterval(() => {
    if (status !== 'ok') void attemptLogin();
  }, opts.retryIntervalMs ?? DEFAULT_RETRY_INTERVAL_MS);
  retryTimer.unref();

  return {
    attemptLogin,
    getStatus: () => status,
    getLastError: () => lastError,
    getResources: () => resources,
    stop: () => clearInterval(retryTimer),
  };
}

export function createDavHttpServer(
  serviceName: string,
  handle: (req: IncomingMessage, res: ServerResponse) => Promise<number>,
): Server {
  const logPrefix = `${serviceName.toLowerCase()}-service`;
  return createServer((req, res) => {
    const method = req.method || 'GET';
    const path = (req.url || '/').split('?')[0];
    handle(req, res)
      .then((status) => {
        logger.debug({ method, path, status }, `${logPrefix} request`);
        if (status === 401 || status === 403) {
          logger.error(
            { method, path, status },
            `${serviceName} upstream rejected request — app-specific password may be revoked`,
          );
        }
      })
      .catch((err) => {
        logger.error(
          { method, path, err: err instanceof Error ? err.message : err },
          `${logPrefix} handler error`,
        );
        if (!res.headersSent) {
          sendJson(res, 500, {
            error: err instanceof Error ? err.message : String(err),
          });
        } else {
          res.end();
        }
      });
  });
}
