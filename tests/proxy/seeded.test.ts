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

/** Rates chosen so that all four outcomes appear within a few requests. */
const RESET_RATE = 0.5;
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
      resetRate: RESET_RATE,
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
 *
 * A request the proxy resets never becomes a response at all, so the rejection
 * is swallowed here: the outcome the proxy reported is what is being collected,
 * and what the transport failure was called on this platform is not.
 */
async function outcomesOf(proxy: SeededProxy, count: number): Promise<RequestOutcome[]> {
  for (let index = 0; index < count; index += 1) {
    try {
      const response = await fetch(`${proxy.baseUrl}/api/item/${index}`);
      await response.text();
    } catch {
      // Expected for a reset request; see above.
    }

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

  it('draws reset, then timeout, then error, taking each only after the last declined', async () => {
    const target = await startUpstream();
    const proxy = await startSeededProxy(target, 'checkout-test');

    // Read straight off the pinned generator output at these rates
    // (resetRate 0.5, timeoutRate 0.5, errorRate 0.9):
    //
    //   1: 0.9149 no reset, 0.9164 no timeout, 0.4264 error => error   (3 draws)
    //   2: 0.9252 no reset, 0.5844 no timeout, 0.9667 none  => forward (3 draws)
    //   3: 0.9313 no reset, 0.0143 timeout                  => timeout (2 draws)
    //   4: 0.5000 reset                                     => reset   (1 draw)
    //   5: 0.1050 reset                                     => reset   (1 draw)
    //   6: 0.6728 no reset, 0.2700 timeout                  => timeout (2 draws)
    //
    // Every part of the ordering is pinned by which value each request lands
    // on. The fourth and fifth requests are reset by values the timeout rate
    // would also have selected, so the reset decision is the one that saw them
    // first; each takes a single value and the sixth follows immediately on the
    // next, so a reset consumes exactly one draw and neither later decision is
    // consulted for it. The third and sixth are timed out by values the error
    // rate of 0.9 would also have taken, so the timeout decision outranks the
    // error decision and stops at its own draw.
    expect(await outcomesOf(proxy, 6)).toEqual([
      'injected:error',
      'forwarded',
      'injected:timeout',
      'connection:reset',
      'connection:reset',
      'injected:timeout',
    ]);
  }, 30_000);

  it('takes no chaos decision from Math.random once a generator is supplied', async () => {
    // Every decision would select if it were reading this.
    vi.spyOn(Math, 'random').mockReturnValue(0);

    const target = await startUpstream();
    const proxy = await startSeededProxy(target, 'checkout-test');

    // Which is emphatically not what the seed asks for: reading Math.random
    // would reset every one of these.
    expect(await outcomesOf(proxy, 6)).toEqual([
      'injected:error',
      'forwarded',
      'injected:timeout',
      'connection:reset',
      'connection:reset',
      'injected:timeout',
    ]);
  }, 30_000);
});

describe('a proxy without a random function', () => {
  it('keeps the rate semantics it has always had', async () => {
    const target = await startUpstream();
    const { port } = await listen(
      createProxyServer({ target, errorRate: 1, errorStatus: 503, timeoutRate: 0, resetRate: 0 }),
    );

    const response = await fetch(`http://127.0.0.1:${port}/api/users`);

    expect(response.status).toBe(503);
    await expect(response.text()).resolves.toBe('Chaos Proxy injected error');
  }, 30_000);

  it('forwards everything when every rate is 0', async () => {
    const target = await startUpstream();
    const { port } = await listen(createProxyServer({ target }));

    const response = await fetch(`http://127.0.0.1:${port}/api/users`);

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe('ok');
  }, 30_000);
});
