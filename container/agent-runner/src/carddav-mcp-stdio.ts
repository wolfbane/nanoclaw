/**
 * Stdio MCP server for CardDAV (iCloud contacts).
 *
 * Thin forwarder over fetch against the host-side service
 * (src/carddav-service.ts). The agent never sees iCloud credentials; the
 * container only sees NANOCLAW_CARDDAV_SERVICE_URL.
 *
 * Read-only for v1. Writes can be added later if the user needs them.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const serviceUrl = process.env.NANOCLAW_CARDDAV_SERVICE_URL || '';

function errorResult(text: string) {
  return {
    content: [{ type: 'text' as const, text }],
    isError: true,
  };
}

function successResult(body: unknown) {
  return {
    content: [
      {
        type: 'text' as const,
        text: typeof body === 'string' ? body : JSON.stringify(body, null, 2),
      },
    ],
  };
}

async function call(
  method: 'GET' | 'POST',
  path: string,
  options: { query?: Record<string, string>; body?: unknown } = {},
): Promise<ReturnType<typeof successResult>> {
  if (!serviceUrl) {
    return errorResult(
      'CardDAV not configured on the host. The operator needs to set ICLOUD_APPLE_ID and ICLOUD_APP_PASSWORD in .env and restart NanoClaw.',
    );
  }

  const url = new URL(path, serviceUrl);
  if (options.query) {
    for (const [k, v] of Object.entries(options.query)) {
      url.searchParams.set(k, v);
    }
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers:
        options.body !== undefined ? { 'content-type': 'application/json' } : {},
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });
  } catch (err) {
    return errorResult(
      `CardDAV service unreachable at ${serviceUrl}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }

  if (!response.ok) {
    const msg =
      parsed &&
      typeof parsed === 'object' &&
      'error' in (parsed as Record<string, unknown>)
        ? String((parsed as Record<string, unknown>).error)
        : text || `HTTP ${response.status}`;
    return errorResult(`CardDAV error (${response.status}): ${msg}`);
  }

  return successResult(parsed ?? '');
}

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
