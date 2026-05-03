/**
 * Host-side CardDAV service for iCloud contacts. Same host-side-service
 * pattern as src/caldav-service.ts.
 */
import { IncomingMessage, Server, ServerResponse } from 'http';
import { URL } from 'url';

import { DAVAddressBook, DAVClient, DAVObject } from 'tsdav';

import {
  DavLoginManager,
  REQUEST_URL_BASE,
  davFilename,
  escapeDavText,
  extractDisplayName,
  findResourceByUrl,
  findResourceOwningUrl,
  generateDavUid,
  joinDavUrl,
  readJsonBodyOr400,
  sendJson,
  startICloudDavService,
} from './dav-service-util.js';
import { logger } from './logger.js';

interface ContactPhoneOrEmail {
  type?: string;
  value: string;
}

// Family;Given;Additional;Prefix;Suffix per RFC 6350 §6.2.2.
type NComponents = [string, string, string, string, string];

interface ContactSummary {
  url: string;
  etag?: string;
  uid?: string;
  full_name: string;
  given_name?: string;
  family_name?: string;
  n_components?: NComponents;
  organization?: string;
  title?: string;
  phones: ContactPhoneOrEmail[];
  emails: ContactPhoneOrEmail[];
  birthday?: string;
  notes?: string;
}

interface CreateContactBody {
  address_book_url: string;
  full_name: string;
  given_name?: string;
  family_name?: string;
  organization?: string;
  title?: string;
  phones?: ContactPhoneOrEmail[];
  emails?: ContactPhoneOrEmail[];
  birthday?: string;
  notes?: string;
}

interface UpdateContactBody {
  object_url: string;
  full_name?: string;
  given_name?: string | null;
  family_name?: string | null;
  organization?: string | null;
  title?: string | null;
  phones?: ContactPhoneOrEmail[];
  emails?: ContactPhoneOrEmail[];
  birthday?: string | null;
  notes?: string | null;
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

// Single-pass to avoid the regex-chain reorder bug: /\\n/ would match the
// "\n" inside "\\n" before "\\" collapses, mis-decoding to "\" + newline.
function unescapeDavText(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length) {
      const next = s[i + 1];
      out += next === 'n' || next === 'N' ? '\n' : next;
      i++;
    } else {
      out += c;
    }
  }
  return out;
}

// Split a structured value (e.g. N) on unescaped ";". Each component is then
// unescaped on its own, so a literal ";" inside a component round-trips
// correctly.
function splitStructuredValue(raw: string): string[] {
  const out: string[] = [];
  let cur = '';
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === '\\' && i + 1 < raw.length) {
      cur += c + raw[i + 1];
      i++;
    } else if (c === ';') {
      out.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out.map(unescapeDavText);
}

function toFiveComponents(parts: string[]): NComponents {
  const padded: string[] = [...parts];
  while (padded.length < 5) padded.push('');
  return [padded[0], padded[1], padded[2], padded[3], padded[4]];
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
    const decoded = unescapeDavText(value);
    switch (key) {
      case 'FN':
        if (!contact.full_name) contact.full_name = decoded;
        break;
      case 'N': {
        // Structured name "Family;Given;Additional;Prefix;Suffix". Split on
        // the raw value so escaped ";" inside a component is preserved.
        const components = toFiveComponents(splitStructuredValue(value));
        contact.n_components = components;
        const [family, given] = components;
        if (family) contact.family_name = family;
        if (given) contact.given_name = given;
        if (!contact.full_name) {
          contact.full_name = [given, family].filter(Boolean).join(' ');
        }
        break;
      }
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

// vCard params live before the ":" and are delimited by ";" / ",". Anything
// outside [A-Za-z0-9-] is dropped to prevent a user-supplied label like
// `cell:INJECTED` from breaking out of the TYPE parameter.
function sanitizeTypeParam(type: string): string {
  return type.replace(/[^A-Za-z0-9-]/g, '').toUpperCase();
}

function buildVCard(data: {
  uid: string;
  full_name: string;
  n_components?: NComponents;
  organization?: string;
  title?: string;
  phones?: ContactPhoneOrEmail[];
  emails?: ContactPhoneOrEmail[];
  birthday?: string;
  notes?: string;
}): string {
  const lines: string[] = [
    'BEGIN:VCARD',
    'VERSION:3.0',
    `UID:${escapeDavText(data.uid)}`,
    `FN:${escapeDavText(data.full_name)}`,
  ];
  if (data.n_components && data.n_components.some((c) => c !== '')) {
    lines.push(`N:${data.n_components.map(escapeDavText).join(';')}`);
  }
  if (data.organization) {
    lines.push(`ORG:${escapeDavText(data.organization)}`);
  }
  if (data.title) {
    lines.push(`TITLE:${escapeDavText(data.title)}`);
  }
  for (const p of data.phones ?? []) {
    if (!p.value) continue;
    const t = p.type ? sanitizeTypeParam(p.type) : '';
    lines.push(`TEL${t ? `;TYPE=${t}` : ''}:${escapeDavText(p.value)}`);
  }
  for (const e of data.emails ?? []) {
    if (!e.value) continue;
    const t = e.type ? sanitizeTypeParam(e.type) : '';
    lines.push(`EMAIL${t ? `;TYPE=${t}` : ''}:${escapeDavText(e.value)}`);
  }
  if (data.birthday) {
    lines.push(`BDAY:${escapeDavText(data.birthday)}`);
  }
  if (data.notes) {
    lines.push(`NOTE:${escapeDavText(data.notes)}`);
  }
  lines.push('END:VCARD');
  return lines.join('\r\n') + '\r\n';
}

interface ScalarFieldSpec {
  name: string;
  required?: boolean;
  // null is accepted on PATCH ("clear this field"); rejected on POST.
  nullable?: boolean;
}

// Runtime guard for string-typed body fields. Without this, a non-string
// value would reach escapeDavText and surface as a 500.
function validateScalarFields(
  body: unknown,
  specs: ScalarFieldSpec[],
): { ok: true } | { ok: false; error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'body must be a JSON object' };
  }
  const obj = body as Record<string, unknown>;
  for (const { name, required, nullable } of specs) {
    const v = obj[name];
    if (v === undefined) {
      if (required) return { ok: false, error: `${name} is required` };
      continue;
    }
    if (v === null) {
      if (nullable) continue;
      return { ok: false, error: `${name} cannot be null` };
    }
    if (typeof v !== 'string') {
      return {
        ok: false,
        error: `${name} must be a ${nullable ? 'string or null' : 'string'}`,
      };
    }
    if (required && v.length === 0) {
      return { ok: false, error: `${name} must be non-empty` };
    }
  }
  return { ok: true };
}

const POST_CONTACT_SCALARS: ScalarFieldSpec[] = [
  { name: 'address_book_url', required: true },
  { name: 'full_name', required: true },
  { name: 'given_name' },
  { name: 'family_name' },
  { name: 'organization' },
  { name: 'title' },
  { name: 'birthday' },
  { name: 'notes' },
];

const PATCH_CONTACT_SCALARS: ScalarFieldSpec[] = [
  { name: 'object_url', required: true },
  { name: 'full_name' },
  { name: 'given_name', nullable: true },
  { name: 'family_name', nullable: true },
  { name: 'organization', nullable: true },
  { name: 'title', nullable: true },
  { name: 'birthday', nullable: true },
  { name: 'notes', nullable: true },
];

// undefined → caller didn't touch the field (PATCH preserves current);
// successful empty array → caller wants the list cleared.
type ValidatedArray =
  | { ok: true; value: ContactPhoneOrEmail[] | undefined }
  | { ok: false; error: string };

function validateContactArray(raw: unknown, field: string): ValidatedArray {
  if (raw === undefined) return { ok: true, value: undefined };
  if (!Array.isArray(raw)) {
    return { ok: false, error: `${field} must be an array` };
  }
  const out: ContactPhoneOrEmail[] = [];
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return { ok: false, error: `${field}[${i}] must be an object` };
    }
    const obj = item as Record<string, unknown>;
    if (typeof obj.value !== 'string') {
      return { ok: false, error: `${field}[${i}].value must be a string` };
    }
    if (obj.type !== undefined && typeof obj.type !== 'string') {
      return {
        ok: false,
        error: `${field}[${i}].type must be a string when present`,
      };
    }
    out.push({
      value: obj.value,
      ...(typeof obj.type === 'string' ? { type: obj.type } : {}),
    });
  }
  return { ok: true, value: out };
}

// `null` means "clear", `undefined` means "leave unchanged".
function mergeNullable<T>(
  incoming: T | null | undefined,
  current: T | undefined,
): T | undefined {
  if (incoming === null) return undefined;
  if (incoming === undefined) return current;
  return incoming;
}

// On create we derive N from the request fields. When given_name/family_name
// are not supplied, N is synthesised from full_name (see function body).
function nComponentsFromCreate(
  given_name: string | undefined,
  family_name: string | undefined,
  full_name: string,
): NComponents {
  // vCard 3.0 (RFC 2426 §3.1.2) requires N. iCloud rejects PUTs without it
  // with 403 Forbidden. When the caller provides given/family explicitly we
  // use them; otherwise derive from full_name by splitting on whitespace —
  // last token becomes family, everything before becomes given. Single-word
  // names go in family so the entry sorts naturally in Apple Contacts.
  if (given_name || family_name) {
    return [family_name ?? '', given_name ?? '', '', '', ''];
  }
  const parts = full_name.trim().split(/\s+/).filter((p) => p !== '');
  if (parts.length <= 1) return [parts[0] ?? '', '', '', '', ''];
  const family = parts.pop()!;
  return [family, parts.join(' '), '', '', ''];
}

// Only family/given come from the request; additional/prefix/suffix round-trip
// from the existing card so a PATCH that doesn't mention them doesn't clear them.
function mergeNComponents(
  body: { family_name?: string | null; given_name?: string | null },
  current: NComponents | undefined,
): NComponents | undefined {
  const base: NComponents = current ?? ['', '', '', '', ''];
  const family = mergeNullable(body.family_name, base[0]) ?? '';
  const given = mergeNullable(body.given_name, base[1]) ?? '';
  const merged: NComponents = [family, given, base[2], base[3], base[4]];
  return merged.some((c) => c !== '') ? merged : undefined;
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
  // Bumped on every mutation. Used for two things: (1) detach a stale
  // in-flight load so the next GET kicks off a fresh fetch instead of
  // awaiting one that started before the mutation, and (2) prevent the
  // detached load from writing its (now stale) snapshot to the cache.
  let cacheGeneration = 0;

  const invalidateCache = (): void => {
    cachedContacts = null;
    inFlight = null;
    cacheGeneration++;
  };

  const loadAllContacts = async (): Promise<ContactSummary[]> => {
    if (cachedContacts && Date.now() - cachedAt < CONTACTS_TTL_MS) {
      return cachedContacts;
    }
    if (inFlight) return inFlight;
    const startGeneration = cacheGeneration;
    const load = (async () => {
      const perBook = await Promise.all(
        loginManager
          .getResources()
          .map((book) => client.fetchVCards({ addressBook: book })),
      );
      const all = perBook.flatMap(parseContactsFromObjects);
      all.sort(compareContacts);
      if (cacheGeneration === startGeneration) {
        cachedContacts = all;
        cachedAt = Date.now();
      }
      return all;
    })().finally(() => {
      // Only clear the slot if it's still pointing at our load; an
      // invalidateCache() during the fetch will have already detached it
      // and possibly assigned a newer load there.
      if (inFlight === load) inFlight = null;
    });
    inFlight = load;
    return load;
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

    if (method === 'POST' && pathname === '/contacts') {
      const body = await readJsonBodyOr400<CreateContactBody>(req, res);
      if (!body) return 400;
      const scalars = validateScalarFields(body, POST_CONTACT_SCALARS);
      if (!scalars.ok) {
        sendJson(res, 400, { error: scalars.error });
        return 400;
      }
      const phones = validateContactArray(body.phones, 'phones');
      if (!phones.ok) {
        sendJson(res, 400, { error: phones.error });
        return 400;
      }
      const emails = validateContactArray(body.emails, 'emails');
      if (!emails.ok) {
        sendJson(res, 400, { error: emails.error });
        return 400;
      }
      const book = findResourceByUrl(addressBooks, body.address_book_url);
      if (!book) {
        sendJson(res, 404, {
          error: `address book not found: ${body.address_book_url}`,
        });
        return 404;
      }
      const uid = generateDavUid();
      const filename = davFilename(uid, 'vcf');
      const vCardString = buildVCard({
        uid,
        full_name: body.full_name,
        n_components: nComponentsFromCreate(
          body.given_name,
          body.family_name,
          body.full_name,
        ),
        organization: body.organization,
        title: body.title,
        phones: phones.value,
        emails: emails.value,
        birthday: body.birthday,
        notes: body.notes,
      });
      const response = await client.createVCard({
        addressBook: book,
        filename,
        vCardString,
      });
      if (!response.ok) {
        sendJson(res, 502, {
          error: `iCloud rejected create: ${response.status} ${response.statusText}`,
        });
        return 502;
      }
      invalidateCache();
      sendJson(res, 201, { url: joinDavUrl(book.url, filename), uid });
      return 201;
    }

    if (method === 'PATCH' && pathname === '/contacts') {
      const body = await readJsonBodyOr400<UpdateContactBody>(req, res);
      if (!body) return 400;
      const scalars = validateScalarFields(body, PATCH_CONTACT_SCALARS);
      if (!scalars.ok) {
        sendJson(res, 400, { error: scalars.error });
        return 400;
      }
      const phones = validateContactArray(body.phones, 'phones');
      if (!phones.ok) {
        sendJson(res, 400, { error: phones.error });
        return 400;
      }
      const emails = validateContactArray(body.emails, 'emails');
      if (!emails.ok) {
        sendJson(res, 400, { error: emails.error });
        return 400;
      }
      const book = findResourceOwningUrl(addressBooks, body.object_url);
      if (!book) {
        sendJson(res, 404, {
          error: `no address book owns url: ${body.object_url}`,
        });
        return 404;
      }
      const existing = await client.fetchVCards({
        addressBook: book,
        objectUrls: [body.object_url],
      });
      if (existing.length === 0) {
        sendJson(res, 404, {
          error: `contact not found: ${body.object_url}`,
        });
        return 404;
      }
      const current = parseContactsFromObjects(existing)[0];
      if (!current) {
        sendJson(res, 500, {
          error: 'failed to parse current contact for merge',
        });
        return 500;
      }
      const fullName = body.full_name ?? current.full_name;
      if (!fullName) {
        sendJson(res, 400, {
          error:
            'full_name is required for this update because the existing contact has no FN/N',
        });
        return 400;
      }
      const vCardString = buildVCard({
        uid: current.uid || generateDavUid(),
        full_name: fullName,
        n_components: mergeNComponents(body, current.n_components),
        organization: mergeNullable(body.organization, current.organization),
        title: mergeNullable(body.title, current.title),
        phones: phones.value ?? current.phones,
        emails: emails.value ?? current.emails,
        birthday: mergeNullable(body.birthday, current.birthday),
        notes: mergeNullable(body.notes, current.notes),
      });
      const response = await client.updateVCard({
        vCard: {
          url: body.object_url,
          etag: existing[0].etag,
          data: vCardString,
        },
      });
      if (!response.ok) {
        sendJson(res, 502, {
          error: `iCloud rejected update: ${response.status} ${response.statusText}`,
        });
        return 502;
      }
      invalidateCache();
      sendJson(res, 200, { ok: true });
      return 200;
    }

    if (method === 'POST' && pathname === '/refresh') {
      await loginManager.attemptLogin();
      invalidateCache();
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
