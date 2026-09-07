import { createServer, request as httpRequest } from 'node:http';
import type {
  IncomingHttpHeaders,
  IncomingMessage,
  OutgoingHttpHeaders,
  Server,
  ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

import { createProxyServer } from '../../src/index.js';
import type { ProxyServerOptions } from '../../src/index.js';

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
async function startProxy(target: string, latencyMs?: number): Promise<string> {
  const options: ProxyServerOptions = latencyMs === undefined ? { target } : { target, latencyMs };
  const { port } = await start(createProxyServer(options));

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
    const proxyUrl = await startProxy(upstream.origin, 100);

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
    const proxyUrl = await startProxy(upstream.origin, 50);
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
