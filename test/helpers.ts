// helpers.ts: the harness every test file in this suite shares. Each file runs in its own process,
// so a file gets its own server, its own store directory and its own token, and nothing one file
// does can be seen by another. The server is the entry itself (createApp), bound to an ephemeral
// port, exactly as main.ts binds it for the env.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../app.ts';

/** The token every test file presents unless it asks for another. */
export const TOKEN = 'makefun-trial-token';

/** The login the token names, and therefore the owner of every repository a test creates. */
export const LOGIN = 'makefun';

/** One running entry: the base URL, the store directory behind it and its teardown. */
export interface Harness {
  /** The origin every request goes to, with no trailing slash. */
  readonly base: string;
  /** The directory the forge keeps its repositories in. */
  readonly store: string;
  /** Stop the server and release the port. */
  close(): Promise<void>;
}

/**
 * Start the entry on an ephemeral port, against a store nobody else uses. FORGE_NATIVE_BIN makes the
 * same harness drive the compiled binary instead: it binds a port of its own, says which one on
 * stdout, and serves until it is stopped, which is exactly how the env runs it.
 */
export async function start(opts: {
  token?: string;
  login?: string;
} = {}): Promise<Harness> {
  const store = mkdtempSync(join(tmpdir(), 'forge-test-'));
  const token = opts.token ?? TOKEN;
  const login = opts.login ?? LOGIN;

  const native = process.env.FORGE_NATIVE_BIN;
  if (native !== undefined && native !== '') {
    const child: ChildProcess = spawn(native, [], {
      env: {
        ...process.env,
        MAKEFUN_DEV_PORT: '0',
        MAKEFUN_STORE_DIR: store,
        MAKEFUN_SHOP_TOKEN: token,
        MAKEFUN_SHOP_LOGIN: login,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const port = await new Promise<number>((resolve, reject) => {
      let seen = '';
      const timer = setTimeout(() => reject(new Error(`the binary said: ${seen}`)), 15_000);
      child.stdout?.on('data', (chunk: Buffer) => {
        seen += chunk.toString('utf8');
        const hit = /listening on port (\d+)/.exec(seen);
        if (hit !== null) {
          clearTimeout(timer);
          resolve(Number(hit[1]));
        }
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`the binary exited with ${String(code)}: ${seen}`));
      });
    });
    return {
      base: `http://127.0.0.1:${port}`,
      store,
      async close(): Promise<void> {
        child.kill('SIGKILL');
      },
    };
  }

  process.env.MAKEFUN_STORE_DIR = store;
  process.env.MAKEFUN_SHOP_TOKEN = token;
  process.env.MAKEFUN_SHOP_LOGIN = login;
  const server: Server = createApp();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    store,
    async close(): Promise<void> {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err === undefined ? resolve() : reject(err)));
      });
    },
  };
}

/** What one request answered: the status, the parsed body and the raw headers. */
export interface Answer {
  readonly status: number;
  readonly body: any;
  readonly headers: Headers;
  readonly text: string;
}

/** Send one JSON request with the token presented as GitHub clients present it. */
export async function api(
  h: Harness,
  path: string,
  init: { method?: string; body?: unknown; token?: string | null; headers?: Record<string, string> } = {},
): Promise<Answer> {
  const method = init.method ?? 'GET';
  const headers: Record<string, string> = {
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    ...init.headers,
  };
  const token = init.token === undefined ? TOKEN : init.token;
  if (token !== null && token !== '') headers.authorization = `Bearer ${token}`;
  let payload: string | undefined;
  if (init.body !== undefined) {
    payload = JSON.stringify(init.body);
    headers['content-type'] = 'application/json';
  }
  const response = await fetch(`${h.base}${path}`, { method, headers, body: payload });
  const text = await response.text();
  let body: any = null;
  if (text !== '') {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: response.status, body, headers: response.headers, text };
}

/** Create one repository and answer its JSON as the clone creates it. */
export async function makeRepo(h: Harness, name: string, extra: Record<string, unknown> = {}): Promise<any> {
  const answer = await api(h, '/api/v3/user/repos', {
    method: 'POST',
    body: { name, description: `the ${name} fixture`, ...extra },
  });
  if (answer.status !== 201) {
    throw new Error(`creating ${name} answered ${answer.status}: ${answer.text}`);
  }
  return answer.body;
}

/** The sha a create-file call for one path on one branch answered. */
export async function putFile(
  h: Harness,
  repo: string,
  path: string,
  content: string,
  message: string,
  opts: { branch?: string; sha?: string } = {},
): Promise<string> {
  const answer = await api(h, `/api/v3/repos/${LOGIN}/${repo}/contents/${path}`, {
    method: 'PUT',
    body: {
      message,
      content: Buffer.from(content, 'utf8').toString('base64'),
      ...opts,
    },
  });
  if (answer.status !== 201 && answer.status !== 200) {
    throw new Error(`writing ${path} answered ${answer.status}: ${answer.text}`);
  }
  return answer.body.commit.sha;
}

/** A signature the suite signs one webhook body with, for the routes that verify one. */
export function sign(secret: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

/** The base64 form the API wraps in 60-character lines, as the fixture writes files. */
export function wrap64(text: string): string {
  const raw = Buffer.from(text, 'utf8').toString('base64');
  const out: string[] = [];
  for (let i = 0; i < raw.length; i += 60) out.push(raw.slice(i, i + 60));
  return out.join(String.fromCharCode(10));
}
