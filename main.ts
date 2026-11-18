// main.ts: the entry's lifecycle against the env. The test suite runs beside this program, so the
// program binds an ephemeral port, announces that port to the env, serves until the env reports the
// trial is over, and then exits 0. A program that never registers leaves the env with nothing to test.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { createApp } from './app.ts';
import { flushAll } from './store.ts';

/**
 * The vendored native forge: a statically linked Linux amd64 binary built from the Go sources in
 * native/. It is committed as vendored source, so the entry runs it in place of the TypeScript
 * server when it is there. FORGE_ENGINE=ts forces the TypeScript server back on.
 */
const NATIVE_BIN = join(import.meta.dirname, 'native', process.platform === 'win32' ? 'forge.exe' : 'forge');

/** Answer whether this run should hand the lifecycle to the native binary. */
function useNative(): boolean {
  if (process.env.FORGE_ENGINE === 'ts') return false;
  return existsSync(NATIVE_BIN);
}

/**
 * Run the native forge in this process' place: it binds the port, registers and serves until the
 * env says done, exactly as the TypeScript lifecycle below does. Signals are passed through so a
 * stop still writes the store out before anything leaves.
 */
async function serveNative(): Promise<void> {
  const child = spawn(NATIVE_BIN, [], { stdio: 'inherit', env: process.env });
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => child.kill(signal));
  }
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', () => resolve());
  });
}

/** Where the env listens, from MAKEFUN_ENV_URL. Without it there is no env to talk to. */
const ENV_URL = readEnvUrl();

/** How long a single register or done request may take before it is abandoned and retried. */
const REQUEST_TIMEOUT_MS = 30_000;
/** The wait before the first retry. */
const RETRY_INITIAL_MS = 250;
/** The longest wait between retries: the schedule is 250, 500, 1000, then 2000 for as long as the trial lasts. */
const RETRY_MAX_MS = 2_000;

/** The env's origin with any trailing slashes removed, or '' when it was not given. */
function readEnvUrl(): string {
  const raw = process.env.MAKEFUN_ENV_URL ?? '';
  return raw.replace(/\/+$/, '');
}

/** Wait one tick. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** The wait after `attempt` failed requests: exponential from the initial delay, then capped. */
function retryDelay(attempt: number): number {
  const exponent = Math.min(attempt, 8);
  return Math.min(RETRY_MAX_MS, RETRY_INITIAL_MS * 2 ** exponent);
}

/** A contract error: the env spoke, and its answer ends the program instead of being retried. */
class ContractError extends Error {}

/**
 * POST the port this program bound until the env accepts it. 200 is the ordinary answer, and 409
 * means an earlier register already won, so both are done. 400 and 405 contradict the contract and
 * end the program. A network error or any other status is retried, since the env may still be coming up.
 */
async function register(port: number): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const answer = await fetch(`${ENV_URL}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (answer.status === 200 || answer.status === 409) return;
      if (answer.status === 400 || answer.status === 405) {
        const text = await answer.text();
        throw new ContractError(`register answered HTTP ${answer.status}: ${text}`);
      }
    } catch (err) {
      if (err instanceof ContractError) throw err;
    }
    await sleep(retryDelay(attempt));
  }
}

/** Poll GET /done until the env reports that the trial is over. */
async function waitForDone(): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const answer = await fetch(`${ENV_URL}/done`, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (answer.ok) {
        const body = (await answer.json()) as { done?: boolean };
        if (body.done === true) return;
      }
    } catch {
      // the env may be busy writing its export: keep polling
    }
    await sleep(retryDelay(attempt));
  }
}

/** Bind the forge on an ephemeral port, register it with the env, and wait for the trial to end. */
async function main(): Promise<void> {
  if (useNative()) {
    await serveNative();
    return;
  }
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the server did not bind an ephemeral TCP port');
  }
  process.stdout.write(`[entry] listening on port ${address.port}\n`);

  await register(address.port);
  process.stdout.write('[entry] registered; waiting for the env to say done\n');

  await waitForDone();
  // the trial is over: everything the forge changed is written before the process leaves
  flushAll();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  process.stdout.write('[entry] done\n');
}

if (ENV_URL === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is not set: there is no env to register with\n');
  process.exit(1);
}

// a stop signal writes the store out before the process leaves, so no change is lost
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    flushAll();
    process.exit(0);
  });
}

try {
  await main();
  process.exit(0);
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[entry] ${message}\n`);
  process.exit(1);
}
