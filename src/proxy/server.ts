import { createServer, request as httpRequest } from 'node:http';
import type {
  IncomingHttpHeaders,
  IncomingMessage,
  OutgoingHttpHeaders,
  Server,
  ServerResponse,
} from 'node:http';
import { request as httpsRequest } from 'node:https';

/**
 * The chaos a request can be subjected to.
 *
 * Every field is optional, and an omitted one means "no chaos of this kind" —
 * except {@link errorStatus} and {@link timeoutMs}, which only choose how an
 * injected error or timeout is shaped and have their own defaults.
 *
 * The same shape is used for the static configuration handed to
 * {@link createProxyServer} and for whatever a {@link ProxyServerOptions.resolveChaos}
 * function returns for a single request, so both are validated by exactly the
 * same rules.
 */
export interface ChaosOptions {
  /**
   * Fixed artificial delay, in milliseconds, applied once per request before
   * the upstream request is opened. Omitted or `0` means no delay.
   *
   * The delay only postpones the start of forwarding; request and response
   * bodies still stream through untouched.
   */
  readonly latencyMs?: number;

  /**
   * Probability, from `0` to `1`, that a request is answered with a synthetic
   * error instead of being forwarded upstream. Omitted or `0` means never.
   *
   * The decision is made per request, after any {@link latencyMs} delay.
   */
  readonly errorRate?: number;

  /**
   * Status code returned by an injected error. Must be an integer HTTP error
   * status in the `400`-`599` range. Defaults to `500`.
   */
  readonly errorStatus?: number;

  /**
   * Probability, from `0` to `1`, that a request is held open and then answered
   * with a synthetic timeout instead of being forwarded upstream. Omitted or
   * `0` means never.
   *
   * The decision is made per request, after any {@link latencyMs} delay and
   * before {@link errorRate}, so a request selected for a timeout is never also
   * given a synthetic HTTP error.
   */
  readonly timeoutRate?: number;

  /**
   * How long, in milliseconds, an injected timeout holds the request open
   * before the proxy answers `504 Gateway Timeout`. Defaults to `30000`.
   *
   * `0` is allowed and means the `504` is sent on the next timer tick, without
   * waiting: a deterministic edge case rather than a useful amount of chaos.
   */
  readonly timeoutMs?: number;
}

/**
 * A {@link ChaosOptions} with every default filled in.
 *
 * @internal Not part of the public API; it names what {@link resolveChaosOptions}
 * hands back, and never appears in a signature a consumer of the package calls.
 */
export interface ResolvedChaosOptions {
  readonly latencyMs: number;
  readonly errorRate: number;
  readonly errorStatus: number;
  readonly timeoutRate: number;
  readonly timeoutMs: number;
}

/** Options accepted by {@link createProxyServer}. */
export interface ProxyServerOptions extends ChaosOptions {
  /**
   * Absolute URL of the API to forward requests to, for example
   * `http://localhost:5000`. Only `http:` and `https:` are supported.
   *
   * Only the origin is used; any path on the target is ignored.
   */
  readonly target: string;

  /**
   * Optional hook that chooses the chaos for one request, so different requests
   * can be treated differently — per-endpoint rules, for example.
   *
   * Whatever it returns is layered over the static chaos options above: a field
   * it leaves out keeps the static value, and a field it sets replaces it for
   * that request only. Nothing is mutated, and the same validation applies, so
   * a returned value outside its documented range is rejected.
   *
   * The proxy core knows nothing about where these decisions come from; it is
   * the caller's job to translate its own configuration into chaos options.
   */
  readonly resolveChaos?: (request: IncomingMessage) => ChaosOptions;
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

/** Status returned by an injected error when `errorStatus` is omitted. */
const DEFAULT_ERROR_STATUS = 500;

/** Body of an injected error response, so it is recognisable in a client. */
const INJECTED_ERROR_BODY = 'Chaos Proxy injected error';

/** Status returned by an injected timeout once its wait has elapsed. */
const INJECTED_TIMEOUT_STATUS = 504;

/** Body of an injected timeout response, so it is recognisable in a client. */
const INJECTED_TIMEOUT_BODY = 'Chaos Proxy injected timeout';

/** Wait before an injected timeout answers when `timeoutMs` is omitted. */
const DEFAULT_TIMEOUT_MS = 30_000;

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
 * Validates one of the configured durations and applies its default.
 *
 * @throws {RangeError} If the duration is negative, `NaN`, or infinite.
 */
function parseDurationMs(value: number | undefined, name: string, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }

  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(
      `Invalid ${name} ${String(value)}: expected a finite number of milliseconds >= 0.`,
    );
  }

  return value;
}

/**
 * Validates one of the configured chaos rates and normalises "never" to `0`.
 *
 * Invalid values are rejected rather than clamped, so a typo cannot silently
 * turn into a different amount of chaos.
 *
 * @throws {RangeError} If the rate is outside `0`-`1`, `NaN`, or infinite.
 */
function parseRate(value: number | undefined, name: string, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }

  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError(
      `Invalid ${name} ${String(value)}: expected a number between 0 and 1 inclusive.`,
    );
  }

  return value;
}

/**
 * Validates the configured error status and applies the default.
 *
 * Only client and server error statuses are accepted: injecting a success or
 * redirect status would not exercise an application's failure handling.
 *
 * @throws {RangeError} If the status is not an integer in the `400`-`599` range.
 */
function parseErrorStatus(errorStatus: number | undefined, fallback: number): number {
  if (errorStatus === undefined) {
    return fallback;
  }

  if (!Number.isInteger(errorStatus) || errorStatus < 400 || errorStatus > 599) {
    throw new RangeError(
      `Invalid errorStatus ${String(errorStatus)}: expected an integer HTTP error status between 400 and 599.`,
    );
  }

  return errorStatus;
}

/** The chaos every option falls back to when nothing configures it. */
const BUILT_IN_CHAOS: ResolvedChaosOptions = {
  latencyMs: 0,
  errorRate: 0,
  errorStatus: DEFAULT_ERROR_STATUS,
  timeoutRate: 0,
  timeoutMs: DEFAULT_TIMEOUT_MS,
};

/**
 * Validates `options` and fills in every value it leaves out from `base`.
 *
 * This is the single place chaos values are checked, whether they came from the
 * static options, from a `resolveChaos` hook, or from a caller validating its
 * own configuration before the server is ever created.
 *
 * @throws {RangeError} If any value is outside its documented range.
 * @internal Not part of the public API; exported only so the config layer can
 * check a file's values against the same rules before a server is created.
 */
export function resolveChaosOptions(
  options: ChaosOptions,
  base: ResolvedChaosOptions = BUILT_IN_CHAOS,
): ResolvedChaosOptions {
  return {
    latencyMs: parseDurationMs(options.latencyMs, 'latencyMs', base.latencyMs),
    errorRate: parseRate(options.errorRate, 'errorRate', base.errorRate),
    errorStatus: parseErrorStatus(options.errorStatus, base.errorStatus),
    timeoutRate: parseRate(options.timeoutRate, 'timeoutRate', base.timeoutRate),
    timeoutMs: parseDurationMs(options.timeoutMs, 'timeoutMs', base.timeoutMs),
  };
}

/**
 * Decides whether one request should be held open and then answered with a
 * synthetic timeout.
 *
 * This and {@link shouldInjectError} are the only randomness in the proxy, one
 * draw each. Keeping them in pure functions keeps `Math.random()` out of the
 * forwarding path and makes partial rates testable without statistical
 * assertions. `Math.random()` returns a value in `[0, 1)`, so a rate of `0`
 * never injects and a rate of `1` always does.
 *
 * The two draws are sequential rather than independent overall probabilities:
 * this one is taken first, and {@link shouldInjectError} is consulted only when
 * it declines. `timeoutRate: 0.2` with `errorRate: 0.5` therefore means 20% of
 * requests time out and half of the remaining 80% — 40% overall — are failed.
 *
 * @internal Not part of the public API; configure via {@link createProxyServer}.
 */
export function shouldInjectTimeout(
  timeoutRate: number,
  random: () => number = Math.random,
): boolean {
  return random() < timeoutRate;
}

/**
 * Decides whether one request should receive a synthetic error, once
 * {@link shouldInjectTimeout} has declined it.
 *
 * @internal Not part of the public API; configure via {@link createProxyServer}.
 */
export function shouldInjectError(errorRate: number, random: () => number = Math.random): boolean {
  return random() < errorRate;
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

/**
 * Splits an incoming request target into its path and query string.
 *
 * The absolute base is a placeholder that is thrown away: only what the client
 * asked for is kept. A target Node accepted at the HTTP layer but `URL` cannot
 * parse yields `undefined` rather than throwing, so every caller decides for
 * itself what an unusable request target means.
 */
function parseRequestTarget(requestTarget: string): URL | undefined {
  try {
    return new URL(requestTarget, REQUEST_TARGET_BASE);
  } catch {
    return undefined;
  }
}

/**
 * Path of an incoming request target, with any query string dropped.
 *
 * Exported so that callers matching requests against their own configuration
 * see exactly the path the proxy will forward, rather than parsing `req.url` a
 * second way. An unusable request target has no path, and so matches nothing.
 *
 * @internal Not part of the public API.
 */
export function requestPathname(requestTarget: string): string {
  return parseRequestTarget(requestTarget)?.pathname ?? '';
}

/** Builds the upstream URL, keeping the incoming path and query string. */
function upstreamUrlFor(incoming: URL, target: URL): URL {
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
  const incoming = parseRequestTarget(req.url ?? '/');

  if (incoming === undefined) {
    sendProxyError(res, 400, 'Bad Request');
    return;
  }

  const upstreamUrl = upstreamUrlFor(incoming, target);
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
 * Runs `run` after `delayMs`, unless the client disconnects first.
 *
 * Both stages that deliberately hold a request use this: the artificial latency
 * paid once at request initiation rather than per body chunk, and the wait an
 * injected timeout spends before answering. The incoming request is left unread
 * throughout, so its body stays in the socket under normal backpressure instead
 * of being buffered here.
 *
 * If the client goes away first the timer is cleared and nothing runs — no
 * decision, no upstream request, and no response written to a gone client. On
 * the normal path the close listener is removed before `run`, so a request that
 * passes through both stages never accumulates listeners or live timers.
 */
function runAfter(delayMs: number, res: ServerResponse, run: () => void): void {
  const timer = setTimeout(() => {
    res.off('close', cancel);
    run();
  }, delayMs);

  function cancel(): void {
    clearTimeout(timer);
  }

  res.once('close', cancel);
}

/** Body sent when a `resolveChaos` hook cannot produce usable options. */
const CHAOS_RESOLUTION_ERROR_BODY = 'Chaos Proxy configuration error';

/**
 * Creates a proxy server that forwards every request to `target` and streams
 * the upstream response back to the client.
 *
 * The returned server is not listening yet; start it with `server.listen(port)`
 * and stop it with `server.close()`.
 *
 * Chaos is normally the same for every request. Passing a `resolveChaos` hook
 * makes it request-dependent instead, by layering what the hook returns over
 * these options; see {@link ProxyServerOptions.resolveChaos}.
 *
 * @throws {TypeError} If `target` is not an absolute `http:` or `https:` URL.
 * @throws {RangeError} If `latencyMs` or `timeoutMs` is negative, `NaN`, or
 * infinite.
 * @throws {RangeError} If `errorRate` or `timeoutRate` is outside `0`-`1`,
 * `NaN`, or infinite.
 * @throws {RangeError} If `errorStatus` is not an integer from `400` to `599`.
 */
export function createProxyServer(options: ProxyServerOptions): Server {
  const target = parseTarget(options.target);
  const staticChaos = resolveChaosOptions(options);
  const resolveChaos = options.resolveChaos;

  /**
   * Starts one request, choosing exactly one outcome: a synthetic timeout, a
   * synthetic error, or normal forwarding.
   *
   * Both injected outcomes answer from here, so no upstream connection is
   * opened and no request body is read; Node discards the unread body as part
   * of ending the response.
   */
  function initiate(req: IncomingMessage, res: ServerResponse, chaos: ResolvedChaosOptions): void {
    if (shouldInjectTimeout(chaos.timeoutRate)) {
      runAfter(chaos.timeoutMs, res, () => {
        sendProxyError(res, INJECTED_TIMEOUT_STATUS, INJECTED_TIMEOUT_BODY);
      });
      return;
    }

    if (shouldInjectError(chaos.errorRate)) {
      sendProxyError(res, chaos.errorStatus, INJECTED_ERROR_BODY);
      return;
    }

    forward(req, res, target);
  }

  return createServer((req, res) => {
    let chaos: ResolvedChaosOptions;

    try {
      chaos =
        resolveChaos === undefined
          ? staticChaos
          : resolveChaosOptions(resolveChaos(req), staticChaos);
    } catch {
      // A hook that throws or returns an unusable value is a defect in the
      // caller's configuration, not in this request. It fails that request
      // rather than taking the whole process down with an uncaught exception.
      sendProxyError(res, 500, CHAOS_RESOLUTION_ERROR_BODY);
      return;
    }

    if (chaos.latencyMs === 0) {
      initiate(req, res, chaos);
      return;
    }

    runAfter(chaos.latencyMs, res, () => {
      initiate(req, res, chaos);
    });
  });
}
