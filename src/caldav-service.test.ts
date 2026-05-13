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

interface MockCalendar {
  url: string;
  displayName: string;
  ctag?: string;
  calendarColor?: string;
}

interface MockCalendarObject {
  url: string;
  etag: string;
  data: string;
}

interface DavClientBehavior {
  loginImpl?: () => Promise<void>;
  calendars: MockCalendar[];
  objects: Map<string, MockCalendarObject>;
  lastCreate?: {
    calendarUrl: string;
    filename: string;
    iCalString: string;
  };
  lastUpdate?: {
    url: string;
    etag?: string;
    data: string;
  };
  lastDelete?: { url: string; etag?: string };
  createImpl?: (...args: unknown[]) => Promise<Response>;
}

const davClientState: DavClientBehavior = {
  calendars: [],
  objects: new Map(),
};

vi.mock('tsdav', () => ({
  DAVClient: class {
    constructor() {
      // no-op; state lives in the closure above
    }
    async login(): Promise<void> {
      if (davClientState.loginImpl) {
        await davClientState.loginImpl();
      }
    }
    async fetchCalendars(): Promise<MockCalendar[]> {
      return davClientState.calendars;
    }
    async fetchCalendarObjects(params: {
      calendar: { url: string };
      timeRange?: { start: string; end: string };
      objectUrls?: string[];
    }): Promise<MockCalendarObject[]> {
      if (params.objectUrls) {
        return params.objectUrls
          .map((u) => davClientState.objects.get(u))
          .filter((o): o is MockCalendarObject => !!o);
      }
      return Array.from(davClientState.objects.values()).filter((o) =>
        o.url.startsWith(params.calendar.url),
      );
    }
    async createCalendarObject(params: {
      calendar: { url: string };
      filename: string;
      iCalString: string;
    }): Promise<Response> {
      davClientState.lastCreate = {
        calendarUrl: params.calendar.url,
        filename: params.filename,
        iCalString: params.iCalString,
      };
      if (davClientState.createImpl) {
        return davClientState.createImpl(params);
      }
      return new Response('', { status: 201 });
    }
    async updateCalendarObject(params: {
      calendarObject: { url: string; etag?: string; data: string };
    }): Promise<Response> {
      davClientState.lastUpdate = {
        url: params.calendarObject.url,
        etag: params.calendarObject.etag,
        data: params.calendarObject.data,
      };
      return new Response(null, { status: 204 });
    }
    async deleteCalendarObject(params: {
      calendarObject: { url: string; etag?: string };
    }): Promise<Response> {
      davClientState.lastDelete = {
        url: params.calendarObject.url,
        etag: params.calendarObject.etag,
      };
      return new Response(null, { status: 204 });
    }
  },
}));

import { startCaldavService } from './caldav-service.js';

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

describe('caldav-service', () => {
  let server: http.Server | null;

  beforeEach(() => {
    server = null;
    davClientState.calendars = [];
    davClientState.objects = new Map();
    davClientState.loginImpl = undefined;
    davClientState.lastCreate = undefined;
    davClientState.lastUpdate = undefined;
    davClientState.lastDelete = undefined;
    davClientState.createImpl = undefined;
  });

  afterEach(async () => {
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    for (const key of Object.keys(mockEnv)) delete mockEnv[key];
  });

  async function start(): Promise<number> {
    const s = await startCaldavService(0, '127.0.0.1');
    server = s;
    if (!s) throw new Error('service did not start');
    return (s.address() as AddressInfo).port;
  }

  it('does not start without credentials', async () => {
    const s = await startCaldavService(0, '127.0.0.1');
    expect(s).toBeNull();
  });

  it('health returns ok when login succeeds', async () => {
    Object.assign(mockEnv, {
      ICLOUD_APPLE_ID: 'user@icloud.com',
      ICLOUD_APP_PASSWORD: 'app-pw-xxxx',
    });
    davClientState.calendars = [
      { url: 'https://c/main/', displayName: 'Main' },
    ];

    const port = await start();
    const res = await request(port, { method: 'GET', path: '/health' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(body.loginStatus).toBe('ok');
  });

  it('health reports failure and data endpoints return 503 on 401', async () => {
    Object.assign(mockEnv, {
      ICLOUD_APPLE_ID: 'user@icloud.com',
      ICLOUD_APP_PASSWORD: 'revoked',
    });
    davClientState.loginImpl = async () => {
      throw new Error('401 Unauthorized');
    };

    const port = await start();
    const health = await request(port, { method: 'GET', path: '/health' });
    const healthBody = JSON.parse(health.body);
    expect(healthBody.ok).toBe(false);
    expect(healthBody.loginStatus).toBe('failed');
    expect(healthBody.lastError).toMatch(/401/);

    const cals = await request(port, { method: 'GET', path: '/calendars' });
    expect(cals.statusCode).toBe(503);
  });

  it('lists calendars', async () => {
    Object.assign(mockEnv, {
      ICLOUD_APPLE_ID: 'u@icloud.com',
      ICLOUD_APP_PASSWORD: 'app',
    });
    davClientState.calendars = [
      {
        url: 'https://p01/main/',
        displayName: 'Matthew todos',
        ctag: 'c1',
        calendarColor: '#ff0',
      },
      { url: 'https://p01/shared/', displayName: 'Shared' },
    ];

    const port = await start();
    const res = await request(port, { method: 'GET', path: '/calendars' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.calendars).toHaveLength(2);
    expect(body.calendars[0]).toMatchObject({
      url: 'https://p01/main/',
      displayName: 'Matthew todos',
      ctag: 'c1',
      color: '#ff0',
    });
  });

  it('POST /events composes iCal and calls createCalendarObject', async () => {
    Object.assign(mockEnv, {
      ICLOUD_APPLE_ID: 'u@icloud.com',
      ICLOUD_APP_PASSWORD: 'app',
    });
    davClientState.calendars = [
      { url: 'https://p01/main/', displayName: 'Matthew todos' },
    ];

    const port = await start();
    const res = await request(
      port,
      {
        method: 'POST',
        path: '/events',
        headers: { 'content-type': 'application/json' },
      },
      JSON.stringify({
        calendar_url: 'https://p01/main/',
        title: 'Dinner with Sam',
        start: '2026-04-21T19:00:00-04:00',
        end: '2026-04-21T21:00:00-04:00',
        location: 'Somewhere',
      }),
    );

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.url).toMatch(/^https:\/\/p01\/main\//);
    expect(body.uid).toMatch(
      /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/,
    );

    expect(davClientState.lastCreate?.calendarUrl).toBe('https://p01/main/');
    expect(davClientState.lastCreate?.iCalString).toMatch(/BEGIN:VEVENT/);
    expect(davClientState.lastCreate?.iCalString).toMatch(/Dinner with Sam/);
    expect(davClientState.lastCreate?.iCalString).toMatch(/Somewhere/);
  });

  it('POST /events returns 400 on missing fields', async () => {
    Object.assign(mockEnv, {
      ICLOUD_APPLE_ID: 'u@icloud.com',
      ICLOUD_APP_PASSWORD: 'app',
    });
    davClientState.calendars = [
      { url: 'https://p01/main/', displayName: 'Matthew todos' },
    ];
    const port = await start();
    const res = await request(
      port,
      {
        method: 'POST',
        path: '/events',
        headers: { 'content-type': 'application/json' },
      },
      JSON.stringify({ calendar_url: 'https://p01/main/' }),
    );
    expect(res.statusCode).toBe(400);
  });

  it('PATCH /events merges fields and propagates etag', async () => {
    Object.assign(mockEnv, {
      ICLOUD_APPLE_ID: 'u@icloud.com',
      ICLOUD_APP_PASSWORD: 'app',
    });
    davClientState.calendars = [
      { url: 'https://p01/main/', displayName: 'Matthew todos' },
    ];
    const existingIcs = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VEVENT',
      'UID:original-uid@nanoclaw',
      'DTSTAMP:20260420T120000Z',
      'SUMMARY:Original',
      'DTSTART:20260421T190000Z',
      'DTEND:20260421T200000Z',
      'LOCATION:Old Place',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    davClientState.objects.set('https://p01/main/event-1.ics', {
      url: 'https://p01/main/event-1.ics',
      etag: 'etag-v1',
      data: existingIcs,
    });

    const port = await start();
    const res = await request(
      port,
      {
        method: 'PATCH',
        path: '/events',
        headers: { 'content-type': 'application/json' },
      },
      JSON.stringify({
        object_url: 'https://p01/main/event-1.ics',
        title: 'New title',
      }),
    );
    expect(res.statusCode).toBe(200);

    expect(davClientState.lastUpdate?.url).toBe('https://p01/main/event-1.ics');
    expect(davClientState.lastUpdate?.etag).toBe('etag-v1');
    expect(davClientState.lastUpdate?.data).toMatch(/SUMMARY:New title/);
    expect(davClientState.lastUpdate?.data).toMatch(/LOCATION:Old Place/);
  });

  it('DELETE /events forwards the url to iCloud', async () => {
    Object.assign(mockEnv, {
      ICLOUD_APPLE_ID: 'u@icloud.com',
      ICLOUD_APP_PASSWORD: 'app',
    });
    davClientState.calendars = [
      { url: 'https://p01/main/', displayName: 'Matthew todos' },
    ];

    const port = await start();
    const res = await request(
      port,
      {
        method: 'DELETE',
        path: '/events',
        headers: { 'content-type': 'application/json' },
      },
      JSON.stringify({ object_url: 'https://p01/main/event-2.ics' }),
    );
    expect(res.statusCode).toBe(200);
    expect(davClientState.lastDelete?.url).toBe('https://p01/main/event-2.ics');
  });

  it('POST /events returns 502 when iCloud rejects', async () => {
    Object.assign(mockEnv, {
      ICLOUD_APPLE_ID: 'u@icloud.com',
      ICLOUD_APP_PASSWORD: 'app',
    });
    davClientState.calendars = [
      { url: 'https://p01/main/', displayName: 'Matthew todos' },
    ];
    davClientState.createImpl = async () =>
      new Response('Forbidden', { status: 403, statusText: 'Forbidden' });

    const port = await start();
    const res = await request(
      port,
      {
        method: 'POST',
        path: '/events',
        headers: { 'content-type': 'application/json' },
      },
      JSON.stringify({
        calendar_url: 'https://p01/main/',
        title: 'X',
        start: '2026-04-21T10:00:00Z',
        end: '2026-04-21T11:00:00Z',
      }),
    );
    expect(res.statusCode).toBe(502);
  });
});
