/**
 * Stdio MCP server for CalDAV. Thin fetch forwarder to the host-side
 * service (src/caldav-service.ts); credentials live on the host.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { makeDavCaller } from './dav-http-client.js';

const call = makeDavCaller(
  'CalDAV',
  process.env.NANOCLAW_CALDAV_SERVICE_URL || '',
);

const isoTimestamp = z.string().refine((v) => /Z$|[+-]\d{2}:\d{2}$/.test(v), {
  message:
    'Timestamp must be ISO-8601 with explicit timezone (e.g. "2026-04-20T10:00:00-04:00" or "...Z"). Naked local times are rejected.',
});

const server = new McpServer({
  name: 'caldav',
  version: '1.0.0',
});

server.tool(
  'list_calendars',
  "List the user's iCloud calendars with their URLs. Use the URLs as calendar_url in other tools.",
  {},
  async () => call('GET', '/calendars'),
);

server.tool(
  'list_events',
  'List events on a calendar within a time range. Timestamps must be ISO-8601 with an explicit timezone.',
  {
    calendar_url: z.string().describe('Calendar URL from list_calendars'),
    start_iso: isoTimestamp.describe('Range start, ISO-8601 with timezone'),
    end_iso: isoTimestamp.describe('Range end, ISO-8601 with timezone'),
  },
  async (args) =>
    call('GET', '/events', {
      query: {
        calendar_url: args.calendar_url,
        start: args.start_iso,
        end: args.end_iso,
      },
    }),
);

server.tool(
  'create_event',
  'Create a calendar event. Only call this after the user has confirmed the specific time, calendar, and title. Use all_day=true for date-only events (start_iso and end_iso still use ISO format; time portion is ignored).',
  {
    calendar_url: z
      .string()
      .describe('Target calendar URL from list_calendars'),
    title: z.string().describe('Event title / summary'),
    start_iso: isoTimestamp.describe('Start time, ISO-8601 with timezone'),
    end_iso: isoTimestamp.describe('End time, ISO-8601 with timezone'),
    all_day: z.boolean().optional().describe('All-day event (default false)'),
    location: z.string().optional(),
    notes: z.string().optional().describe('Event description / notes'),
  },
  async (args) =>
    call('POST', '/events', {
      body: {
        calendar_url: args.calendar_url,
        title: args.title,
        start: args.start_iso,
        end: args.end_iso,
        all_day: args.all_day,
        location: args.location,
        notes: args.notes,
      },
    }),
);

server.tool(
  'update_event',
  'Update fields on an existing event. Omitted fields stay unchanged.',
  {
    event_url: z
      .string()
      .describe('Event URL returned by create_event or list_events'),
    title: z.string().optional(),
    start_iso: isoTimestamp.optional(),
    end_iso: isoTimestamp.optional(),
    all_day: z.boolean().optional(),
    location: z.string().optional(),
    notes: z.string().optional(),
  },
  async (args) =>
    call('PATCH', '/events', {
      body: {
        event_url: args.event_url,
        title: args.title,
        start: args.start_iso,
        end: args.end_iso,
        all_day: args.all_day,
        location: args.location,
        notes: args.notes,
      },
    }),
);

server.tool(
  'delete_event',
  'Delete an event. Only call this after the user has explicitly confirmed deletion.',
  {
    event_url: z.string().describe('Event URL to delete'),
  },
  async (args) =>
    call('DELETE', '/events', { body: { event_url: args.event_url } }),
);

server.tool(
  'list_reminders',
  'List iCloud Reminders (VTODO) on a reminders-list calendar. By default excludes completed/cancelled items; set include_completed=true to see everything.',
  {
    calendar_url: z
      .string()
      .describe(
        'Reminders-list URL from list_calendars (iCloud exposes reminder lists alongside event calendars)',
      ),
    include_completed: z
      .boolean()
      .optional()
      .describe('Include completed/cancelled reminders (default false)'),
  },
  async (args) =>
    call('GET', '/reminders', {
      query: {
        calendar_url: args.calendar_url,
        ...(args.include_completed ? { include_completed: 'true' } : {}),
      },
    }),
);

server.tool(
  'create_reminder',
  'Create a reminder (VTODO) on a reminders list. Only call this after the user has confirmed the list and title. Due date is optional; when set it must be ISO-8601 with timezone.',
  {
    calendar_url: z.string().describe('Target reminders-list URL'),
    title: z.string().describe('Reminder title'),
    due_iso: isoTimestamp
      .optional()
      .describe('Optional due date/time, ISO-8601 with timezone'),
    notes: z.string().optional(),
    priority: z
      .number()
      .int()
      .min(0)
      .max(9)
      .optional()
      .describe('Priority 0 (none) to 9 (lowest); 1 is highest'),
  },
  async (args) =>
    call('POST', '/reminders', {
      body: {
        calendar_url: args.calendar_url,
        title: args.title,
        due: args.due_iso,
        notes: args.notes,
        priority: args.priority,
      },
    }),
);

server.tool(
  'update_reminder',
  'Update fields on a reminder, or mark it complete/incomplete via the completed flag. Omitted fields stay unchanged. Pass due_iso: null to remove an existing due date.',
  {
    object_url: z
      .string()
      .describe('Reminder URL returned by create_reminder or list_reminders'),
    title: z.string().optional(),
    due_iso: isoTimestamp
      .nullable()
      .optional()
      .describe('ISO-8601 due date/time, or null to clear'),
    notes: z.string().optional(),
    priority: z.number().int().min(0).max(9).optional(),
    completed: z
      .boolean()
      .optional()
      .describe('true to mark complete, false to reopen'),
  },
  async (args) =>
    call('PATCH', '/reminders', {
      body: {
        object_url: args.object_url,
        title: args.title,
        due: args.due_iso,
        notes: args.notes,
        priority: args.priority,
        completed: args.completed,
      },
    }),
);

server.tool(
  'delete_reminder',
  'Delete a reminder. Only call this after the user has explicitly confirmed deletion.',
  {
    object_url: z.string().describe('Reminder URL to delete'),
  },
  async (args) =>
    call('DELETE', '/reminders', { body: { object_url: args.object_url } }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
