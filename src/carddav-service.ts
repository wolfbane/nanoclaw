/**
 * Host-side CardDAV service for iCloud contacts.
 *
 * Sibling to src/caldav-service.ts: same host-side-service pattern
 * (credentials on the host, container gets a URL), different protocol.
 * Read-only for v1 — surfacing contacts to the agent is the common case;
 * writes can be added later if requested.
 */
import { createServer, IncomingMessage, Server, ServerResponse } from 'http';
import { URL } from 'url';

import { DAVAddressBook, DAVClient, DAVObject } from 'tsdav';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

type LoginStatus = 'pending' | 'ok' | 'failed';

interface ContactSummary {
  url: string;
  etag?: string;
  uid?: string;
  full_name: string;
  organization?: string;
  title?: string;
  phones: { type?: string; value: string }[];
  emails: { type?: string; value: string }[];
  birthday?: string;
  notes?: string;
}

const LOGIN_RETRY_INTERVAL_MS = 60_000;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function extractDisplayName(book: DAVAddressBook): string {
  const dn = book.displayName;
  if (typeof dn === 'string') return dn;
  if (dn && typeof dn === 'object' && '_cdata' in dn) {
    return String((dn as { _cdata: string })._cdata);
  }
  return '';
}

// Minimal vCard 3.0/4.0 line parser. Handles folded lines (RFC 6350 §3.2)
// and unescapes \n, \,, \;, \\. We only extract fields the agent actually uses.
function unfoldLines(raw: string): string[] {
  const lines = raw.split(/\r?\n/);
  const out: string[] = [];
  for (const line of lines) {
    if (line.startsWith(' ') || line.startsWith('\t')) {
      if (out.length === 0) continue;
      out[out.length - 1] += line.slice(1);
    } else {
      out.push(line);
    }
  }
  return out;
}

function unescapeVCardText(s: string): string {
  return s
    .replace(/\\n/gi, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\');
}

function parseVCardLine(line: string): {
  key: string;
  params: Record<string, string>;
  value: string;
} | null {
  const colonIdx = line.indexOf(':');
  if (colonIdx < 0) return null;
  const header = line.slice(0, colonIdx);
  const value = line.slice(colonIdx + 1);
  const parts = header.split(';');
  const key = parts[0].toUpperCase();
  const params: Record<string, string> = {};
  for (let i = 1; i < parts.length; i++) {
    const eq = parts[i].indexOf('=');
    if (eq < 0) {
      // bare param like "HOME" (vCard 2.1 style)
      params['TYPE'] = (params['TYPE'] ? params['TYPE'] + ',' : '') + parts[i];
    } else {
      params[parts[i].slice(0, eq).toUpperCase()] = parts[i].slice(eq + 1);
    }
  }
  return { key, params, value };
}

function pickType(params: Record<string, string>): string | undefined {
  const t = params['TYPE'];
  if (!t) return undefined;
  // First tag is usually the most specific (e.g. "CELL,VOICE" → "CELL").
  const first = t.split(',')[0].trim();
  return first ? first.toLowerCase() : undefined;
}

function parseVCard(raw: string): ContactSummary | null {
  const lines = unfoldLines(raw);
  if (!lines.some((l) => l.trim().toUpperCase() === 'BEGIN:VCARD')) return null;

  const contact: ContactSummary = {
    url: '',
    full_name: '',
    phones: [],
    emails: [],
  };

  for (const line of lines) {
    const parsed = parseVCardLine(line);
    if (!parsed) continue;
    const { key, params, value } = parsed;
    const decoded = unescapeVCardText(value);
    switch (key) {
      case 'FN':
        if (!contact.full_name) contact.full_name = decoded;
        break;
      case 'N':
        // Structured name "Family;Given;Additional;Prefix;Suffix".
        // Only use it as a fallback when FN is missing.
        if (!contact.full_name) {
          const parts = decoded.split(';').map((s) => s.trim());
          const [family, given] = parts;
          contact.full_name = [given, family].filter(Boolean).join(' ');
        }
        break;
      case 'TEL':
        contact.phones.push({ type: pickType(params), value: decoded });
        break;
      case 'EMAIL':
        contact.emails.push({ type: pickType(params), value: decoded });
        break;
      case 'ORG':
        contact.organization = decoded.split(';')[0].trim();
        break;
      case 'TITLE':
        contact.title = decoded;
        break;
      case 'BDAY':
        contact.birthday = decoded;
        break;
      case 'NOTE':
        contact.notes = decoded;
        break;
      case 'UID':
        contact.uid = decoded;
        break;
    }
  }

  return contact.full_name || contact.phones.length || contact.emails.length
    ? contact
    : null;
}

function parseContactsFromObjects(objects: DAVObject[]): ContactSummary[] {
  const contacts: ContactSummary[] = [];
  for (const obj of objects) {
    if (!obj.data || typeof obj.data !== 'string') continue;
    try {
      const contact = parseVCard(obj.data);
      if (!contact) continue;
      contact.url = obj.url;
      contact.etag = obj.etag;
      contacts.push(contact);
    } catch (err) {
      logger.warn({ url: obj.url, err }, 'Failed to parse vCard');
    }
  }
  return contacts;
}

function normalizeForSearch(s: string): string {
  return s.toLowerCase().replace(/[\s().+-]/g, '');
}

function matchesQuery(c: ContactSummary, q: string): boolean {
  if (!q) return true;
  const needle = q.toLowerCase().trim();
  if (c.full_name.toLowerCase().includes(needle)) return true;
  if (c.organization?.toLowerCase().includes(needle)) return true;
  if (c.notes?.toLowerCase().includes(needle)) return true;
  const normNeedle = normalizeForSearch(needle);
  if (normNeedle.length >= 4) {
    for (const p of c.phones) {
      if (normalizeForSearch(p.value).includes(normNeedle)) return true;
    }
  }
  for (const e of c.emails) {
    if (e.value.toLowerCase().includes(needle)) return true;
  }
  return false;
}

export async function startCarddavService(
  port: number,
  host: string,
): Promise<Server | null> {
  const secrets = readEnvFile(['ICLOUD_APPLE_ID', 'ICLOUD_APP_PASSWORD']);
  if (!secrets.ICLOUD_APPLE_ID || !secrets.ICLOUD_APP_PASSWORD) {
    logger.info(
      'CardDAV service disabled: ICLOUD_APPLE_ID and ICLOUD_APP_PASSWORD must both be set in .env',
    );
    return null;
  }

  const client = new DAVClient({
    serverUrl: 'https://contacts.icloud.com',
    credentials: {
      username: secrets.ICLOUD_APPLE_ID,
      password: secrets.ICLOUD_APP_PASSWORD,
    },
    authMethod: 'Basic',
    defaultAccountType: 'carddav',
  });

  let loginStatus: LoginStatus = 'pending';
  let lastError: string | undefined;

  // Address books + contact cache. iCloud address books rarely change within a
  // single session; a short TTL keeps search cheap without risking staleness.
  const CONTACTS_TTL_MS = 5 * 60 * 1000;
  let addressBooks: DAVAddressBook[] = [];
  let cachedContacts: ContactSummary[] | null = null;
  let cachedAt = 0;

  const attemptLogin = async (): Promise<void> => {
    try {
      await client.login();
      addressBooks = await client.fetchAddressBooks();
      loginStatus = 'ok';
      lastError = undefined;
      logger.info({ count: addressBooks.length }, 'CardDAV login succeeded');
    } catch (err) {
      loginStatus = 'failed';
      const msg = err instanceof Error ? err.message : String(err);
      lastError = msg;
      if (/401|unauthorized/i.test(msg)) {
        logger.error(
          { err: msg },
          'CardDAV login failed (401). Regenerate the app-specific password at appleid.apple.com and update ICLOUD_APP_PASSWORD in .env.',
        );
      } else {
        logger.warn({ err: msg }, 'CardDAV login failed — will retry');
      }
    }
  };

  await attemptLogin();
  const retryTimer = setInterval(() => {
    if (loginStatus !== 'ok') void attemptLogin();
  }, LOGIN_RETRY_INTERVAL_MS);
  retryTimer.unref();

  const loadAllContacts = async (force = false): Promise<ContactSummary[]> => {
    const now = Date.now();
    if (!force && cachedContacts && now - cachedAt < CONTACTS_TTL_MS) {
      return cachedContacts;
    }
    const all: ContactSummary[] = [];
    for (const book of addressBooks) {
      const objects = await client.fetchVCards({ addressBook: book });
      all.push(...parseContactsFromObjects(objects));
    }
    cachedContacts = all;
    cachedAt = now;
    return all;
  };

  const handle = async (
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<number> => {
    const requestUrl = new URL(req.url || '/', `http://${host}:${port}`);
    const pathname = requestUrl.pathname;
    const method = req.method || 'GET';

    if (method === 'GET' && pathname === '/health') {
      sendJson(res, 200, {
        ok: loginStatus === 'ok',
        loginStatus,
        lastError,
        addressBooks: addressBooks.length,
        cachedContacts: cachedContacts?.length ?? null,
      });
      return 200;
    }

    if (loginStatus !== 'ok') {
      sendJson(res, 503, {
        error: `CardDAV not ready (loginStatus=${loginStatus})${lastError ? `: ${lastError}` : ''}`,
      });
      return 503;
    }

    if (method === 'GET' && pathname === '/address-books') {
      sendJson(res, 200, {
        address_books: addressBooks.map((b) => ({
          url: b.url,
          displayName: extractDisplayName(b),
          description: b.description,
        })),
      });
      return 200;
    }

    if (method === 'GET' && pathname === '/contacts') {
      const q = requestUrl.searchParams.get('q') || '';
      const limit = Math.min(
        500,
        Math.max(1, parseInt(requestUrl.searchParams.get('limit') || '50', 10)),
      );
      const all = await loadAllContacts();
      const filtered = q ? all.filter((c) => matchesQuery(c, q)) : all;
      // Stable ordering: FN asc, then url.
      filtered.sort((a, b) => {
        const an = a.full_name || '';
        const bn = b.full_name || '';
        if (an !== bn) return an.localeCompare(bn);
        return a.url.localeCompare(b.url);
      });
      sendJson(res, 200, {
        total: filtered.length,
        returned: Math.min(limit, filtered.length),
        contacts: filtered.slice(0, limit),
      });
      return 200;
    }

    if (method === 'POST' && pathname === '/refresh') {
      await attemptLogin();
      cachedContacts = null;
      sendJson(res, 200, {
        ok: true,
        addressBooks: addressBooks.length,
        loginStatus,
      });
      return 200;
    }

    sendJson(res, 404, { error: 'not found' });
    return 404;
  };

  const server = createServer((req, res) => {
    const method = req.method || 'GET';
    const path = (req.url || '/').split('?')[0];
    handle(req, res)
      .then((status) => {
        logger.debug({ method, path, status }, 'carddav-service request');
        if (status === 401 || status === 403) {
          logger.error(
            { method, path, status },
            'CardDAV upstream rejected request — app-specific password may be revoked',
          );
        }
      })
      .catch((err) => {
        logger.error(
          { method, path, err: err instanceof Error ? err.message : err },
          'carddav-service handler error',
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

  server.on('close', () => clearInterval(retryTimer));

  return new Promise((resolve, reject) => {
    server.listen(port, host, () => {
      logger.info({ host, port, loginStatus }, 'CardDAV service started');
      resolve(server);
    });
    server.on('error', reject);
  });
}
