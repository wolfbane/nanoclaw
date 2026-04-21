type ToolResult = {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
};

function errorResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

function successResult(body: unknown): ToolResult {
  return {
    content: [
      {
        type: 'text',
        text: typeof body === 'string' ? body : JSON.stringify(body, null, 2),
      },
    ],
  };
}

type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

export type DavServiceCaller = (
  method: HttpMethod,
  path: string,
  options?: { query?: Record<string, string>; body?: unknown },
) => Promise<ToolResult>;

export function makeDavCaller(
  serviceName: string,
  serviceUrl: string,
): DavServiceCaller {
  const notConfigured = errorResult(
    `${serviceName} not configured on the host. The operator needs to set ICLOUD_APPLE_ID and ICLOUD_APP_PASSWORD in .env and restart NanoClaw.`,
  );

  return async (method, path, options = {}) => {
    if (!serviceUrl) return notConfigured;

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
          options.body !== undefined
            ? { 'content-type': 'application/json' }
            : {},
        body:
          options.body !== undefined ? JSON.stringify(options.body) : undefined,
      });
    } catch (err) {
      return errorResult(
        `${serviceName} service unreachable at ${serviceUrl}: ${err instanceof Error ? err.message : String(err)}`,
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
      return errorResult(`${serviceName} error (${response.status}): ${msg}`);
    }

    return successResult(parsed ?? '');
  };
}
