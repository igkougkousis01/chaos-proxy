import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createProxyServer } from '../../src/index.js';
import type { RequestOutcome } from '../../src/index.js';
import { createSeededRandom } from '../../src/random/seeded.js';

/**
 * What a seed buys, checked end to end through a real proxy: the same seed, the
 * same settings and the same order of requests produce the same outcomes.
 *
 * Every expectation here is an exact sequence derived from the pinned generator
 * output in `tests/random/seeded.test.ts`, so nothing depends on probability
 * and nothing is flaky. Requests are sent strictly one at a time, because the
 * order in which requests reach the chaos decision is exactly what the promise
 * is conditioned on.
 */

/** Rates chosen so that all three outcomes appear within a few requests. */
const TIMEOUT_RATE = 0.5;
const ERROR_RATE = 0.9;

/** Short enough that an injected timeout costs the suite nothing. */
const TIMEOUT_MS = 20;

/** How long a wait for reported completions may take before it is a failure. */
const WAIT_TIMEOUT_MS = 5_000;

const startedServers = new Set<Server>();

afterEach(async () => {
  const servers = [...startedServers];
  startedServers.clear();
  await Promise.all(
    servers.map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.closeAllConnections();
          server.close((error) => {
            if (error) {
              reject(error);
            } else {
              resolve();
            }
          });
        }),
    ),
  );
  vi.restoreAllMocks();
});

async function listen(server: Server): Promise<AddressInfo> {
  startedServers.add(server);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();

  if (address === null || typeof address === 'string') {
    throw new Error('expected the server to be listening on a TCP port');
  }

  return address;
}

/** An upstream that answers everything, so `forwarded` is distinguishable. */
async function startUpstream(): Promise<string> {
  const { port } = await listen(
    createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
    }),
  );

  return `http://127.0.0.1:${port}`;
}

/** A proxy under test, plus the outcomes it has reported so far. */
interface SeededProxy {
  readonly baseUrl: string;
  readonly outcomes: RequestOutcome[];
}

/** Starts a proxy whose chaos decisions come from a generator seeded by `seed`. */
async function startSeededProxy(target: string, seed: string): Promise<SeededProxy> {
  const outcomes: RequestOutcome[] = [];
  const { port } = await listen(
    createProxyServer({
      target,
      timeoutRate: TIMEOUT_RATE,
      errorRate: ERROR_RATE,
      timeoutMs: TIMEOUT_MS,
      random: createSeededRandom(seed),
      onRequestComplete: (event) => {
        outcomes.push(event.outcome);
      },
    }),
  );

  return { baseUrl: `http://127.0.0.1:${port}`, outcomes };
}

/**
 * Sends `count` requests to `proxy`, one at a time, and returns what became of
 * each in order.
 *
 * A response reaching the client and the proxy reporting it are two different
 * moments, so each request is waited out completely before the next is sent.
 * That is what makes the sequence a sequence rather than an interleaving.
 */
async function outcomesOf(proxy: SeededProxy, count: number): Promise<RequestOutcome[]> {
  for (let index = 0; index < count; index += 1) {
    const response = await fetch(`${proxy.baseUrl}/api/item/${index}`);
    await response.text();

    const deadline = Date.now() + WAIT_TIMEOUT_MS;

    while (proxy.outcomes.length <= index) {
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for request ${index} to be reported`);
      }

      await new Promise<void>((resolve) => {
        setTimeout(resolve, 5);
      });
    }
  }

  return [...proxy.outcomes];
}

describe('a seeded proxy', () => {
  it('replays the same outcomes across two separate servers', async () => {
    const target = await startUpstream();
    const first = await startSeededProxy(target, 'checkout-test');
    const second = await startSeededProxy(target, 'checkout-test');

    const firstRun = await outcomesOf(first, 8);
    const secondRun = await outcomesOf(second, 8);

    expect(firstRun).toEqual(secondRun);
    // Guards the assertion above: a run of eight identical outcomes would match
    // itself no matter how the decisions were made.
    expect(new Set(firstRun).size).toBeGreaterThan(1);
  }, 30_000);

  it('produces different outcomes for a different seed', async () => {
    const target = await startUpstream();
    const checkout = await startSeededProxy(target, 'checkout-test');
    const other = await startSeededProxy(target, 'other-seed');

    expect(await outcomesOf(checkout, 8)).not.toEqual(await outcomesOf(other, 8));
  }, 30_000);

  it('draws the timeout decision first and the error decision only after it declines', async () => {
    const target = await startUpstream();
    const proxy = await startSeededProxy(target, 'checkout-test');

    // Read straight off the pinned generator output at these rates:
    //
    //   0.9149 -> no timeout, 0.9164 -> no error  => forwarded (two draws)
    //   0.4264 -> timeout                         => timeout   (one draw)
    //   0.9252 -> no timeout, 0.5844 -> error     => error
    //   0.9667 -> no timeout, 0.9313 -> no error  => forwarded
    //
    // The second request proves both halves of the ordering. It sees the third
    // value, so the first request must have taken exactly two draws; and it is
    // timed out by a value that the error rate of 0.9 would also have selected,
    // so the timeout decision is the one that saw it first.
    expect(await outcomesOf(proxy, 4)).toEqual([
      'forwarded',
      'injected:timeout',
      'injected:error',
      'forwarded',
    ]);
  }, 30_000);

  it('takes no chaos decision from Math.random once a generator is supplied', async () => {
    // Every decision would select if it were reading this.
    vi.spyOn(Math, 'random').mockReturnValue(0);

    const target = await startUpstream();
    const proxy = await startSeededProxy(target, 'checkout-test');

    // Which is emphatically not what the seed asks for.
    expect(await outcomesOf(proxy, 4)).toEqual([
      'forwarded',
      'injected:timeout',
      'injected:error',
      'forwarded',
    ]);
  }, 30_000);
});

describe('a proxy without a random function', () => {
  it('keeps the rate semantics it has always had', async () => {
    const target = await startUpstream();
    const { port } = await listen(
      createProxyServer({ target, errorRate: 1, errorStatus: 503, timeoutRate: 0 }),
    );

    const response = await fetch(`http://127.0.0.1:${port}/api/users`);

    expect(response.status).toBe(503);
    await expect(response.text()).resolves.toBe('Chaos Proxy injected error');
  }, 30_000);

  it('forwards everything when both rates are 0', async () => {
    const target = await startUpstream();
    const { port } = await listen(createProxyServer({ target }));

    const response = await fetch(`http://127.0.0.1:${port}/api/users`);

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe('ok');
  }, 30_000);
});
