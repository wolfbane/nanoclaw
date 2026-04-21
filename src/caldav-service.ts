/**
 * Host-side CalDAV service for iCloud calendar access. Credentials live on
 * the host (via readEnvFile, never in process.env); the container receives
 * only an internal URL. Used for iCloud because CalDAV returns absolute
 * shard URLs in DAV multistatus XML that a path-prefix proxy can't rewrite.
 */
import { IncomingMessage, Server, ServerResponse } from 'http';
import { URL } from 'url';

import ical, { ICalEventData } from 'ical-generator';
import nodeIcal from 'node-ical';
import { DAVCalendar, DAVCalendarObject, DAVClient } from 'tsdav';

import {
  DavLoginManager,
  extractDisplayName,
  readJsonBody,
  sendJson,
  startICloudDavService,
} from './dav-service-util.js';
import { logger } from './logger.js';

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

interface Reminder {
  uid: string;
  url: string;
  etag?: string;
  summary: string;
  due?: string;
  notes?: string;
  priority?: number;
  status: 'NEEDS-ACTION' | 'IN-PROCESS' | 'COMPLETED' | 'CANCELLED';
  completed?: string;
}

interface CreateReminderBody {
  calendar_url: string;
  title: string;
  due?: string;
  notes?: string;
  priority?: number;
}

interface UpdateReminderBody {
  event_url: string;
  title?: string;
  due?: string | null;
  notes?: string;
  priority?: number;
  completed?: boolean;
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

interface DeleteCalDavObjectBody {
  event_url: string;
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

function formatICalUtc(isoOrDate: string | Date): string {
  const d = isoOrDate instanceof Date ? isoOrDate : new Date(isoOrDate);
  // RFC 5545 UTC form: YYYYMMDDTHHMMSSZ
  return d
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
}

function escapeICalText(s: string): string {
  // RFC 5545 §3.3.11: escape \\, newline, comma, semicolon.
  return s
    .replace(/\\/g, '\\\\')
    .replace(/\r?\n/g, '\\n')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;');
}

function buildVTodoICalString(data: {
  uid: string;
  title: string;
  due?: string;
  notes?: string;
  priority?: number;
  completed?: boolean;
  completedAt?: string;
}): string {
  const now = formatICalUtc(new Date());
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//NanoClaw//CalDAV//EN',
    'BEGIN:VTODO',
    `UID:${data.uid}`,
    `DTSTAMP:${now}`,
    `SUMMARY:${escapeICalText(data.title)}`,
  ];
  if (data.notes) lines.push(`DESCRIPTION:${escapeICalText(data.notes)}`);
  if (data.due) lines.push(`DUE:${formatICalUtc(data.due)}`);
  if (data.priority !== undefined) lines.push(`PRIORITY:${data.priority}`);
  if (data.completed) {
    lines.push('STATUS:COMPLETED');
    lines.push('PERCENT-COMPLETE:100');
    lines.push(`COMPLETED:${formatICalUtc(data.completedAt || new Date())}`);
  } else {
    lines.push('STATUS:NEEDS-ACTION');
  }
  lines.push('END:VTODO', 'END:VCALENDAR');
  return lines.join('\r\n') + '\r\n';
}

// tsdav's default calendar-query filter asks for VEVENT only. iCloud returns
// zero VTODO results with that filter, so we pass an explicit VTODO filter
// for reminders endpoints.
const VTODO_FILTERS = [
  {
    'comp-filter': {
      _attributes: { name: 'VCALENDAR' },
      'comp-filter': {
        _attributes: { name: 'VTODO' },
      },
    },
  },
];

function parseICalDateString(s: string): Date | undefined {
  // RFC 5545 forms we care about:
  //   YYYYMMDD                       (DATE)
  //   YYYYMMDDTHHMMSSZ               (DATE-TIME, UTC)
  //   YYYYMMDDTHHMMSS                (DATE-TIME, floating — treat as UTC)
  const dateOnly = /^(\d{4})(\d{2})(\d{2})$/;
  const dateTime = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?$/;
  const m2 = dateTime.exec(s);
  if (m2) {
    const d = new Date(
      Date.UTC(
        Number(m2[1]),
        Number(m2[2]) - 1,
        Number(m2[3]),
        Number(m2[4]),
        Number(m2[5]),
        Number(m2[6]),
      ),
    );
    return isNaN(d.getTime()) ? undefined : d;
  }
  const m1 = dateOnly.exec(s);
  if (m1) {
    const d = new Date(
      Date.UTC(Number(m1[1]), Number(m1[2]) - 1, Number(m1[3])),
    );
    return isNaN(d.getTime()) ? undefined : d;
  }
  return undefined;
}

function toDateOrUndefined(v: unknown): Date | undefined {
  if (v instanceof Date && !isNaN(v.getTime())) return v;
  if (typeof v !== 'string' || !v) return undefined;
  // node-ical returns VTODO DUE/COMPLETED as raw iCal strings. Try that first,
  // then fall back to ISO-8601 for anything else.
  const iCal = parseICalDateString(v);
  if (iCal) return iCal;
  const d = new Date(v);
  return isNaN(d.getTime()) ? undefined : d;
}

function parseRemindersFromObjects(objects: DAVCalendarObject[]): Reminder[] {
  const reminders: Reminder[] = [];
  for (const obj of objects) {
    if (!obj.data || typeof obj.data !== 'string') continue;
    let parsed: nodeIcal.CalendarResponse;
    try {
      parsed = nodeIcal.parseICS(obj.data);
    } catch (err) {
      logger.warn({ url: obj.url, err }, 'Failed to parse iCal reminder');
      continue;
    }
    for (const key of Object.keys(parsed)) {
      const c = parsed[key] as unknown as Record<string, unknown>;
      if (c.type !== 'VTODO') continue;
      const status =
        (c.status as string | undefined)?.toUpperCase() || 'NEEDS-ACTION';
      const dueDate = toDateOrUndefined(c.due);
      const completedDate = toDateOrUndefined(c.completed);
      reminders.push({
        uid: String(c.uid || ''),
        url: obj.url,
        etag: obj.etag,
        summary: String(c.summary || ''),
        due: dueDate?.toISOString(),
        notes: c.description ? String(c.description) : undefined,
        priority:
          typeof c.priority === 'number' ? (c.priority as number) : undefined,
        status: status as Reminder['status'],
        completed: completedDate?.toISOString(),
      });
    }
  }
  return reminders;
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

export function startCaldavService(
  port: number,
  host: string,
): Promise<Server | null> {
  return startICloudDavService<DAVCalendar[]>({
    serviceName: 'CalDAV',
    serverUrl: 'https://caldav.icloud.com',
    accountType: 'caldav',
    port,
    host,
    fetchResources: (client) => client.fetchCalendars(),
    initialResources: [],
    buildHandler: ({ client, loginManager, host, port }) =>
      buildCaldavHandler(client, loginManager, host, port),
  });
}

function buildCaldavHandler(
  client: DAVClient,
  loginManager: DavLoginManager<DAVCalendar[]>,
  host: string,
  port: number,
): (req: IncomingMessage, res: ServerResponse) => Promise<number> {
  const fetchCalendarList = async (): Promise<DAVCalendar[]> =>
    loginManager.getResources();

  return async (req: IncomingMessage, res: ServerResponse): Promise<number> => {
    const requestUrl = new URL(req.url || '/', `http://${host}:${port}`);
    const pathname = requestUrl.pathname;
    const method = req.method || 'GET';

    const loginStatus = loginManager.getStatus();
    const lastError = loginManager.getLastError();

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

    if (method === 'GET' && pathname === '/reminders') {
      const calendarUrl = requestUrl.searchParams.get('calendar_url');
      const includeCompleted =
        requestUrl.searchParams.get('include_completed') === 'true';
      if (!calendarUrl) {
        sendJson(res, 400, { error: 'calendar_url is required' });
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
        filters: VTODO_FILTERS,
      });
      const all = parseRemindersFromObjects(objects);
      const filtered = includeCompleted
        ? all
        : all.filter(
            (r) => r.status !== 'COMPLETED' && r.status !== 'CANCELLED',
          );
      sendJson(res, 200, { reminders: filtered });
      return 200;
    }

    if (method === 'POST' && pathname === '/reminders') {
      const body = await readJsonBody<CreateReminderBody>(req);
      if (!body.calendar_url || !body.title) {
        sendJson(res, 400, { error: 'calendar_url and title are required' });
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
      const iCalString = buildVTodoICalString({
        uid,
        title: body.title,
        due: body.due,
        notes: body.notes,
        priority: body.priority,
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

    if (method === 'PATCH' && pathname === '/reminders') {
      const body = await readJsonBody<UpdateReminderBody>(req);
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
        sendJson(res, 404, { error: `reminder not found: ${body.event_url}` });
        return 404;
      }
      const current = parseRemindersFromObjects(existing)[0];
      if (!current) {
        sendJson(res, 500, {
          error: 'failed to parse current reminder for merge',
        });
        return 500;
      }
      const mergedCompleted =
        body.completed !== undefined
          ? body.completed
          : current.status === 'COMPLETED';
      const iCalString = buildVTodoICalString({
        uid: current.uid,
        title: body.title ?? current.summary,
        due: body.due === null ? undefined : (body.due ?? current.due),
        notes: body.notes ?? current.notes,
        priority:
          body.priority !== undefined ? body.priority : current.priority,
        completed: mergedCompleted,
        completedAt: mergedCompleted ? current.completed : undefined,
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

    if (
      method === 'DELETE' &&
      (pathname === '/events' || pathname === '/reminders')
    ) {
      const body = await readJsonBody<DeleteCalDavObjectBody>(req);
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

    if (method === 'POST' && pathname === '/refresh') {
      await loginManager.attemptLogin();
      const postStatus = loginManager.getStatus();
      sendJson(res, 200, {
        ok: postStatus === 'ok',
        loginStatus: postStatus,
        calendars: loginManager.getResources().length,
      });
      return 200;
    }

    sendJson(res, 404, { error: 'not found' });
    return 404;
  };
}
