import { createServer, request as httpRequest } from 'node:http';
import type {
  IncomingHttpHeaders,
  IncomingMessage,
  OutgoingHttpHeaders,
  Server,
  ServerResponse,
} from 'node:http';
import { request as httpsRequest } from 'node:https';

/** Options accepted by {@link createProxyServer}. */
export interface ProxyServerOptions {
  /**
   * Absolute URL of the API to forward requests to, for example
   * `http://localhost:5000`. Only `http:` and `https:` are supported.
   *
   * Only the origin is used; any path on the target is ignored.
   */
  readonly target: string;

  /**
   * Fixed artificial delay, in milliseconds, applied once per request before
   * the upstream request is opened. Omitted or `0` means no delay.
   *
   * The delay only postpones the start of forwarding; request and response
   * bodies still stream through untouched.
   */
  readonly latencyMs?: number;
}

/**
 * Headers that describe a single connection rather than the message itself.
 * They must not be passed on to the next hop.
 *
 * @see https://www.rfc-editor.org/rfc/rfc9110#section-7.6.1
 */
const HOP_BY_HOP_HEADERS: ReadonlySet<string> = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/** Base used to parse the request target; only its path and query are kept. */
const REQUEST_TARGET_BASE = 'http://request.invalid';

/**
 * Parses and validates the configured target.
 *
 * @throws {TypeError} If the target is not an absolute `http:` or `https:` URL.
 */
function parseTarget(target: string): URL {
  let url: URL;

  try {
    url = new URL(target);
  } catch {
    throw new TypeError(
      `Invalid proxy target ${JSON.stringify(target)}: expected an absolute URL such as "http://localhost:5000".`,
    );
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TypeError(
      `Unsupported proxy target protocol "${url.protocol}" in ${JSON.stringify(target)}: only http: and https: are supported.`,
    );
  }

  return url;
}

/**
 * Validates the configured latency and normalises "no latency" to `0`.
 *
 * @throws {RangeError} If the latency is negative, `NaN`, or infinite.
 */
function parseLatencyMs(latencyMs: number | undefined): number {
  if (latencyMs === undefined) {
    return 0;
  }

  if (!Number.isFinite(latencyMs) || latencyMs < 0) {
    throw new RangeError(
      `Invalid latencyMs ${String(latencyMs)}: expected a finite number of milliseconds >= 0.`,
    );
  }

  return latencyMs;
}

/**
 * Lower-cased header names listed in a message's `Connection` header, which
 * marks them as connection-specific for that message only.
 *
 * @see https://www.rfc-editor.org/rfc/rfc9110#section-7.6.1
 */
function connectionSpecificHeaders(connection: string | string[] | undefined): ReadonlySet<string> {
  const names = new Set<string>();
  const values = typeof connection === 'string' ? [connection] : (connection ?? []);

  for (const value of values) {
    for (const token of value.split(',')) {
      const name = token.trim().toLowerCase();

      if (name !== '') {
        names.add(name);
      }
    }
  }

  return names;
}

/** Copies headers, dropping the ones that belong to the previous hop. */
function forwardableHeaders(headers: IncomingHttpHeaders): OutgoingHttpHeaders {
  const connectionSpecific = connectionSpecificHeaders(headers.connection);
  const forwardable: OutgoingHttpHeaders = {};

  for (const [name, value] of Object.entries(headers)) {
    const lowercased = name.toLowerCase();

    if (
      value === undefined ||
      HOP_BY_HOP_HEADERS.has(lowercased) ||
      connectionSpecific.has(lowercased)
    ) {
      continue;
    }

    forwardable[name] = value;
  }

  return forwardable;
}

/** Builds the upstream URL, keeping the incoming path and query string. */
function upstreamUrlFor(requestTarget: string, target: URL): URL {
  const incoming = new URL(requestTarget, REQUEST_TARGET_BASE);
  const upstream = new URL(target.origin);

  upstream.pathname = incoming.pathname;
  upstream.search = incoming.search;

  return upstream;
}

/** Ends the response with a plain-text proxy error, if nothing was sent yet. */
function sendProxyError(res: ServerResponse, statusCode: number, body: string): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }

  res.writeHead(statusCode, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(body);
}

/** Forwards one client request upstream and streams the response back. */
function forward(req: IncomingMessage, res: ServerResponse, target: URL): void {
  let upstreamUrl: URL;

  try {
    upstreamUrl = upstreamUrlFor(req.url ?? '/', target);
  } catch {
    sendProxyError(res, 400, 'Bad Request');
    return;
  }

  const headers = forwardableHeaders(req.headers);
  headers.host = target.host;

  const sendUpstream = upstreamUrl.protocol === 'https:' ? httpsRequest : httpRequest;
  const upstreamReq = sendUpstream(upstreamUrl, { method: req.method, headers });

  upstreamReq.on('error', () => {
    sendProxyError(res, 502, 'Bad Gateway');
  });

  upstreamReq.on('response', (upstreamRes) => {
    res.writeHead(upstreamRes.statusCode ?? 502, forwardableHeaders(upstreamRes.headers));
    upstreamRes.on('error', () => {
      res.destroy();
    });
    upstreamRes.pipe(res);
  });

  req.on('error', () => {
    upstreamReq.destroy();
  });

  // Covers both normal completion and the client disconnecting early.
  res.on('close', () => {
    upstreamReq.destroy();
  });

  req.pipe(upstreamReq);
}

/**
 * Waits `latencyMs` before forwarding, so the artificial delay is paid once at
 * request initiation rather than per body chunk.
 *
 * The incoming request is left unread while waiting, so its body stays in the
 * socket under normal backpressure instead of being buffered here. If the
 * client goes away first, the timer is cleared and no upstream request is made.
 */
function forwardAfter(
  latencyMs: number,
  req: IncomingMessage,
  res: ServerResponse,
  target: URL,
): void {
  const timer = setTimeout(() => {
    res.off('close', cancel);
    forward(req, res, target);
  }, latencyMs);

  function cancel(): void {
    clearTimeout(timer);
  }

  res.once('close', cancel);
}

/**
 * Creates a proxy server that forwards every request to `target` and streams
 * the upstream response back to the client.
 *
 * The returned server is not listening yet; start it with `server.listen(port)`
 * and stop it with `server.close()`.
 *
 * @throws {TypeError} If `target` is not an absolute `http:` or `https:` URL.
 * @throws {RangeError} If `latencyMs` is negative, `NaN`, or infinite.
 */
export function createProxyServer(options: ProxyServerOptions): Server {
  const target = parseTarget(options.target);
  const latencyMs = parseLatencyMs(options.latencyMs);

  return createServer((req, res) => {
    if (latencyMs === 0) {
      forward(req, res, target);
      return;
    }

    forwardAfter(latencyMs, req, res, target);
  });
}
