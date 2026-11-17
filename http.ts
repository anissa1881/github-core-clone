// http.ts: the small HTTP helpers every surface shares: a JSON reply that always carries GitHub's
// request-id header, a body reader that rejects malformed JSON with 400, and the token checks the
// rules require of a read or a write.

import type { IncomingMessage, ServerResponse } from 'node:http';

const JSON_TYPE = 'application/json; charset=utf-8';

/** A short, unique request id: the header GitHub's clients expect on every reply. */
export function requestId(): string {
  return `${Date.now().toString(36).toUpperCase()}:${(seq += 1).toString(36).toUpperCase()}`;
}
let seq = 0;

/** Send one JSON reply with the request-id header and any extra headers. */
export function respond(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): void {
  if (res.headersSent) return;
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': requestId(),
    ...headers,
  });
  res.end(text);
}

/** Send one already-serialized JSON reply, with the same headers respond() sets. */
export function respondText(
  res: ServerResponse,
  status: number,
  text: string,
  headers: Readonly<Record<string, string>> = {},
): void {
  if (res.headersSent) return;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': requestId(),
    ...headers,
  });
  res.end(text);
}

/** Send an empty reply (204 and the like). */
export function respondEmpty(
  res: ServerResponse,
  status: number,
  headers: Readonly<Record<string, string>> = {},
): void {
  if (res.headersSent) return;
  res.writeHead(status, { 'x-github-request-id': requestId(), ...headers });
  res.end();
}

/** Read a request's whole body as bytes. */
export async function readRaw(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/**
 * Read a request's body as parsed JSON. A body that is not a JSON object answers 400 and returns
 * null so the caller stops; an empty body is an empty object, as GitHub treats a missing body.
 */
export async function readBody(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<Record<string, unknown> | null> {
  const raw = await readRaw(req);
  const text = raw.toString('utf8').trim();
  if (text === '') return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      respond(res, 400, { message: 'Problems parsing JSON' });
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    respond(res, 400, { message: 'Problems parsing JSON' });
    return null;
  }
}

/** The bearer token a request presents, or null. */
export function bearerOf(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m ? m[1]!.trim() : null;
}

/**
 * The credentials a git client sends. git speaks Basic: "user:token" in base64, where the token is
 * the password. Answered as the token's value, or null.
 */
export function basicTokenOf(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const m = /^Basic\s+(.+)$/i.exec(header.trim());
  if (!m) return null;
  let decoded = '';
  try {
    decoded = Buffer.from(m[1]!, 'base64').toString('utf8');
  } catch {
    return null;
  }
  const colon = decoded.indexOf(':');
  if (colon < 0) return decoded;
  return decoded.slice(colon + 1);
}

/** Whether the request may use the forge: a bearer token, or git's Basic token. */
export function authorized(req: IncomingMessage, token: string): boolean {
  return bearerOf(req) === token || basicTokenOf(req) === token;
}
