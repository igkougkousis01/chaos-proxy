import { createServer, request as httpRequest } from 'node:http';
import type {
  IncomingHttpHeaders,
  IncomingMessage,
  OutgoingHttpHeaders,
  Server,
  ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createProxyServer } from '../../src/index.js';
import type { ProxyServerOptions } from '../../src/index.js';
import { shouldInjectError, shouldInjectTimeout } from '../../src/proxy/server.js';

/** A request as it arrived at the temporary upstream server. */
interface RecordedRequest {
  readonly method: string | undefined;
  readonly url: string | undefined;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

interface Upstream {
  /** Origin the proxy should be pointed at, e.g. `http://127.0.0.1:53124`. */
  readonly origin: string;
  /** `host:port` of the upstream, as it should appear in the `Host` header. */
  readonly host: string;
  /** Every request the upstream received, in arrival order. */
  readonly requests: RecordedRequest[];
  /** How many TCP connections the upstream has accepted so far. */
  readonly connectionCount: () => number;
}

const startedServers = new Set<Server>();

afterEach(async () => {
  const servers = [...startedServers];
  startedServers.clear();
  await Promise.all(servers.map(stop));
  vi.restoreAllMocks();
});

function addressOf(server: Server): AddressInfo {
  const address = server.address();

  if (address === null || typeof address === 'string') {
    throw new Error('expected the server to be listening on a TCP port');
  }

  return address;
}

async function start(server: Server): Promise<AddressInfo> {
  startedServers.add(server);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  return addressOf(server);
}

async function stop(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];

  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk));
  }

  return Buffer.concat(chunks).toString('utf8');
}

/** Starts a temporary upstream server that records everything it receives. */
async function startUpstream(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<Upstream> {
  const requests: RecordedRequest[] = [];
  const server = createServer((req, res) => {
    void readBody(req).then((body) => {
      requests.push({ method: req.method, url: req.url, headers: req.headers, body });
      handler(req, res);
    });
  });
  let connections = 0;
  server.on('connection', () => {
    connections += 1;
  });
  const { port } = await start(server);

  return {
    origin: `http://127.0.0.1:${port}`,
    host: `127.0.0.1:${port}`,
    requests,
    connectionCount: () => connections,
  };
}

/** Starts a Chaos Proxy pointed at `target` and returns its base URL. */
async function startProxy(
  target: string,
  chaos: Omit<ProxyServerOptions, 'target'> = {},
): Promise<string> {
  const { port } = await start(createProxyServer({ target, ...chaos }));

  return `http://127.0.0.1:${port}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** A response as it arrived back at the client. */
interface RawResponse {
  readonly statusCode: number | undefined;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

/**
 * Sends a request with exact control over the headers put on the wire.
 *
 * `fetch` normalises and rewrites connection-level headers, so these tests use
 * the raw client instead.
 */
function rawRequest(url: string, headers: OutgoingHttpHeaders): Promise<RawResponse> {
  return new Promise<RawResponse>((resolve, reject) => {
    const req = httpRequest(url, { headers }, (res) => {
      readBody(res).then(
        (body) => resolve({ statusCode: res.statusCode, headers: res.headers, body }),
        reject,
      );
    });

    req.on('error', reject);
    req.end();
  });
}

/** Binds an ephemeral port and releases it, so nothing is listening there. */
async function findUnusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = addressOf(server);
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });

  return port;
}

describe('createProxyServer', () => {
  it('rejects a target that is not an absolute URL', () => {
    expect(() => createProxyServer({ target: 'localhost:5000' })).toThrow(TypeError);
  });

  it('rejects a target that is neither http nor https', () => {
    expect(() => createProxyServer({ target: 'ftp://example.com' })).toThrow(
      /only http: and https: are supported/,
    );
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'rejects a latencyMs of %p',
    (latencyMs) => {
      expect(() => createProxyServer({ target: 'http://localhost:5000', latencyMs })).toThrow(
        RangeError,
      );
    },
  );

  it.each([0, 250, 0.5])('accepts a latencyMs of %p', (latencyMs) => {
    expect(() => createProxyServer({ target: 'http://localhost:5000', latencyMs })).not.toThrow();
  });

  it.each([-0.1, 1.1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'rejects an errorRate of %p',
    (errorRate) => {
      expect(() => createProxyServer({ target: 'http://localhost:5000', errorRate })).toThrow(
        RangeError,
      );
    },
  );

  it.each([0, 0.25, 1])('accepts an errorRate of %p', (errorRate) => {
    expect(() => createProxyServer({ target: 'http://localhost:5000', errorRate })).not.toThrow();
  });

  it.each([399, 600, 500.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'rejects an errorStatus of %p',
    (errorStatus) => {
      expect(() => createProxyServer({ target: 'http://localhost:5000', errorStatus })).toThrow(
        RangeError,
      );
    },
  );

  it.each([400, 429, 500, 503, 599])('accepts an errorStatus of %p', (errorStatus) => {
    expect(() => createProxyServer({ target: 'http://localhost:5000', errorStatus })).not.toThrow();
  });

  it.each([-0.1, 1.1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'rejects a timeoutRate of %p',
    (timeoutRate) => {
      expect(() => createProxyServer({ target: 'http://localhost:5000', timeoutRate })).toThrow(
        RangeError,
      );
    },
  );

  it.each([0, 0.25, 1])('accepts a timeoutRate of %p', (timeoutRate) => {
    expect(() => createProxyServer({ target: 'http://localhost:5000', timeoutRate })).not.toThrow();
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'rejects a timeoutMs of %p',
    (timeoutMs) => {
      expect(() => createProxyServer({ target: 'http://localhost:5000', timeoutMs })).toThrow(
        RangeError,
      );
    },
  );

  // `0` is accepted deliberately: it answers on the next timer tick, which is a
  // useful deterministic edge case rather than a useful amount of chaos.
  it.each([0, 100, 30_000])('accepts a timeoutMs of %p', (timeoutMs) => {
    expect(() => createProxyServer({ target: 'http://localhost:5000', timeoutMs })).not.toThrow();
  });
});

describe('forwarding', () => {
  it('forwards path, query string and method, and returns the upstream response', async () => {
    const upstream = await startUpstream((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ page: 2 }));
    });
    const proxyUrl = await startProxy(upstream.origin);

    const response = await fetch(`${proxyUrl}/api/users?page=2`);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json');
    await expect(response.json()).resolves.toEqual({ page: 2 });
    expect(upstream.requests).toHaveLength(1);
    expect(upstream.requests[0]?.method).toBe('GET');
    expect(upstream.requests[0]?.url).toBe('/api/users?page=2');
  });

  it('rewrites the Host header to the target host', async () => {
    const upstream = await startUpstream((_req, res) => {
      res.end();
    });
    const proxyUrl = await startProxy(upstream.origin);

    await fetch(`${proxyUrl}/`);

    expect(upstream.requests[0]?.headers.host).toBe(upstream.host);
  });

  it.each(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])('preserves the %s method', async (method) => {
    const upstream = await startUpstream((_req, res) => {
      res.writeHead(204);
      res.end();
    });
    const proxyUrl = await startProxy(upstream.origin);

    const response = await fetch(`${proxyUrl}/things`, { method });

    expect(response.status).toBe(204);
    expect(upstream.requests[0]?.method).toBe(method);
  });

  it('forwards a JSON POST body and its content headers', async () => {
    const upstream = await startUpstream((_req, res) => {
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 7 }));
    });
    const proxyUrl = await startProxy(upstream.origin);
    const payload = JSON.stringify({ name: 'ada' });

    const response = await fetch(`${proxyUrl}/api/users`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payload,
    });

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({ id: 7 });

    const recorded = upstream.requests[0];
    expect(recorded?.method).toBe('POST');
    expect(recorded?.body).toBe(payload);
    expect(recorded?.headers['content-type']).toBe('application/json');
    expect(recorded?.headers['content-length']).toBe(String(Buffer.byteLength(payload)));
  });

  it('returns the upstream status code unchanged', async () => {
    const upstream = await startUpstream((_req, res) => {
      res.writeHead(418, { 'content-type': 'text/plain' });
      res.end('teapot');
    });
    const proxyUrl = await startProxy(upstream.origin);

    const response = await fetch(`${proxyUrl}/brew`);

    expect(response.status).toBe(418);
    await expect(response.text()).resolves.toBe('teapot');
  });

  it('drops request headers named in the client Connection header', async () => {
    const upstream = await startUpstream((_req, res) => {
      res.writeHead(204);
      res.end();
    });
    const proxyUrl = await startProxy(upstream.origin);

    const response = await rawRequest(`${proxyUrl}/api/users`, {
      connection: 'keep-alive, X-Remove-Me',
      'x-remove-me': 'secret',
      'x-keep-me': 'visible',
    });

    expect(response.statusCode).toBe(204);

    const received = upstream.requests[0]?.headers;
    expect(received?.['x-remove-me']).toBeUndefined();
    expect(received?.['x-keep-me']).toBe('visible');
    // Node sets its own transport-level Connection header on the upstream
    // request, so assert only that the client's value did not survive.
    expect((received?.connection ?? '').toLowerCase()).not.toContain('x-remove-me');
  });

  it('drops response headers named in the upstream Connection header', async () => {
    const upstream = await startUpstream((_req, res) => {
      res.writeHead(200, {
        connection: 'keep-alive, X-Upstream-Hop',
        'x-upstream-hop': 'secret',
        'x-normal-header': 'visible',
      });
      res.end('ok');
    });
    const proxyUrl = await startProxy(upstream.origin);

    const response = await rawRequest(`${proxyUrl}/api/users`, {});

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('ok');
    expect(response.headers['x-upstream-hop']).toBeUndefined();
    expect(response.headers['x-normal-header']).toBe('visible');
    // As above: the proxy's own Connection header is Node's, not the upstream's.
    expect((response.headers.connection ?? '').toLowerCase()).not.toContain('x-upstream-hop');
  });

  it('answers 502 without crashing when the upstream is unreachable', async () => {
    const proxyUrl = await startProxy(`http://127.0.0.1:${await findUnusedPort()}`);

    const first = await fetch(`${proxyUrl}/api/users`);
    expect(first.status).toBe(502);

    // The proxy is still serving, so the failure did not take the process down.
    const second = await fetch(`${proxyUrl}/api/users`);
    expect(second.status).toBe(502);
  });
});

describe('latency injection', () => {
  it('adds no artificial delay when latencyMs is omitted', async () => {
    const upstream = await startUpstream((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
    });
    const proxyUrl = await startProxy(upstream.origin);

    const startedAt = performance.now();
    const response = await fetch(`${proxyUrl}/api/users`);
    const elapsed = performance.now() - startedAt;

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe('ok');
    expect(upstream.requests).toHaveLength(1);
    // Generous on purpose: this asserts that no latency is *configured*, not
    // that a loopback round trip is fast.
    expect(elapsed).toBeLessThan(500);
  });

  it('delays the start of the upstream request by the configured latency', async () => {
    const arrivals: number[] = [];
    const upstream = await startUpstream((_req, res) => {
      arrivals.push(performance.now());
      res.writeHead(204);
      res.end();
    });
    const proxyUrl = await startProxy(upstream.origin, { latencyMs: 100 });

    const startedAt = performance.now();
    const response = await fetch(`${proxyUrl}/api/users`);

    expect(response.status).toBe(204);
    expect(arrivals).toHaveLength(1);
    // Lower bound only, with slack for timer coarseness and loaded CI runners.
    expect((arrivals[0] ?? 0) - startedAt).toBeGreaterThanOrEqual(75);
  });

  it('still forwards status, headers and body after the delay', async () => {
    const upstream = await startUpstream((_req, res) => {
      res.writeHead(201, { 'content-type': 'application/json', 'x-upstream': 'yes' });
      res.end(JSON.stringify({ id: 7 }));
    });
    const proxyUrl = await startProxy(upstream.origin, { latencyMs: 50 });
    const payload = JSON.stringify({ name: 'ada' });

    const response = await fetch(`${proxyUrl}/api/users?page=2`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payload,
    });

    expect(response.status).toBe(201);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(response.headers.get('x-upstream')).toBe('yes');
    await expect(response.json()).resolves.toEqual({ id: 7 });

    const recorded = upstream.requests[0];
    expect(recorded?.method).toBe('POST');
    expect(recorded?.url).toBe('/api/users?page=2');
    expect(recorded?.body).toBe(payload);
    expect(recorded?.headers.host).toBe(upstream.host);
  });

  it('never opens the upstream request when the client disconnects during the delay', async () => {
    const latencyMs = 200;
    const upstream = await startUpstream((_req, res) => {
      res.writeHead(204);
      res.end();
    });
    const proxy = createProxyServer({ target: upstream.origin, latencyMs });
    // The proxy's own handler is registered first, so by the time this resolves
    // the delay timer has already been started for this request.
    const delayStarted = new Promise<void>((resolve) => {
      proxy.once('request', () => {
        resolve();
      });
    });
    const { port } = await start(proxy);

    const req = httpRequest(`http://127.0.0.1:${port}/api/users`);
    req.on('error', () => {
      // Expected: the client aborts itself below.
    });
    req.end();

    await delayStarted;
    req.destroy();

    await sleep(latencyMs * 2);
    expect(upstream.requests).toHaveLength(0);
    // The stronger signal: without cancellation the proxy still dials upstream
    // after the delay, even though the aborted body pipe stops the headers.
    expect(upstream.connectionCount()).toBe(0);
  });
});

describe('shouldInjectError', () => {
  it.each([
    [0.25, true],
    [0.75, false],
  ])('injects for a random value of %p at an errorRate of 0.5: %p', (value, expected) => {
    expect(shouldInjectError(0.5, () => value)).toBe(expected);
  });

  it('never injects at an errorRate of 0', () => {
    expect(shouldInjectError(0, () => 0)).toBe(false);
  });

  it('always injects at an errorRate of 1', () => {
    // The largest value Math.random() can return is just below 1.
    expect(shouldInjectError(1, () => 0.999999999999999)).toBe(true);
  });
});

describe('error injection', () => {
  it('forwards every request when errorRate is 0', async () => {
    const upstream = await startUpstream((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
    });
    const proxyUrl = await startProxy(upstream.origin, { errorRate: 0 });

    for (const path of ['/one', '/two', '/three']) {
      const response = await fetch(`${proxyUrl}${path}`);
      expect(response.status).toBe(200);
      await expect(response.text()).resolves.toBe('ok');
    }

    expect(upstream.requests).toHaveLength(3);
  });

  it('answers with a synthetic error and never reaches the upstream when errorRate is 1', async () => {
    const upstream = await startUpstream((_req, res) => {
      res.writeHead(200);
      res.end('should not be reached');
    });
    const proxyUrl = await startProxy(upstream.origin, { errorRate: 1 });

    const response = await fetch(`${proxyUrl}/api/users?page=2`);

    expect(response.status).toBe(500);
    expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    await expect(response.text()).resolves.toBe('Chaos Proxy injected error');
    expect(upstream.requests).toHaveLength(0);
    expect(upstream.connectionCount()).toBe(0);
  });

  it('rejects a request with a body without forwarding or hanging', async () => {
    const upstream = await startUpstream((_req, res) => {
      res.writeHead(200);
      res.end('should not be reached');
    });
    const proxyUrl = await startProxy(upstream.origin, { errorRate: 1 });

    const response = await fetch(`${proxyUrl}/api/users`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'ada' }),
    });

    expect(response.status).toBe(500);
    await expect(response.text()).resolves.toBe('Chaos Proxy injected error');
    expect(upstream.requests).toHaveLength(0);
    expect(upstream.connectionCount()).toBe(0);

    // The proxy is still serving, so the unread body did not wedge it.
    const next = await fetch(`${proxyUrl}/api/users`);
    expect(next.status).toBe(500);
  });

  it('returns the configured errorStatus', async () => {
    const upstream = await startUpstream((_req, res) => {
      res.writeHead(200);
      res.end('should not be reached');
    });
    const proxyUrl = await startProxy(upstream.origin, { errorRate: 1, errorStatus: 503 });

    const response = await fetch(`${proxyUrl}/api/users`);

    expect(response.status).toBe(503);
    await expect(response.text()).resolves.toBe('Chaos Proxy injected error');
    expect(upstream.requests).toHaveLength(0);
  });

  it('injects the error only after the configured latency has elapsed', async () => {
    const upstream = await startUpstream((_req, res) => {
      res.writeHead(200);
      res.end('should not be reached');
    });
    const proxyUrl = await startProxy(upstream.origin, { latencyMs: 100, errorRate: 1 });

    const startedAt = performance.now();
    const response = await fetch(`${proxyUrl}/api/users`);
    const elapsed = performance.now() - startedAt;

    expect(response.status).toBe(500);
    await expect(response.text()).resolves.toBe('Chaos Proxy injected error');
    // Lower bound only, with slack for timer coarseness and loaded CI runners.
    expect(elapsed).toBeGreaterThanOrEqual(75);
    expect(upstream.requests).toHaveLength(0);
    expect(upstream.connectionCount()).toBe(0);
  });

  it('injects nothing when the client disconnects during the delay', async () => {
    const latencyMs = 200;
    const upstream = await startUpstream((_req, res) => {
      res.writeHead(200);
      res.end('should not be reached');
    });
    const proxy = createProxyServer({ target: upstream.origin, latencyMs, errorRate: 1 });
    const delayStarted = new Promise<void>((resolve) => {
      proxy.once('request', () => {
        resolve();
      });
    });
    const { port } = await start(proxy);
    const proxyUrl = `http://127.0.0.1:${port}`;

    const req = httpRequest(`${proxyUrl}/api/users`);
    req.on('error', () => {
      // Expected: the client aborts itself below.
    });
    req.end();

    await delayStarted;
    req.destroy();
    await sleep(latencyMs * 2);

    expect(upstream.connectionCount()).toBe(0);
    // Writing to the gone client did not take the proxy down.
    const response = await fetch(`${proxyUrl}/api/users`);
    expect(response.status).toBe(500);
  });
});

describe('shouldInjectTimeout', () => {
  it.each([
    [0.25, true],
    [0.75, false],
  ])('injects for a random value of %p at a timeoutRate of 0.5: %p', (value, expected) => {
    expect(shouldInjectTimeout(0.5, () => value)).toBe(expected);
  });

  it('never injects at a timeoutRate of 0', () => {
    expect(shouldInjectTimeout(0, () => 0)).toBe(false);
  });

  it('always injects at a timeoutRate of 1', () => {
    // The largest value Math.random() can return is just below 1.
    expect(shouldInjectTimeout(1, () => 0.999999999999999)).toBe(true);
  });

  it('is drawn before the error rate, which only sees the requests it declines', () => {
    // Mirrors the order the request handler applies the two predicates in, with
    // scripted draws standing in for Math.random(). The rates are sequential,
    // not independent: at timeoutRate 0.5 and errorRate 1, the half that is not
    // timed out is what the error rate is applied to.
    const draws = [0.25, 0.75, 0.5];
    const next = (): number => draws.shift() ?? 0;

    // First request: timed out, so the error rate is never consulted.
    expect(shouldInjectTimeout(0.5, next)).toBe(true);

    // Second request: not timed out, so it falls through to the error rate.
    expect(shouldInjectTimeout(0.5, next)).toBe(false);
    expect(shouldInjectError(1, next)).toBe(true);
  });
});

describe('timeout injection', () => {
  it('forwards every request when timeoutRate is 0', async () => {
    const upstream = await startUpstream((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
    });
    const proxyUrl = await startProxy(upstream.origin, { timeoutRate: 0, timeoutMs: 100 });

    const response = await fetch(`${proxyUrl}/api/users`);

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe('ok');
    expect(upstream.requests).toHaveLength(1);
  });

  it('holds the request and answers 504 without reaching the upstream when timeoutRate is 1', async () => {
    const upstream = await startUpstream((_req, res) => {
      res.writeHead(200);
      res.end('should not be reached');
    });
    const proxyUrl = await startProxy(upstream.origin, { timeoutRate: 1, timeoutMs: 100 });

    const startedAt = performance.now();
    const response = await fetch(`${proxyUrl}/api/users?page=2`);
    const elapsed = performance.now() - startedAt;

    expect(response.status).toBe(504);
    expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    await expect(response.text()).resolves.toBe('Chaos Proxy injected timeout');
    // Lower bound only, with slack for timer coarseness and loaded CI runners:
    // the point is that the response was held, not that it took exactly 100 ms.
    expect(elapsed).toBeGreaterThanOrEqual(75);
    expect(upstream.requests).toHaveLength(0);
    expect(upstream.connectionCount()).toBe(0);
  });

  it('answers on the next tick when timeoutMs is 0', async () => {
    const upstream = await startUpstream((_req, res) => {
      res.writeHead(200);
      res.end('should not be reached');
    });
    const proxyUrl = await startProxy(upstream.origin, { timeoutRate: 1, timeoutMs: 0 });

    const response = await fetch(`${proxyUrl}/api/users`);

    expect(response.status).toBe(504);
    await expect(response.text()).resolves.toBe('Chaos Proxy injected timeout');
    expect(upstream.connectionCount()).toBe(0);
  });

  it('times a request with a body out without forwarding or hanging', async () => {
    const upstream = await startUpstream((_req, res) => {
      res.writeHead(200);
      res.end('should not be reached');
    });
    const proxyUrl = await startProxy(upstream.origin, { timeoutRate: 1, timeoutMs: 50 });

    const response = await fetch(`${proxyUrl}/api/users`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'ada' }),
    });

    expect(response.status).toBe(504);
    await expect(response.text()).resolves.toBe('Chaos Proxy injected timeout');
    expect(upstream.requests).toHaveLength(0);
    expect(upstream.connectionCount()).toBe(0);

    // The proxy is still serving, so the never-read body did not wedge it.
    const next = await fetch(`${proxyUrl}/api/users`);
    expect(next.status).toBe(504);
  });

  it('waits for the latency and then the timeout, in that order', async () => {
    const upstream = await startUpstream((_req, res) => {
      res.writeHead(200);
      res.end('should not be reached');
    });
    const proxyUrl = await startProxy(upstream.origin, {
      latencyMs: 100,
      timeoutRate: 1,
      timeoutMs: 100,
    });

    const startedAt = performance.now();
    const response = await fetch(`${proxyUrl}/api/users`);
    const elapsed = performance.now() - startedAt;

    expect(response.status).toBe(504);
    await expect(response.text()).resolves.toBe('Chaos Proxy injected timeout');
    // Both stages are paid: a lower bound comfortably above either one alone,
    // with slack instead of an exact 200 ms.
    expect(elapsed).toBeGreaterThanOrEqual(150);
    expect(upstream.connectionCount()).toBe(0);
  });

  it('answers 504 rather than the synthetic error when both are certain', async () => {
    const upstream = await startUpstream((_req, res) => {
      res.writeHead(200);
      res.end('should not be reached');
    });
    const proxyUrl = await startProxy(upstream.origin, {
      timeoutRate: 1,
      timeoutMs: 50,
      errorRate: 1,
      errorStatus: 503,
    });

    const response = await fetch(`${proxyUrl}/api/users`);

    // The timeout is drawn first, so the error rate never gets to decide.
    expect(response.status).toBe(504);
    await expect(response.text()).resolves.toBe('Chaos Proxy injected timeout');
    expect(upstream.connectionCount()).toBe(0);
  });

  it('falls through to the synthetic error when the timeout is not selected', async () => {
    const upstream = await startUpstream((_req, res) => {
      res.writeHead(200);
      res.end('should not be reached');
    });
    const proxyUrl = await startProxy(upstream.origin, {
      timeoutRate: 0,
      timeoutMs: 50,
      errorRate: 1,
    });

    const response = await fetch(`${proxyUrl}/api/users`);

    expect(response.status).toBe(500);
    await expect(response.text()).resolves.toBe('Chaos Proxy injected error');
    expect(upstream.connectionCount()).toBe(0);
  });

  it('cancels the timeout when the client disconnects while it is pending', async () => {
    // A distinctive duration, so the pending timer can be picked out of any
    // other timer the runtime happens to schedule during the test.
    const timeoutMs = 137;
    const upstream = await startUpstream((_req, res) => {
      res.writeHead(200);
      res.end('should not be reached');
    });
    const scheduled = vi.spyOn(globalThis, 'setTimeout');
    const cleared = vi.spyOn(globalThis, 'clearTimeout');
    const proxy = createProxyServer({ target: upstream.origin, timeoutRate: 1, timeoutMs });
    // The proxy's own handler is registered first, so by the time this resolves
    // the timeout timer has already been started for this request.
    const waitStarted = new Promise<void>((resolve) => {
      proxy.once('request', () => {
        resolve();
      });
    });
    const { port } = await start(proxy);
    const proxyUrl = `http://127.0.0.1:${port}`;

    let responded = false;
    const req = httpRequest(`${proxyUrl}/api/users`, () => {
      responded = true;
    });
    req.on('error', () => {
      // Expected: the client aborts itself below.
    });
    req.end();

    await waitStarted;
    const index = scheduled.mock.calls.findIndex(([, delay]) => delay === timeoutMs);
    expect(index).toBeGreaterThanOrEqual(0);
    const pendingTimer: unknown = scheduled.mock.results[index]?.value;

    req.destroy();
    await sleep(timeoutMs * 2);

    // The pending timer was cleared rather than left to fire at a gone client,
    // nothing was written back, and no upstream connection was ever opened.
    expect(cleared).toHaveBeenCalledWith(pendingTimer);
    expect(responded).toBe(false);
    expect(upstream.connectionCount()).toBe(0);

    // The proxy is still healthy: a later request is still timed out normally.
    const response = await fetch(`${proxyUrl}/api/users`);
    expect(response.status).toBe(504);
    await expect(response.text()).resolves.toBe('Chaos Proxy injected timeout');
  });
});

describe('per-request chaos', () => {
  it('leaves the static options in charge when no resolver is given', async () => {
    const upstream = await startUpstream((_req, res) => {
      res.writeHead(200);
      res.end('ok');
    });
    const proxyUrl = await startProxy(upstream.origin, { errorRate: 1, errorStatus: 503 });

    const response = await fetch(`${proxyUrl}/anything`);

    expect(response.status).toBe(503);
  });

  it('applies what the resolver returns to that request only', async () => {
    const upstream = await startUpstream((_req, res) => {
      res.writeHead(200);
      res.end('upstream ok');
    });
    const { port } = await start(
      createProxyServer({
        target: upstream.origin,
        resolveChaos: (request) =>
          request.url?.startsWith('/fail') === true ? { errorRate: 1, errorStatus: 503 } : {},
      }),
    );
    const proxyUrl = `http://127.0.0.1:${port}`;

    const failed = await fetch(`${proxyUrl}/fail/now`);
    const forwarded = await fetch(`${proxyUrl}/healthy`);

    expect(failed.status).toBe(503);
    await expect(failed.text()).resolves.toBe('Chaos Proxy injected error');
    expect(forwarded.status).toBe(200);
    await expect(forwarded.text()).resolves.toBe('upstream ok');
    expect(upstream.requests.map((request) => request.url)).toEqual(['/healthy']);
  });

  it('is consulted once per request, with that request', async () => {
    const upstream = await startUpstream((_req, res) => {
      res.writeHead(200);
      res.end('ok');
    });
    const seen: (string | undefined)[] = [];
    const { port } = await start(
      createProxyServer({
        target: upstream.origin,
        resolveChaos: (request) => {
          seen.push(request.url);
          return {};
        },
      }),
    );

    await fetch(`http://127.0.0.1:${port}/api/users?page=2`);
    await fetch(`http://127.0.0.1:${port}/api/orders`);

    expect(seen).toEqual(['/api/users?page=2', '/api/orders']);
  });

  it('layers what the resolver returns over the static options', async () => {
    const upstream = await startUpstream((_req, res) => {
      res.writeHead(200);
      res.end('ok');
    });
    const { port } = await start(
      createProxyServer({
        target: upstream.origin,
        errorRate: 1,
        errorStatus: 500,
        // Only the status is overridden; the rate the server was created with
        // is left exactly as it was.
        resolveChaos: () => ({ errorStatus: 503 }),
      }),
    );

    const response = await fetch(`http://127.0.0.1:${port}/api/users`);

    expect(response.status).toBe(503);
  });

  it('keeps the static options for a request the resolver says nothing about', async () => {
    const upstream = await startUpstream((_req, res) => {
      res.writeHead(200);
      res.end('ok');
    });
    const { port } = await start(
      createProxyServer({
        target: upstream.origin,
        errorRate: 1,
        errorStatus: 503,
        resolveChaos: () => ({}),
      }),
    );

    const response = await fetch(`http://127.0.0.1:${port}/api/users`);

    expect(response.status).toBe(503);
  });

  it('applies resolved latency before deciding anything else', async () => {
    const upstream = await startUpstream((_req, res) => {
      res.writeHead(200);
      res.end('ok');
    });
    const { port } = await start(
      createProxyServer({
        target: upstream.origin,
        resolveChaos: () => ({ latencyMs: 200, errorRate: 1, errorStatus: 503 }),
      }),
    );

    const startedAt = performance.now();
    const response = await fetch(`http://127.0.0.1:${port}/api/users`);
    const elapsed = performance.now() - startedAt;

    expect(response.status).toBe(503);
    expect(elapsed).toBeGreaterThanOrEqual(150);
    expect(upstream.connectionCount()).toBe(0);
  });

  // A misbehaving resolver is a defect in the caller's configuration, not a
  // reason to take the whole process down with an uncaught exception.
  it.each([
    ['returns a value out of range', () => ({ errorRate: 5 })],
    [
      'throws',
      () => {
        throw new Error('resolver exploded');
      },
    ],
  ])('answers 500 when the resolver %s, and stays up', async (_what, resolveChaos) => {
    const upstream = await startUpstream((_req, res) => {
      res.writeHead(200);
      res.end('upstream ok');
    });
    let broken = true;
    const { port } = await start(
      createProxyServer({
        target: upstream.origin,
        resolveChaos: () => (broken ? resolveChaos() : {}),
      }),
    );
    const proxyUrl = `http://127.0.0.1:${port}`;

    const failed = await fetch(`${proxyUrl}/api/users`);

    expect(failed.status).toBe(500);
    await expect(failed.text()).resolves.toBe('Chaos Proxy configuration error');
    expect(upstream.connectionCount()).toBe(0);

    broken = false;
    const recovered = await fetch(`${proxyUrl}/api/users`);

    expect(recovered.status).toBe(200);
    await expect(recovered.text()).resolves.toBe('upstream ok');
  });
});
