import { IncomingMessage, ServerResponse } from 'http';

export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

export async function readJsonBody<T>(req: IncomingMessage): Promise<T> {
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

type DisplayNameHolder = {
  displayName?: string | { _cdata: string } | unknown;
};

export function extractDisplayName(o: DisplayNameHolder): string {
  const dn = o.displayName;
  if (typeof dn === 'string') return dn;
  if (dn && typeof dn === 'object' && '_cdata' in dn) {
    return String((dn as { _cdata: string })._cdata);
  }
  return '';
}
