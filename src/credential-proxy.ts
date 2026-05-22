/**
 * Credential proxy for container isolation.
 * Containers connect here instead of directly to the Anthropic API.
 * The proxy injects real credentials so containers never see them.
 *
 * Two auth modes:
 *   API key:  Proxy injects x-api-key on every request.
 *   OAuth:    Container CLI exchanges its placeholder token for a temp
 *             API key via /api/oauth/claude_cli/create_api_key.
 *             Proxy injects real OAuth token on that exchange request;
 *             subsequent requests carry the temp key which is valid as-is.
 */
import { createServer, Server } from 'http';
import { request as httpsRequest } from 'https';
import { request as httpRequest, RequestOptions } from 'http';
import { brotliDecompressSync, gunzipSync, inflateSync } from 'zlib';

import { recordApiUsage } from './db.js';
import { readEnvFile } from './env.js';
import { logger } from './logger.js';

// Anthropic published pricing (USD per million tokens). Keep in sync with
// https://www.anthropic.com/pricing#api. Prefix-matched against the model
// name returned in the response. Unknown models record tokens with $0 cost.
const PRICING: Record<
  string,
  { in: number; cw: number; cr: number; out: number }
> = {
  'claude-opus-4': { in: 15, cw: 18.75, cr: 1.5, out: 75 },
  'claude-sonnet-4': { in: 3, cw: 3.75, cr: 0.3, out: 15 },
  'claude-haiku-4': { in: 1, cw: 1.25, cr: 0.1, out: 5 },
  'claude-3-5-sonnet': { in: 3, cw: 3.75, cr: 0.3, out: 15 },
  'claude-3-5-haiku': { in: 0.8, cw: 1.0, cr: 0.08, out: 4 },
};

function pricingFor(
  model: string | null,
): { in: number; cw: number; cr: number; out: number } | null {
  if (!model) return null;
  for (const [prefix, p] of Object.entries(PRICING)) {
    if (model.startsWith(prefix)) return p;
  }
  return null;
}

interface ParsedUsage {
  model: string | null;
  input_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  output_tokens: number;
}

function parseUsage(body: string, isSse: boolean): ParsedUsage | null {
  const acc: ParsedUsage = {
    model: null,
    input_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: 0,
  };

  if (!isSse) {
    try {
      const obj = JSON.parse(body);
      if (obj?.usage) {
        acc.model = obj.model ?? null;
        acc.input_tokens = obj.usage.input_tokens ?? 0;
        acc.cache_creation_input_tokens =
          obj.usage.cache_creation_input_tokens ?? 0;
        acc.cache_read_input_tokens = obj.usage.cache_read_input_tokens ?? 0;
        acc.output_tokens = obj.usage.output_tokens ?? 0;
        return acc;
      }
    } catch {
      /* not json with usage */
    }
    return null;
  }

  let sawUsage = false;
  for (const line of body.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    try {
      const obj = JSON.parse(line.slice(6));
      if (obj.type === 'message_start' && obj.message) {
        if (obj.message.model) acc.model = obj.message.model;
        const u = obj.message.usage;
        if (u) {
          sawUsage = true;
          acc.input_tokens = u.input_tokens ?? acc.input_tokens;
          acc.cache_creation_input_tokens =
            u.cache_creation_input_tokens ?? acc.cache_creation_input_tokens;
          acc.cache_read_input_tokens =
            u.cache_read_input_tokens ?? acc.cache_read_input_tokens;
          acc.output_tokens = u.output_tokens ?? acc.output_tokens;
        }
      } else if (obj.type === 'message_delta' && obj.usage) {
        sawUsage = true;
        // message_delta.usage.output_tokens is the cumulative total in Anthropic SSE
        if (obj.usage.output_tokens != null) {
          acc.output_tokens = Math.max(
            acc.output_tokens,
            obj.usage.output_tokens,
          );
        }
        if (obj.usage.input_tokens != null) {
          acc.input_tokens = Math.max(acc.input_tokens, obj.usage.input_tokens);
        }
      }
    } catch {
      /* skip unparseable line */
    }
  }
  return sawUsage ? acc : null;
}

function computeCost(u: ParsedUsage): number {
  const p = pricingFor(u.model);
  if (!p) return 0;
  return (
    (u.input_tokens * p.in +
      u.cache_creation_input_tokens * p.cw +
      u.cache_read_input_tokens * p.cr +
      u.output_tokens * p.out) /
    1_000_000
  );
}

export type AuthMode = 'api-key' | 'oauth';

export interface ProxyConfig {
  authMode: AuthMode;
}

export function startCredentialProxy(
  port: number,
  host = '127.0.0.1',
): Promise<Server> {
  const secrets = readEnvFile([
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
  ]);

  const authMode: AuthMode = secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
  const oauthToken =
    secrets.CLAUDE_CODE_OAUTH_TOKEN || secrets.ANTHROPIC_AUTH_TOKEN;

  const upstreamUrl = new URL(
    secrets.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
  );
  const isHttps = upstreamUrl.protocol === 'https:';
  const makeRequest = isHttps ? httpsRequest : httpRequest;

  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const requestStart = Date.now();
      const sourceIp = req.socket.remoteAddress ?? null;
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        const headers: Record<string, string | number | string[] | undefined> =
          {
            ...(req.headers as Record<string, string>),
            host: upstreamUrl.host,
            'content-length': body.length,
          };

        // Strip hop-by-hop headers that must not be forwarded by proxies
        delete headers['connection'];
        delete headers['keep-alive'];
        delete headers['transfer-encoding'];

        if (authMode === 'api-key') {
          // API key mode: inject x-api-key on every request
          delete headers['x-api-key'];
          headers['x-api-key'] = secrets.ANTHROPIC_API_KEY;
        } else {
          // OAuth mode: replace placeholder Bearer token with the real one
          // only when the container actually sends an Authorization header
          // (exchange request + auth probes). Post-exchange requests use
          // x-api-key only, so they pass through without token injection.
          if (headers['authorization']) {
            delete headers['authorization'];
            if (oauthToken) {
              headers['authorization'] = `Bearer ${oauthToken}`;
            }
          }
        }

        const upstream = makeRequest(
          {
            hostname: upstreamUrl.hostname,
            port: upstreamUrl.port || (isHttps ? 443 : 80),
            path: req.url,
            method: req.method,
            headers,
          } as RequestOptions,
          (upRes) => {
            res.writeHead(upRes.statusCode!, upRes.headers);

            const trackUsage = (req.url ?? '').startsWith('/v1/messages');
            const isSse = (
              (upRes.headers['content-type'] as string) ?? ''
            ).includes('text/event-stream');
            const respChunks: Buffer[] = trackUsage ? [] : [];
            const requestId =
              (upRes.headers['request-id'] as string) ??
              (upRes.headers['x-request-id'] as string) ??
              null;

            upRes.on('data', (chunk: Buffer) => {
              if (trackUsage) respChunks.push(chunk);
              res.write(chunk);
            });
            const encoding = (
              (upRes.headers['content-encoding'] as string) ?? ''
            ).toLowerCase();
            upRes.on('end', () => {
              res.end();
              if (!trackUsage) return;
              setImmediate(() => {
                try {
                  const raw = Buffer.concat(respChunks);
                  let decoded: Buffer = raw;
                  try {
                    if (encoding === 'gzip') decoded = gunzipSync(raw);
                    else if (encoding === 'br')
                      decoded = brotliDecompressSync(raw);
                    else if (encoding === 'deflate') decoded = inflateSync(raw);
                  } catch {
                    // Streaming gzip may not be syncDecodable; fall back to raw
                    // (parseUsage will return null, request still recorded)
                  }
                  const respBody = decoded.toString('utf8');
                  const parsed = parseUsage(respBody, isSse);
                  if (!parsed) return;
                  const cost = computeCost(parsed);
                  recordApiUsage({
                    ts: new Date(requestStart).toISOString(),
                    path: req.url ?? '',
                    method: req.method ?? 'GET',
                    status: upRes.statusCode ?? 0,
                    source_ip: sourceIp,
                    model: parsed.model,
                    request_id: requestId,
                    input_tokens: parsed.input_tokens,
                    cache_creation_input_tokens:
                      parsed.cache_creation_input_tokens,
                    cache_read_input_tokens: parsed.cache_read_input_tokens,
                    output_tokens: parsed.output_tokens,
                    duration_ms: Date.now() - requestStart,
                    is_streaming: isSse,
                    cost_usd: cost,
                  });
                } catch (err) {
                  logger.warn({ err, url: req.url }, 'usage tracking failed');
                }
              });
            });
          },
        );

        upstream.on('error', (err) => {
          logger.error(
            { err, url: req.url },
            'Credential proxy upstream error',
          );
          if (!res.headersSent) {
            res.writeHead(502);
            res.end('Bad Gateway');
          }
        });

        upstream.write(body);
        upstream.end();
      });
    });

    server.listen(port, host, () => {
      logger.info({ port, host, authMode }, 'Credential proxy started');
      resolve(server);
    });

    server.on('error', reject);
  });
}

/** Detect which auth mode the host is configured for. */
export function detectAuthMode(): AuthMode {
  const secrets = readEnvFile(['ANTHROPIC_API_KEY']);
  return secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
}
