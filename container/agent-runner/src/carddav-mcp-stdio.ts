/**
 * Stdio MCP server for CardDAV. Thin fetch forwarder to the host-side
 * service (src/carddav-service.ts).
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { makeDavCaller } from './dav-http-client.js';

const call = makeDavCaller(
  'CardDAV',
  process.env.NANOCLAW_CARDDAV_SERVICE_URL || '',
);

const server = new McpServer({
  name: 'carddav',
  version: '1.0.0',
});

server.tool(
  'list_address_books',
  'List the user\'s iCloud address books. Most setups have a single "Card" book and possibly a shared family one.',
  {},
  async () => call('GET', '/address-books'),
);

server.tool(
  'search_contacts',
  'Search contacts across all iCloud address books. The query matches on name, organization, notes, email (substring) and phone (digits-only substring, needs >=4 chars). Omit q to list everyone up to the limit.',
  {
    q: z
      .string()
      .optional()
      .describe('Search term; substring match (case-insensitive)'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(500)
      .optional()
      .describe('Max contacts to return (default 50, max 500)'),
  },
  async (args) =>
    call('GET', '/contacts', {
      query: {
        ...(args.q ? { q: args.q } : {}),
        ...(args.limit ? { limit: String(args.limit) } : {}),
      },
    }),
);

const phoneOrEmail = z.object({
  type: z
    .string()
    .optional()
    .describe('Label like "cell", "home", "work" (case-insensitive)'),
  value: z.string(),
});

server.tool(
  'create_contact',
  'Create a contact in an iCloud address book. Only call this after the user has confirmed the address book and contact details. Returns the contact URL for later updates.',
  {
    address_book_url: z
      .string()
      .describe('Target address book URL from list_address_books'),
    full_name: z
      .string()
      .describe('Display name (FN). Required by vCard spec.'),
    given_name: z.string().optional(),
    family_name: z.string().optional(),
    organization: z.string().optional(),
    title: z.string().optional().describe('Job title'),
    phones: z.array(phoneOrEmail).optional(),
    emails: z.array(phoneOrEmail).optional(),
    birthday: z.string().optional().describe('Birthday, ideally YYYY-MM-DD'),
    notes: z.string().optional(),
  },
  async (args) => call('POST', '/contacts', { body: args }),
);

server.tool(
  'update_contact',
  'Update fields on an existing contact. Omitted fields stay unchanged. Pass null on a scalar field (e.g. organization) to clear it. Pass a new array for phones/emails to fully replace the existing list. Note: vCard fields the service does not track (PHOTO, ADR, X- custom fields) are dropped on update — only call this when that tradeoff is acceptable.',
  {
    object_url: z
      .string()
      .describe('Contact URL returned by search_contacts or create_contact'),
    full_name: z.string().optional(),
    given_name: z.string().nullable().optional(),
    family_name: z.string().nullable().optional(),
    organization: z.string().nullable().optional(),
    title: z.string().nullable().optional(),
    phones: z
      .array(phoneOrEmail)
      .optional()
      .describe('Replaces the existing phone list when provided'),
    emails: z
      .array(phoneOrEmail)
      .optional()
      .describe('Replaces the existing email list when provided'),
    birthday: z.string().nullable().optional(),
    notes: z.string().nullable().optional(),
  },
  async (args) => call('PATCH', '/contacts', { body: args }),
);

server.tool(
  'refresh_contacts',
  'Force a re-login and drop the contacts cache. Use this when you believe contacts changed and want the next search to see the latest data. Contacts are otherwise cached for 5 minutes.',
  {},
  async () => call('POST', '/refresh'),
);

const transport = new StdioServerTransport();
await server.connect(transport);
