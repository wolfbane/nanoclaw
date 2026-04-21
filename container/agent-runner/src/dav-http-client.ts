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

    const hasBody = options.body !== undefined;
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: hasBody ? { 'content-type': 'application/json' } : {},
        body: hasBody ? JSON.stringify(options.body) : undefined,
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
      return errorResult(
        `${serviceName} error (${response.status}): ${extractErrorMessage(parsed, text, response.status)}`,
      );
    }

    return successResult(parsed ?? '');
  };
}

function extractErrorMessage(
  parsed: unknown,
  text: string,
  status: number,
): string {
  if (parsed && typeof parsed === 'object' && 'error' in parsed) {
    return String((parsed as { error: unknown }).error);
  }
  return text || `HTTP ${status}`;
}
