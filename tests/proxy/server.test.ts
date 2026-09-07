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
  const { port } = await start(server);

  return { origin: `http://127.0.0.1:${port}`, host: `127.0.0.1:${port}`, requests };
}

/** Starts a Chaos Proxy pointed at `target` and returns its base URL. */
async function startProxy(target: string): Promise<string> {
  const { port } = await start(createProxyServer({ target }));

  return `http://127.0.0.1:${port}`;
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
