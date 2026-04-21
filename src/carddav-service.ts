/**
 * Host-side CardDAV service for iCloud contacts. Read-only. Same
 * host-side-service pattern as src/caldav-service.ts.
 */
import { IncomingMessage, Server, ServerResponse } from 'http';
import { URL } from 'url';

import { DAVAddressBook, DAVClient, DAVObject } from 'tsdav';

import {
  DavLoginManager,
  REQUEST_URL_BASE,
  extractDisplayName,
  sendJson,
  startICloudDavService,
} from './dav-service-util.js';
import { logger } from './logger.js';

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

// Minimal vCard 3.0/4.0 parser: handles folded lines (RFC 6350 §3.2) and
// unescapes \n, \,, \;, \\. Only fields the agent consumes are extracted.
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
  const contact: ContactSummary = {
    url: '',
    full_name: '',
    phones: [],
    emails: [],
  };
  let sawBegin = false;

  for (const line of unfoldLines(raw)) {
    const parsed = parseVCardLine(line);
    if (!parsed) continue;
    const { key, params, value } = parsed;
    if (key === 'BEGIN' && value.toUpperCase() === 'VCARD') {
      sawBegin = true;
      continue;
    }
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

  if (!sawBegin) return null;
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

interface ParsedQuery {
  needle: string;
  normNeedle: string;
}

function prepareQuery(q: string): ParsedQuery | null {
  const needle = q.toLowerCase().trim();
  if (!needle) return null;
  return { needle, normNeedle: normalizeForSearch(needle) };
}

function matchesQuery(c: ContactSummary, q: ParsedQuery): boolean {
  const { needle, normNeedle } = q;
  if (c.full_name.toLowerCase().includes(needle)) return true;
  if (c.organization?.toLowerCase().includes(needle)) return true;
  if (c.notes?.toLowerCase().includes(needle)) return true;
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

function compareContacts(a: ContactSummary, b: ContactSummary): number {
  const an = a.full_name || '';
  const bn = b.full_name || '';
  if (an !== bn) return an.localeCompare(bn);
  return a.url.localeCompare(b.url);
}

export function startCarddavService(
  port: number,
  host: string,
): Promise<Server | null> {
  return startICloudDavService<DAVAddressBook[]>({
    serviceName: 'CardDAV',
    serverUrl: 'https://contacts.icloud.com',
    accountType: 'carddav',
    port,
    host,
    fetchResources: (client) => client.fetchAddressBooks(),
    initialResources: [],
    buildHandler: buildCarddavHandler,
  });
}

// 5-minute cache is a compromise between search latency and visibility of
// contacts added on another device mid-session.
const CONTACTS_TTL_MS = 5 * 60 * 1000;

function buildCarddavHandler({
  client,
  loginManager,
}: {
  client: DAVClient;
  loginManager: DavLoginManager<DAVAddressBook[]>;
}): (req: IncomingMessage, res: ServerResponse) => Promise<number> {
  let cachedContacts: ContactSummary[] | null = null;
  let cachedAt = 0;
  let inFlight: Promise<ContactSummary[]> | null = null;

  const loadAllContacts = async (): Promise<ContactSummary[]> => {
    if (cachedContacts && Date.now() - cachedAt < CONTACTS_TTL_MS) {
      return cachedContacts;
    }
    if (inFlight) return inFlight;
    inFlight = (async () => {
      const perBook = await Promise.all(
        loginManager
          .getResources()
          .map((book) => client.fetchVCards({ addressBook: book })),
      );
      const all = perBook.flatMap(parseContactsFromObjects);
      all.sort(compareContacts);
      cachedContacts = all;
      cachedAt = Date.now();
      return all;
    })().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };

  return async (req: IncomingMessage, res: ServerResponse): Promise<number> => {
    const requestUrl = new URL(req.url || '/', REQUEST_URL_BASE);
    const pathname = requestUrl.pathname;
    const method = req.method || 'GET';
    const loginStatus = loginManager.getStatus();
    const lastError = loginManager.getLastError();
    const addressBooks = loginManager.getResources();

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
      const query = prepareQuery(q);
      const filtered = query ? all.filter((c) => matchesQuery(c, query)) : all;
      sendJson(res, 200, {
        total: filtered.length,
        returned: Math.min(limit, filtered.length),
        contacts: filtered.slice(0, limit),
      });
      return 200;
    }

    if (method === 'POST' && pathname === '/refresh') {
      await loginManager.attemptLogin();
      cachedContacts = null;
      const postStatus = loginManager.getStatus();
      sendJson(res, 200, {
        ok: postStatus === 'ok',
        loginStatus: postStatus,
        addressBooks: loginManager.getResources().length,
      });
      return 200;
    }

    sendJson(res, 404, { error: 'not found' });
    return 404;
  };
}
