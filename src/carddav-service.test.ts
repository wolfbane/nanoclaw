import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';

const mockEnv: Record<string, string> = {};
vi.mock('./env.js', () => ({
  readEnvFile: vi.fn(() => ({ ...mockEnv })),
}));

vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

interface MockAddressBook {
  url: string;
  displayName?: string;
  description?: string;
}

interface MockVCardObject {
  url: string;
  etag: string;
  data: string;
}

interface DavClientBehavior {
  loginImpl?: () => Promise<void>;
  addressBooks: MockAddressBook[];
  // Per-book vCard store, keyed by addressBook url.
  objectsByBook: Map<string, MockVCardObject[]>;
  fetchVCardsImpl?: (params: {
    addressBook: { url: string };
    objectUrls?: string[];
  }) => Promise<MockVCardObject[]>;
  lastCreate?: {
    addressBookUrl: string;
    filename: string;
    vCardString: string;
  };
  lastUpdate?: {
    url: string;
    etag?: string;
    data: string;
  };
  createImpl?: (...args: unknown[]) => Promise<Response>;
  updateImpl?: (...args: unknown[]) => Promise<Response>;
}

const davClientState: DavClientBehavior = {
  addressBooks: [],
  objectsByBook: new Map(),
};

vi.mock('tsdav', () => ({
  DAVClient: class {
    constructor() {
      // state lives in the closure above
    }
    async login(): Promise<void> {
      if (davClientState.loginImpl) {
        await davClientState.loginImpl();
      }
    }
    async fetchAddressBooks(): Promise<MockAddressBook[]> {
      return davClientState.addressBooks;
    }
    async fetchVCards(params: {
      addressBook: { url: string };
      objectUrls?: string[];
    }): Promise<MockVCardObject[]> {
      if (davClientState.fetchVCardsImpl) {
        return davClientState.fetchVCardsImpl(params);
      }
      const all =
        davClientState.objectsByBook.get(params.addressBook.url) ?? [];
      if (params.objectUrls) {
        return all.filter((o) => params.objectUrls!.includes(o.url));
      }
      return all;
    }
    async createVCard(params: {
      addressBook: { url: string };
      filename: string;
      vCardString: string;
    }): Promise<Response> {
      davClientState.lastCreate = {
        addressBookUrl: params.addressBook.url,
        filename: params.filename,
        vCardString: params.vCardString,
      };
      if (davClientState.createImpl) {
        return davClientState.createImpl(params);
      }
      return new Response('', { status: 201 });
    }
    async updateVCard(params: {
      vCard: { url: string; etag?: string; data: string };
    }): Promise<Response> {
      davClientState.lastUpdate = {
        url: params.vCard.url,
        etag: params.vCard.etag,
        data: params.vCard.data,
      };
      if (davClientState.updateImpl) {
        return davClientState.updateImpl(params);
      }
      return new Response(null, { status: 204 });
    }
  },
}));

import { startCarddavService } from './carddav-service.js';

function request(
  port: number,
  options: http.RequestOptions,
  body?: string,
): Promise<{
  statusCode: number;
  body: string;
  headers: http.IncomingHttpHeaders;
}> {
  return new Promise((resolve, reject) => {
    const bodyBuf = body ? Buffer.from(body) : undefined;
    const headers = {
      ...(options.headers || {}),
      ...(bodyBuf ? { 'content-length': bodyBuf.length } : {}),
    };
    const req = http.request(
      { ...options, headers, hostname: '127.0.0.1', port },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({
            statusCode: res.statusCode!,
            body: Buffer.concat(chunks).toString(),
            headers: res.headers,
          }),
        );
      },
    );
    req.on('error', reject);
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

const BOOK_URL = 'https://contacts.example/card/';
const buildVCardData = (lines: string[]): string =>
  ['BEGIN:VCARD', 'VERSION:3.0', ...lines, 'END:VCARD'].join('\r\n') + '\r\n';

describe('carddav-service', () => {
  let server: http.Server | null;

  beforeEach(() => {
    server = null;
    davClientState.addressBooks = [];
    davClientState.objectsByBook = new Map();
    davClientState.loginImpl = undefined;
    davClientState.fetchVCardsImpl = undefined;
    davClientState.lastCreate = undefined;
    davClientState.lastUpdate = undefined;
    davClientState.createImpl = undefined;
    davClientState.updateImpl = undefined;
  });

  afterEach(async () => {
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    for (const key of Object.keys(mockEnv)) delete mockEnv[key];
  });

  async function start(): Promise<number> {
    Object.assign(mockEnv, {
      ICLOUD_APPLE_ID: 'user@icloud.com',
      ICLOUD_APP_PASSWORD: 'app-pw-xxxx',
    });
    davClientState.addressBooks = [{ url: BOOK_URL, displayName: 'Card' }];
    const s = await startCarddavService(0, '127.0.0.1');
    server = s;
    if (!s) throw new Error('service did not start');
    // Give the deferred login a tick to resolve before tests issue requests.
    await new Promise((r) => setTimeout(r, 10));
    return (s.address() as AddressInfo).port;
  }

  describe('POST /contacts', () => {
    it('rejects when address_book_url is missing', async () => {
      const port = await start();
      const res = await request(
        port,
        {
          method: 'POST',
          path: '/contacts',
          headers: { 'content-type': 'application/json' },
        },
        JSON.stringify({ full_name: 'Sam' }),
      );
      expect(res.statusCode).toBe(400);
    });

    it('rejects when full_name is missing', async () => {
      const port = await start();
      const res = await request(
        port,
        {
          method: 'POST',
          path: '/contacts',
          headers: { 'content-type': 'application/json' },
        },
        JSON.stringify({ address_book_url: BOOK_URL }),
      );
      expect(res.statusCode).toBe(400);
    });

    it('returns 404 when address book is unknown', async () => {
      const port = await start();
      const res = await request(
        port,
        {
          method: 'POST',
          path: '/contacts',
          headers: { 'content-type': 'application/json' },
        },
        JSON.stringify({
          address_book_url: 'https://contacts.example/missing/',
          full_name: 'Sam',
        }),
      );
      expect(res.statusCode).toBe(404);
    });

    it('builds a vCard and calls createVCard', async () => {
      const port = await start();
      const res = await request(
        port,
        {
          method: 'POST',
          path: '/contacts',
          headers: { 'content-type': 'application/json' },
        },
        JSON.stringify({
          address_book_url: BOOK_URL,
          full_name: 'Sam Carter',
          given_name: 'Sam',
          family_name: 'Carter',
          organization: 'Acme',
          title: 'Engineer',
          phones: [{ type: 'cell', value: '+15551234567' }],
          emails: [{ type: 'home', value: 'sam@example.com' }],
          birthday: '1990-04-21',
          notes: 'met at conf',
        }),
      );

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.url).toMatch(/^https:\/\/contacts\.example\/card\//);
      expect(body.uid).toMatch(/^nc-/);

      const vcard = davClientState.lastCreate!.vCardString;
      expect(vcard).toMatch(/BEGIN:VCARD\r\n/);
      expect(vcard).toMatch(/VERSION:3\.0\r\n/);
      expect(vcard).toMatch(/FN:Sam Carter\r\n/);
      expect(vcard).toMatch(/N:Carter;Sam;;;\r\n/);
      expect(vcard).toMatch(/ORG:Acme\r\n/);
      expect(vcard).toMatch(/TITLE:Engineer\r\n/);
      expect(vcard).toMatch(/TEL;TYPE=CELL:\+15551234567\r\n/);
      expect(vcard).toMatch(/EMAIL;TYPE=HOME:sam@example\.com\r\n/);
      expect(vcard).toMatch(/BDAY:1990-04-21\r\n/);
      expect(vcard).toMatch(/NOTE:met at conf\r\n/);
      expect(vcard).toMatch(/END:VCARD\r\n/);
    });

    it('escapes commas, semicolons, and newlines (incl. bare CR)', async () => {
      const port = await start();
      await request(
        port,
        {
          method: 'POST',
          path: '/contacts',
          headers: { 'content-type': 'application/json' },
        },
        JSON.stringify({
          address_book_url: BOOK_URL,
          full_name: 'Last, First',
          notes: 'line1\rline2\nline3\r\nline4; with ; semis, and , commas',
        }),
      );
      const vcard = davClientState.lastCreate!.vCardString;
      expect(vcard).toContain('FN:Last\\, First\r\n');
      // Bare \r, bare \n, and \r\n all collapse to the literal escape "\n".
      expect(vcard).toContain(
        'NOTE:line1\\nline2\\nline3\\nline4\\; with \\; semis\\, and \\, commas\r\n',
      );
      // Sanity: no literal CR or LF inside the body of any folded line.
      const lines = vcard.split('\r\n');
      for (const line of lines) {
        expect(line.includes('\r') || line.includes('\n')).toBe(false);
      }
    });

    it('sanitizes phone/email TYPE params to prevent injection', async () => {
      const port = await start();
      await request(
        port,
        {
          method: 'POST',
          path: '/contacts',
          headers: { 'content-type': 'application/json' },
        },
        JSON.stringify({
          address_book_url: BOOK_URL,
          full_name: 'Test',
          phones: [
            { type: 'cell:INJECTED;EVIL=1', value: '+15551112222' },
            { type: '', value: '+15553334444' },
          ],
          emails: [{ type: 'home,work', value: 'a@b.c' }],
        }),
      );
      const vcard = davClientState.lastCreate!.vCardString;
      // Injected ":" / ";" / "=" in TYPE should be stripped.
      expect(vcard).toContain('TEL;TYPE=CELLINJECTEDEVIL1:+15551112222\r\n');
      expect(vcard).not.toContain('EVIL=');
      // Empty type → no TYPE param at all.
      expect(vcard).toContain('TEL:+15553334444\r\n');
      // Comma in type is stripped (params would otherwise be split on it).
      expect(vcard).toContain('EMAIL;TYPE=HOMEWORK:a@b.c\r\n');
    });

    it('omits N when neither given_name nor family_name supplied', async () => {
      const port = await start();
      await request(
        port,
        {
          method: 'POST',
          path: '/contacts',
          headers: { 'content-type': 'application/json' },
        },
        JSON.stringify({
          address_book_url: BOOK_URL,
          full_name: 'Just A Display Name',
        }),
      );
      const vcard = davClientState.lastCreate!.vCardString;
      expect(vcard).not.toMatch(/^N:/m);
    });

    it('returns 400 for malformed JSON', async () => {
      const port = await start();
      const res = await request(
        port,
        {
          method: 'POST',
          path: '/contacts',
          headers: { 'content-type': 'application/json' },
        },
        '{not valid json',
      );
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toMatch(/invalid JSON/i);
    });

    it('returns 400 when phones is not an array', async () => {
      const port = await start();
      const res = await request(
        port,
        {
          method: 'POST',
          path: '/contacts',
          headers: { 'content-type': 'application/json' },
        },
        JSON.stringify({
          address_book_url: BOOK_URL,
          full_name: 'X',
          phones: '+15551234567',
        }),
      );
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toMatch(/phones must be an array/);
    });

    it('returns 400 when an email entry is missing value', async () => {
      const port = await start();
      const res = await request(
        port,
        {
          method: 'POST',
          path: '/contacts',
          headers: { 'content-type': 'application/json' },
        },
        JSON.stringify({
          address_book_url: BOOK_URL,
          full_name: 'X',
          emails: [{ type: 'home' }],
        }),
      );
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toMatch(/emails\[0\]\.value/);
    });

    it('returns 400 when a phone entry is not an object', async () => {
      const port = await start();
      const res = await request(
        port,
        {
          method: 'POST',
          path: '/contacts',
          headers: { 'content-type': 'application/json' },
        },
        JSON.stringify({
          address_book_url: BOOK_URL,
          full_name: 'X',
          phones: ['+15551234567'],
        }),
      );
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toMatch(
        /phones\[0\] must be an object/,
      );
    });

    it('returns 502 when iCloud rejects the create', async () => {
      const port = await start();
      davClientState.createImpl = async () =>
        new Response('nope', {
          status: 507,
          statusText: 'Insufficient Storage',
        });
      const res = await request(
        port,
        {
          method: 'POST',
          path: '/contacts',
          headers: { 'content-type': 'application/json' },
        },
        JSON.stringify({ address_book_url: BOOK_URL, full_name: 'X' }),
      );
      expect(res.statusCode).toBe(502);
    });
  });

  describe('PATCH /contacts', () => {
    const EXISTING_URL = `${BOOK_URL}existing.vcf`;

    function seedContact(extraLines: string[] = []): void {
      davClientState.objectsByBook.set(BOOK_URL, [
        {
          url: EXISTING_URL,
          etag: 'etag-1',
          data: buildVCardData([
            'UID:original-uid',
            'FN:Sam Carter',
            'N:Carter;Sam;;;',
            'ORG:Acme',
            'TITLE:Engineer',
            'TEL;TYPE=CELL:+15551234567',
            'EMAIL;TYPE=HOME:sam@example.com',
            'NOTE:original notes',
            ...extraLines,
          ]),
        },
      ]);
    }

    it('rejects when object_url is missing', async () => {
      const port = await start();
      const res = await request(
        port,
        {
          method: 'PATCH',
          path: '/contacts',
          headers: { 'content-type': 'application/json' },
        },
        JSON.stringify({ full_name: 'Whatever' }),
      );
      expect(res.statusCode).toBe(400);
    });

    it('returns 404 when no address book owns the url', async () => {
      const port = await start();
      const res = await request(
        port,
        {
          method: 'PATCH',
          path: '/contacts',
          headers: { 'content-type': 'application/json' },
        },
        JSON.stringify({
          object_url: 'https://other.example/foo/bar.vcf',
          full_name: 'X',
        }),
      );
      expect(res.statusCode).toBe(404);
    });

    it('returns 404 when contact does not exist on the server', async () => {
      const port = await start();
      // book exists, but no objects in it
      const res = await request(
        port,
        {
          method: 'PATCH',
          path: '/contacts',
          headers: { 'content-type': 'application/json' },
        },
        JSON.stringify({ object_url: EXISTING_URL, full_name: 'X' }),
      );
      expect(res.statusCode).toBe(404);
    });

    it('preserves untouched fields and the original UID on partial update', async () => {
      seedContact();
      const port = await start();
      const res = await request(
        port,
        {
          method: 'PATCH',
          path: '/contacts',
          headers: { 'content-type': 'application/json' },
        },
        JSON.stringify({ object_url: EXISTING_URL, title: 'Senior Engineer' }),
      );
      expect(res.statusCode).toBe(200);

      const sent = davClientState.lastUpdate!;
      expect(sent.url).toBe(EXISTING_URL);
      expect(sent.etag).toBe('etag-1');
      // UID round-tripped from the existing vCard.
      expect(sent.data).toMatch(/UID:original-uid\r\n/);
      // Updated.
      expect(sent.data).toMatch(/TITLE:Senior Engineer\r\n/);
      // Untouched fields preserved.
      expect(sent.data).toMatch(/FN:Sam Carter\r\n/);
      expect(sent.data).toMatch(/N:Carter;Sam;;;\r\n/);
      expect(sent.data).toMatch(/ORG:Acme\r\n/);
      expect(sent.data).toMatch(/TEL;TYPE=CELL:\+15551234567\r\n/);
      expect(sent.data).toMatch(/EMAIL;TYPE=HOME:sam@example\.com\r\n/);
      expect(sent.data).toMatch(/NOTE:original notes\r\n/);
    });

    it('null clears scalar fields, undefined leaves them alone', async () => {
      seedContact();
      const port = await start();
      await request(
        port,
        {
          method: 'PATCH',
          path: '/contacts',
          headers: { 'content-type': 'application/json' },
        },
        JSON.stringify({
          object_url: EXISTING_URL,
          organization: null,
          notes: 'updated notes',
        }),
      );
      const sent = davClientState.lastUpdate!.data;
      expect(sent).not.toMatch(/^ORG:/m);
      expect(sent).toMatch(/NOTE:updated notes\r\n/);
      // Title was not specified → preserved.
      expect(sent).toMatch(/TITLE:Engineer\r\n/);
    });

    it('replaces phones/emails arrays wholesale when provided', async () => {
      seedContact();
      const port = await start();
      await request(
        port,
        {
          method: 'PATCH',
          path: '/contacts',
          headers: { 'content-type': 'application/json' },
        },
        JSON.stringify({
          object_url: EXISTING_URL,
          phones: [{ type: 'work', value: '+15559998888' }],
          emails: [],
        }),
      );
      const sent = davClientState.lastUpdate!.data;
      expect(sent).toMatch(/TEL;TYPE=WORK:\+15559998888\r\n/);
      expect(sent).not.toMatch(/TEL;TYPE=CELL/);
      expect(sent).not.toMatch(/^EMAIL/m);
    });

    it('returns 502 when iCloud rejects the update', async () => {
      seedContact();
      davClientState.updateImpl = async () =>
        new Response('conflict', {
          status: 412,
          statusText: 'Precondition Failed',
        });
      const port = await start();
      const res = await request(
        port,
        {
          method: 'PATCH',
          path: '/contacts',
          headers: { 'content-type': 'application/json' },
        },
        JSON.stringify({ object_url: EXISTING_URL, full_name: 'X' }),
      );
      expect(res.statusCode).toBe(502);
    });

    it('returns 400 for malformed JSON', async () => {
      const port = await start();
      const res = await request(
        port,
        {
          method: 'PATCH',
          path: '/contacts',
          headers: { 'content-type': 'application/json' },
        },
        '}}}',
      );
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toMatch(/invalid JSON/i);
    });

    it('returns 400 when emails is not an array', async () => {
      seedContact();
      const port = await start();
      const res = await request(
        port,
        {
          method: 'PATCH',
          path: '/contacts',
          headers: { 'content-type': 'application/json' },
        },
        JSON.stringify({ object_url: EXISTING_URL, emails: 42 }),
      );
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toMatch(/emails must be an array/);
    });

    it('preserves additional/prefix/suffix N components when only family/given change', async () => {
      // Seed a vCard whose N has all 5 slots populated.
      davClientState.objectsByBook.set(BOOK_URL, [
        {
          url: EXISTING_URL,
          etag: 'etag-1',
          data: buildVCardData([
            'UID:original-uid',
            'FN:Dr. Sam Carter Jr.',
            'N:Carter;Sam;Quinn;Dr.;Jr.',
          ]),
        },
      ]);
      const port = await start();
      await request(
        port,
        {
          method: 'PATCH',
          path: '/contacts',
          headers: { 'content-type': 'application/json' },
        },
        // Only change the given name; family/additional/prefix/suffix
        // should round-trip from the original card.
        JSON.stringify({ object_url: EXISTING_URL, given_name: 'Samuel' }),
      );
      const sent = davClientState.lastUpdate!.data;
      expect(sent).toMatch(/N:Carter;Samuel;Quinn;Dr\.;Jr\.\r\n/);
    });

    it('clears only the slot for given_name=null and preserves the other components', async () => {
      davClientState.objectsByBook.set(BOOK_URL, [
        {
          url: EXISTING_URL,
          etag: 'etag-1',
          data: buildVCardData([
            'UID:u',
            'FN:Sam',
            'N:Carter;Sam;Quinn;Dr.;Jr.',
          ]),
        },
      ]);
      const port = await start();
      await request(
        port,
        {
          method: 'PATCH',
          path: '/contacts',
          headers: { 'content-type': 'application/json' },
        },
        JSON.stringify({ object_url: EXISTING_URL, given_name: null }),
      );
      const sent = davClientState.lastUpdate!.data;
      expect(sent).toMatch(/N:Carter;;Quinn;Dr\.;Jr\.\r\n/);
    });

    it('round-trips a literal semicolon inside an N component', async () => {
      // Family name "Smith; Jr" — the ";" must be escaped on the wire and
      // must NOT split the field on parse.
      davClientState.objectsByBook.set(BOOK_URL, [
        {
          url: EXISTING_URL,
          etag: 'etag-1',
          data: buildVCardData([
            'UID:u',
            'FN:Sam Smith; Jr',
            'N:Smith\\; Jr;Sam;;;',
          ]),
        },
      ]);
      const port = await start();
      // Update an unrelated field; the N line should come back unchanged
      // (still containing the escaped semicolon in the family slot).
      await request(
        port,
        {
          method: 'PATCH',
          path: '/contacts',
          headers: { 'content-type': 'application/json' },
        },
        JSON.stringify({ object_url: EXISTING_URL, title: 'CTO' }),
      );
      const sent = davClientState.lastUpdate!.data;
      expect(sent).toMatch(/N:Smith\\; Jr;Sam;;;\r\n/);
    });
  });

  describe('cache invalidation', () => {
    it('drops the cache after a successful create so the next list re-fetches', async () => {
      const port = await start();
      // First /contacts populates the cache.
      const before = await request(port, { method: 'GET', path: '/contacts' });
      expect(before.statusCode).toBe(200);
      expect(JSON.parse(before.body).total).toBe(0);

      // Insert a vCard into the mock store, then create through the service.
      // After create, the cache should be invalid and the next GET should
      // see the new contact.
      davClientState.objectsByBook.set(BOOK_URL, [
        {
          url: `${BOOK_URL}new.vcf`,
          etag: 'etag-new',
          data: buildVCardData(['UID:new-uid', 'FN:Newly Added']),
        },
      ]);
      const created = await request(
        port,
        {
          method: 'POST',
          path: '/contacts',
          headers: { 'content-type': 'application/json' },
        },
        JSON.stringify({
          address_book_url: BOOK_URL,
          full_name: 'Newly Added',
        }),
      );
      expect(created.statusCode).toBe(201);

      const after = await request(port, { method: 'GET', path: '/contacts' });
      const body = JSON.parse(after.body);
      expect(body.total).toBe(1);
      expect(body.contacts[0].full_name).toBe('Newly Added');
    });

    it('discards an in-flight load that races a successful mutation', async () => {
      const port = await start();

      // Start a slow load: fetchVCards hangs until we resolve it manually.
      let releaseLoad: () => void = () => undefined;
      const loadGate = new Promise<void>((r) => {
        releaseLoad = r;
      });
      let loadCallReturned: MockVCardObject[] = [];
      davClientState.fetchVCardsImpl = async () => {
        await loadGate;
        return loadCallReturned;
      };

      // Pre-populate what the slow load would see (the "stale" snapshot).
      loadCallReturned = [
        {
          url: `${BOOK_URL}stale.vcf`,
          etag: 'etag-stale',
          data: buildVCardData(['UID:stale-uid', 'FN:Stale Snapshot']),
        },
      ];

      // Kick off the slow GET (don't await it yet).
      const slowGetPromise = request(port, {
        method: 'GET',
        path: '/contacts',
      });

      // While that load is in-flight, run a successful create. This should
      // bump the cache generation so the slow load's result is NOT cached.
      // The create still needs fetchVCards to be unblocked when invoked, but
      // creates don't call fetchVCards so this is fine.
      const created = await request(
        port,
        {
          method: 'POST',
          path: '/contacts',
          headers: { 'content-type': 'application/json' },
        },
        JSON.stringify({ address_book_url: BOOK_URL, full_name: 'New One' }),
      );
      expect(created.statusCode).toBe(201);

      // Now release the slow load.
      releaseLoad();
      const slowGet = await slowGetPromise;
      expect(slowGet.statusCode).toBe(200);
      // The slow load resolves with the stale snapshot, but it should NOT
      // have populated the cache. Reconfigure fetchVCardsImpl to return a
      // fresh snapshot and verify the next GET sees it (proving cache is
      // empty, not holding the stale data).
      davClientState.fetchVCardsImpl = async () => [
        {
          url: `${BOOK_URL}fresh.vcf`,
          etag: 'etag-fresh',
          data: buildVCardData(['UID:fresh-uid', 'FN:Fresh Snapshot']),
        },
      ];
      const freshGet = await request(port, {
        method: 'GET',
        path: '/contacts',
      });
      const body = JSON.parse(freshGet.body);
      expect(body.total).toBe(1);
      expect(body.contacts[0].full_name).toBe('Fresh Snapshot');
    });

    it('detaches the in-flight load on mutation so the next GET starts a fresh fetch', async () => {
      const port = await start();

      // Track every fetchVCards call. The first is the pre-mutation slow load;
      // the second must be a freshly started load triggered by the post-
      // mutation GET (proving we don't reuse the in-flight stale promise).
      const fetchCalls: { resolved: boolean }[] = [];
      let releaseFirst: (() => void) | null = null;
      const firstGate = new Promise<void>((r) => {
        releaseFirst = r;
      });

      davClientState.fetchVCardsImpl = async () => {
        const slot = { resolved: false };
        fetchCalls.push(slot);
        if (fetchCalls.length === 1) {
          await firstGate;
          slot.resolved = true;
          return [
            {
              url: `${BOOK_URL}stale.vcf`,
              etag: 'etag-stale',
              data: buildVCardData(['UID:stale-uid', 'FN:Stale Result']),
            },
          ];
        }
        slot.resolved = true;
        return [
          {
            url: `${BOOK_URL}fresh.vcf`,
            etag: 'etag-fresh',
            data: buildVCardData(['UID:fresh-uid', 'FN:Fresh Result']),
          },
        ];
      };

      // Kick off the slow GET. Don't await it.
      const slowGetPromise = request(port, {
        method: 'GET',
        path: '/contacts',
      });
      // Yield so the handler enters loadAllContacts and parks on the gate.
      await new Promise((r) => setTimeout(r, 5));
      expect(fetchCalls.length).toBe(1);

      // Mutation while the first load is parked.
      const created = await request(
        port,
        {
          method: 'POST',
          path: '/contacts',
          headers: { 'content-type': 'application/json' },
        },
        JSON.stringify({ address_book_url: BOOK_URL, full_name: 'X' }),
      );
      expect(created.statusCode).toBe(201);

      // Now hit GET /contacts again. Because invalidateCache() detached the
      // first load, this should kick off a SECOND fetchVCards call rather
      // than awaiting the still-parked first one.
      const postMutationGetPromise = request(port, {
        method: 'GET',
        path: '/contacts',
      });
      await new Promise((r) => setTimeout(r, 5));
      expect(fetchCalls.length).toBe(2);

      // The second load isn't gated, so it should already have resolved.
      // The post-mutation GET should now complete and see "Fresh Result".
      const postMutationGet = await postMutationGetPromise;
      expect(postMutationGet.statusCode).toBe(200);
      const body = JSON.parse(postMutationGet.body);
      expect(
        body.contacts.map((c: { full_name: string }) => c.full_name),
      ).toContain('Fresh Result');

      // Finally release the parked first load and let it finish; its result
      // should be discarded (not surface in any later GET).
      releaseFirst!();
      await slowGetPromise;
    });
  });
});
