/**
 * Stdio MCP server for CardDAV. Thin fetch forwarder to the host-side
 * service (src/carddav-service.ts). Read-only.
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

server.tool(
  'refresh_contacts',
  'Force a re-login and drop the contacts cache. Use this when you believe contacts changed and want the next search to see the latest data. Contacts are otherwise cached for 5 minutes.',
  {},
  async () => call('POST', '/refresh'),
);

const transport = new StdioServerTransport();
await server.connect(transport);
