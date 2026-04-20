/**
 * Host-side CalDAV service for iCloud calendar access.
 *
 * Third-party integrations follow a "host-side service" pattern: credentials
 * live on the host, and the container receives only an internal URL. This is
 * different from the credential proxy (src/credential-proxy.ts), which is a
 * transparent HTTP forwarder dedicated to Anthropic. iCloud CalDAV uses
 * per-shard redirects and returns absolute URLs inside DAV multistatus XML
 * bodies — a path-prefix proxy cannot rewrite those transparently.
 *
 * This service:
 *   - Reads ICLOUD_APPLE_ID / ICLOUD_APP_PASSWORD via readEnvFile (never
 *     loaded into process.env, so they never leak to child containers).
 *   - Keeps a long-lived tsdav DAVClient authenticated against iCloud.
 *   - Exposes a small JSON HTTP API on the proxy bind host.
 *   - Refuses to start when credentials are absent — returning null lets the
 *     host keep running without CalDAV enabled.
 */
import { createServer, IncomingMessage, Server, ServerResponse } from 'http';
import { URL } from 'url';

import ical, { ICalEventData } from 'ical-generator';
import nodeIcal from 'node-ical';
import { DAVCalendar, DAVCalendarObject, DAVClient } from 'tsdav';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

type LoginStatus = 'pending' | 'ok' | 'failed';

interface CalendarEvent {
  uid: string;
  url: string;
  etag?: string;
  summary: string;
  start: string;
  end: string;
  all_day: boolean;
  location?: string;
  description?: string;
}

interface CreateEventBody {
  calendar_url: string;
  title: string;
  start: string;
  end: string;
  all_day?: boolean;
  location?: string;
  notes?: string;
}

interface UpdateEventBody {
  event_url: string;
  title?: string;
  start?: string;
  end?: string;
  all_day?: boolean;
  location?: string;
  notes?: string;
}

interface DeleteEventBody {
  event_url: string;
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

async function readJsonBody<T>(req: IncomingMessage): Promise<T> {
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

function findCalendarByUrl(
  calendars: DAVCalendar[],
  url: string,
): DAVCalendar | undefined {
  return calendars.find((c) => c.url === url);
}

function findCalendarForObject(
  calendars: DAVCalendar[],
  objectUrl: string,
): DAVCalendar | undefined {
  return calendars.find((c) => objectUrl.startsWith(c.url));
}

function extractDisplayName(cal: DAVCalendar): string {
  const dn = cal.displayName;
  if (typeof dn === 'string') return dn;
  if (dn && typeof dn === 'object' && '_cdata' in dn) {
    return String((dn as { _cdata: string })._cdata);
  }
  return '';
}

function buildICalString(data: {
  title: string;
  start: string;
  end: string;
  all_day?: boolean;
  location?: string;
  notes?: string;
  uid: string;
}): string {
  const cal = ical({ prodId: '//NanoClaw//CalDAV//EN' });
  const eventData: ICalEventData = {
    id: data.uid,
    summary: data.title,
    start: new Date(data.start),
    end: new Date(data.end),
    allDay: data.all_day ?? false,
  };
  if (data.location) eventData.location = data.location;
  if (data.notes) eventData.description = data.notes;
  cal.createEvent(eventData);
  return cal.toString();
}

function parseEventsFromObjects(objects: DAVCalendarObject[]): CalendarEvent[] {
  const events: CalendarEvent[] = [];
  for (const obj of objects) {
    if (!obj.data || typeof obj.data !== 'string') continue;
    let parsed: nodeIcal.CalendarResponse;
    try {
      parsed = nodeIcal.parseICS(obj.data);
    } catch (err) {
      logger.warn({ url: obj.url, err }, 'Failed to parse iCal event');
      continue;
    }
    for (const key of Object.keys(parsed)) {
      const component = parsed[key];
      if (component.type !== 'VEVENT') continue;
      const ve = component;
      const isAllDay = ve.datetype === 'date';
      events.push({
        uid: ve.uid,
        url: obj.url,
        etag: obj.etag,
        summary: ve.summary || '',
        start:
          ve.start instanceof Date ? ve.start.toISOString() : String(ve.start),
        end: ve.end instanceof Date ? ve.end.toISOString() : String(ve.end),
        all_day: isAllDay,
        location: ve.location || undefined,
        description: ve.description || undefined,
      });
    }
  }
  return events;
}

function generateUid(): string {
  return `nc-${Date.now()}-${Math.random().toString(36).slice(2, 10)}@nanoclaw`;
}

function eventFilename(uid: string): string {
  // iCloud accepts any .ics filename; use the UID for recognizability.
  return `${uid.replace(/[^a-zA-Z0-9-]/g, '-')}.ics`;
}

function joinUrl(base: string, filename: string): string {
  return base.endsWith('/') ? `${base}${filename}` : `${base}/${filename}`;
}

export async function startCaldavService(
  port: number,
  host: string,
): Promise<Server | null> {
  const secrets = readEnvFile(['ICLOUD_APPLE_ID', 'ICLOUD_APP_PASSWORD']);
  if (!secrets.ICLOUD_APPLE_ID || !secrets.ICLOUD_APP_PASSWORD) {
    logger.info(
      'CalDAV service disabled: ICLOUD_APPLE_ID and ICLOUD_APP_PASSWORD must both be set in .env',
    );
    return null;
  }

  const client = new DAVClient({
    serverUrl: 'https://caldav.icloud.com',
    credentials: {
      username: secrets.ICLOUD_APPLE_ID,
      password: secrets.ICLOUD_APP_PASSWORD,
    },
    authMethod: 'Basic',
    defaultAccountType: 'caldav',
  });

  let loginStatus: LoginStatus = 'pending';
  let lastError: string | undefined;

  const attemptLogin = async (): Promise<void> => {
    try {
      await client.login();
      loginStatus = 'ok';
      lastError = undefined;
      logger.info('CalDAV login succeeded');
    } catch (err) {
      loginStatus = 'failed';
      const msg = err instanceof Error ? err.message : String(err);
      lastError = msg;
      if (/401|unauthorized/i.test(msg)) {
        logger.error(
          { err: msg },
          'CalDAV login failed (401). Regenerate the app-specific password at appleid.apple.com and update ICLOUD_APP_PASSWORD in .env.',
        );
      } else {
        logger.warn({ err: msg }, 'CalDAV login failed — will retry');
      }
    }
  };

  await attemptLogin();
  const retryTimer = setInterval(() => {
    if (loginStatus !== 'ok') void attemptLogin();
  }, LOGIN_RETRY_INTERVAL_MS);
  retryTimer.unref();

  const fetchCalendarList = async (): Promise<DAVCalendar[]> => {
    return client.fetchCalendars();
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
      });
      return 200;
    }

    if (loginStatus !== 'ok') {
      sendJson(res, 503, {
        error: `CalDAV not ready (loginStatus=${loginStatus})${lastError ? `: ${lastError}` : ''}`,
      });
      return 503;
    }

    if (method === 'GET' && pathname === '/calendars') {
      const calendars = await fetchCalendarList();
      sendJson(res, 200, {
        calendars: calendars.map((c) => ({
          url: c.url,
          displayName: extractDisplayName(c),
          ctag: c.ctag,
          color: c.calendarColor,
        })),
      });
      return 200;
    }

    if (method === 'GET' && pathname === '/events') {
      const calendarUrl = requestUrl.searchParams.get('calendar_url');
      const start = requestUrl.searchParams.get('start');
      const end = requestUrl.searchParams.get('end');
      if (!calendarUrl || !start || !end) {
        sendJson(res, 400, {
          error: 'calendar_url, start, end are required query params',
        });
        return 400;
      }
      const calendars = await fetchCalendarList();
      const cal = findCalendarByUrl(calendars, calendarUrl);
      if (!cal) {
        sendJson(res, 404, { error: `calendar not found: ${calendarUrl}` });
        return 404;
      }
      const objects = await client.fetchCalendarObjects({
        calendar: cal,
        timeRange: { start, end },
        expand: true,
      });
      sendJson(res, 200, { events: parseEventsFromObjects(objects) });
      return 200;
    }

    if (method === 'POST' && pathname === '/events') {
      const body = await readJsonBody<CreateEventBody>(req);
      if (!body.calendar_url || !body.title || !body.start || !body.end) {
        sendJson(res, 400, {
          error: 'calendar_url, title, start, end are required',
        });
        return 400;
      }
      const calendars = await fetchCalendarList();
      const cal = findCalendarByUrl(calendars, body.calendar_url);
      if (!cal) {
        sendJson(res, 404, {
          error: `calendar not found: ${body.calendar_url}`,
        });
        return 404;
      }
      const uid = generateUid();
      const filename = eventFilename(uid);
      const iCalString = buildICalString({
        uid,
        title: body.title,
        start: body.start,
        end: body.end,
        all_day: body.all_day,
        location: body.location,
        notes: body.notes,
      });
      const response = await client.createCalendarObject({
        calendar: cal,
        filename,
        iCalString,
      });
      if (!response.ok) {
        sendJson(res, 502, {
          error: `iCloud rejected create: ${response.status} ${response.statusText}`,
        });
        return 502;
      }
      sendJson(res, 201, { url: joinUrl(cal.url, filename), uid });
      return 201;
    }

    if (method === 'PATCH' && pathname === '/events') {
      const body = await readJsonBody<UpdateEventBody>(req);
      if (!body.event_url) {
        sendJson(res, 400, { error: 'event_url is required' });
        return 400;
      }
      const calendars = await fetchCalendarList();
      const cal = findCalendarForObject(calendars, body.event_url);
      if (!cal) {
        sendJson(res, 404, {
          error: `no calendar owns url: ${body.event_url}`,
        });
        return 404;
      }
      const existing = await client.fetchCalendarObjects({
        calendar: cal,
        objectUrls: [body.event_url],
      });
      if (existing.length === 0) {
        sendJson(res, 404, { error: `event not found: ${body.event_url}` });
        return 404;
      }
      const current = parseEventsFromObjects(existing)[0];
      if (!current) {
        sendJson(res, 500, {
          error: 'failed to parse current event for merge',
        });
        return 500;
      }
      const iCalString = buildICalString({
        uid: current.uid,
        title: body.title ?? current.summary,
        start: body.start ?? current.start,
        end: body.end ?? current.end,
        all_day: body.all_day ?? current.all_day,
        location: body.location ?? current.location,
        notes: body.notes ?? current.description,
      });
      const response = await client.updateCalendarObject({
        calendarObject: {
          url: body.event_url,
          etag: existing[0].etag,
          data: iCalString,
        },
      });
      if (!response.ok) {
        sendJson(res, 502, {
          error: `iCloud rejected update: ${response.status} ${response.statusText}`,
        });
        return 502;
      }
      sendJson(res, 200, { ok: true });
      return 200;
    }

    if (method === 'DELETE' && pathname === '/events') {
      const body = await readJsonBody<DeleteEventBody>(req);
      if (!body.event_url) {
        sendJson(res, 400, { error: 'event_url is required' });
        return 400;
      }
      const calendars = await fetchCalendarList();
      const cal = findCalendarForObject(calendars, body.event_url);
      if (!cal) {
        sendJson(res, 404, {
          error: `no calendar owns url: ${body.event_url}`,
        });
        return 404;
      }
      const existing = await client.fetchCalendarObjects({
        calendar: cal,
        objectUrls: [body.event_url],
      });
      const etag = existing[0]?.etag;
      const response = await client.deleteCalendarObject({
        calendarObject: { url: body.event_url, etag, data: '' },
      });
      if (!response.ok) {
        sendJson(res, 502, {
          error: `iCloud rejected delete: ${response.status} ${response.statusText}`,
        });
        return 502;
      }
      sendJson(res, 200, { ok: true });
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
        logger.debug({ method, path, status }, 'caldav-service request');
        // Flag unauthorized so the operator sees password-rotation signals.
        if (status === 401 || status === 403) {
          logger.error(
            { method, path, status },
            'CalDAV upstream rejected request — app-specific password may be revoked',
          );
        }
      })
      .catch((err) => {
        logger.error(
          { method, path, err: err instanceof Error ? err.message : err },
          'caldav-service handler error',
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
      logger.info({ host, port, loginStatus }, 'CalDAV service started');
      resolve(server);
    });
    server.on('error', reject);
  });
}
