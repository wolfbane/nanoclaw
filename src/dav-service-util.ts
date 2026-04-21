import { createServer, IncomingMessage, Server, ServerResponse } from 'http';

import { DAVClient } from 'tsdav';

import { readEnvFile } from './env.js';
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

const RETRY_INTERVAL_MS = 60_000;

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
  }, RETRY_INTERVAL_MS);
  retryTimer.unref();

  return {
    attemptLogin,
    getStatus: () => status,
    getLastError: () => lastError,
    getResources: () => resources,
    stop: () => clearInterval(retryTimer),
  };
}

export interface ICloudDavServiceContext<R> {
  client: DAVClient;
  loginManager: DavLoginManager<R>;
}

// Handlers only read pathname/searchParams from the request URL, so any
// well-formed base satisfies the URL constructor.
export const REQUEST_URL_BASE = 'http://dav';

export async function startICloudDavService<R>(opts: {
  serviceName: string;
  serverUrl: string;
  accountType: 'caldav' | 'carddav';
  port: number;
  host: string;
  fetchResources: (client: DAVClient) => Promise<R>;
  initialResources: R;
  buildHandler: (
    ctx: ICloudDavServiceContext<R>,
  ) => (req: IncomingMessage, res: ServerResponse) => Promise<number>;
}): Promise<Server | null> {
  const secrets = readEnvFile(['ICLOUD_APPLE_ID', 'ICLOUD_APP_PASSWORD']);
  if (!secrets.ICLOUD_APPLE_ID || !secrets.ICLOUD_APP_PASSWORD) {
    logger.info(
      `${opts.serviceName} service disabled: ICLOUD_APPLE_ID and ICLOUD_APP_PASSWORD must both be set in .env`,
    );
    return null;
  }

  const client = new DAVClient({
    serverUrl: opts.serverUrl,
    credentials: {
      username: secrets.ICLOUD_APPLE_ID,
      password: secrets.ICLOUD_APP_PASSWORD,
    },
    authMethod: 'Basic',
    defaultAccountType: opts.accountType,
  });

  const loginManager = createDavLoginManager<R>({
    client,
    serviceName: opts.serviceName,
    fetchResources: () => opts.fetchResources(client),
    initialResources: opts.initialResources,
  });

  const handle = opts.buildHandler({ client, loginManager });
  const server = createDavHttpServer(opts.serviceName, handle);
  server.on('close', () => loginManager.stop());

  // Start listening before awaiting login so containers that spawn during
  // the ~3–5s iCloud login don't hit ECONNREFUSED. The handler already
  // returns 503 while loginStatus !== 'ok'.
  await new Promise<void>((resolve, reject) => {
    server.listen(opts.port, opts.host, () => resolve());
    server.on('error', reject);
  });
  logger.info(
    { host: opts.host, port: opts.port },
    `${opts.serviceName} service listening`,
  );
  void loginManager.attemptLogin();

  return server;
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
