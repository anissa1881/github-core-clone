// main.ts: the entry's lifecycle against the env. The test suite runs beside this program, so the
// program binds an ephemeral port, announces that port to the env, serves until the env reports the
// trial is over, and then exits 0. A program that never registers leaves the env with nothing to test.

import { createApp } from './app.ts';
import { flushAll } from './store.ts';

/** Where the env listens, from MAKEFUN_ENV_URL. Without it there is no env to talk to. */
const ENV_URL = readEnvUrl();

/** How long a single register or done request may take before it is abandoned and retried. */
const REQUEST_TIMEOUT_MS = 30_000;
/** The wait before the first retry. */
const RETRY_INITIAL_MS = 250;
/** The longest wait between retries. */
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
