import { createServer, request as httpRequest } from 'node:http';
import type {
  IncomingHttpHeaders,
  IncomingMessage,
  OutgoingHttpHeaders,
  Server,
  ServerResponse,
} from 'node:http';
import { request as httpsRequest } from 'node:https';
import { performance } from 'node:perf_hooks';

/**
 * The chaos a request can be subjected to.
 *
 * Every field is optional, and an omitted one means "no chaos of this kind" —
 * except {@link errorStatus} and {@link timeoutMs}, which only choose how an
 * injected error or timeout is shaped and have their own defaults.
 *
 * At most one kind of chaos befalls a request, decided after any
 * {@link latencyMs} delay in a fixed order: {@link resetRate}, then
 * {@link timeoutRate}, then {@link errorRate}, then ordinary forwarding.
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
   * The decision is made per request, after any {@link latencyMs} delay and
   * last of the three, so it only ever sees the requests {@link resetRate} and
   * {@link timeoutRate} both declined.
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
   * after {@link resetRate} but before {@link errorRate}, so a request selected
   * for a timeout is never also given a synthetic HTTP error.
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

  /**
   * Probability, from `0` to `1`, that a request has its client connection
   * abruptly terminated instead of being answered at all. Omitted or `0` means
   * never.
   *
   * This is a transport failure rather than an HTTP one: no status line, no
   * headers and no body are sent, no upstream connection is opened, and the
   * request body is never read. The client sees a dropped or reset connection —
   * a `fetch` rejection rather than a response it can inspect.
   *
   * The decision is made per request, after any {@link latencyMs} delay and
   * before every other kind of chaos, because a connection that goes away is
   * the most fundamental of the failures here: a request selected for a reset
   * is never also given a synthetic timeout or a synthetic HTTP error.
   */
  readonly resetRate?: number;
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
  readonly resetRate: number;
}

/**
 * What became of one request.
 *
 * The set is deliberately small and closed: it names which of the five fates a
 * request met, and nothing about why. Which rule matched it, which random draw
 * selected it, and what the upstream said about it are all outside it.
 *
 * `forwarded` means the request reached the upstream and the upstream's own
 * response was returned — including when that response was an error, since a
 * `500` the upstream chose is a different event from a `500` the proxy invented.
 *
 * `connection:reset` is the one outcome that is not an HTTP response at all: the
 * proxy destroyed the client connection, so the request has no status code.
 */
export type RequestOutcome =
  'forwarded' | 'injected:error' | 'injected:timeout' | 'connection:reset' | 'upstream:error';

/**
 * What happened to one completed request, as handed to
 * {@link ProxyServerOptions.onRequestComplete}.
 *
 * These are facts about a single request and nothing more: no headers, no
 * bodies, no identifiers, and no formatting. Turning them into a line of
 * output — timestamps, alignment, colour — belongs to whoever is doing the
 * reporting.
 */
export interface RequestLogEvent {
  /** Request method, as the client sent it, for example `GET`. */
  readonly method: string;

  /**
   * Path the client asked for, with any query string dropped, for example
   * `/api/search` for `/api/search?q=test`. This is the same path endpoint
   * rules are matched against.
   */
  readonly pathname: string;

  /**
   * Status the client actually received, or `null` when it received none.
   *
   * `null` is only ever a `connection:reset`: the connection was destroyed
   * before any response was written, so there is no status to report. The key
   * is always present and never carries an invented status — `0`, `499` and
   * `444` would all claim an HTTP outcome that never happened.
   */
  readonly statusCode: number | null;

  /**
   * Milliseconds from the request arriving at the proxy to its response
   * completing, measured on a monotonic clock and left unrounded.
   *
   * It covers everything the proxy did, including any artificial latency and
   * any injected timeout wait.
   */
  readonly durationMs: number;

  /** Which of the five fates the request met. */
  readonly outcome: RequestOutcome;

  /**
   * Effective artificial latency applied to this request, in milliseconds, and
   * `0` when none was. This is the value that actually applied, so a request an
   * endpoint rule gave its own latency reports the rule's value rather than the
   * configured default.
   */
  readonly latencyMs: number;
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

  /**
   * Optional hook called exactly once per request, after its response has
   * completed, with what happened to it.
   *
   * It is the only way anything leaves the proxy core besides the response
   * itself: nothing is printed, and a caller that does not supply this hook
   * gets no output at all. The `chaos-proxy` command line supplies one and
   * formats what it receives; a programmatic caller decides for itself.
   *
   * It is not called for a request whose response never completed — a client
   * that disconnects mid-response is reported as nothing rather than as a
   * status it never received.
   */
  readonly onRequestComplete?: (event: RequestLogEvent) => void;

  /**
   * Where the chaos decisions get their randomness. Defaults to `Math.random`.
   *
   * It must return a value in `[0, 1)`, like `Math.random` does. Supplying a
   * deterministic generator makes the whole server reproducible: the same
   * generator, the same options and the same sequence of requests produce the
   * same sequence of outcomes. That is what `chaos-proxy --seed` is.
   *
   * There is exactly one of these per server, and every chaos decision draws
   * from it in a fixed order — the reset decision first, then the timeout
   * decision, then the error decision, each consulted only when the ones before
   * it declined. A request therefore consumes one, two or three values
   * depending on what happened to it, which makes the sequence depend on the
   * order requests reach the decision. Requests handled concurrently can
   * interleave their draws, so reproducibility holds for a given request
   * ordering rather than for a given set of requests.
   */
  readonly random?: () => number;
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
  resetRate: 0,
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
    resetRate: parseRate(options.resetRate, 'resetRate', base.resetRate),
  };
}

/**
 * Decides whether one request should have its client connection destroyed.
 *
 * This, {@link shouldInjectTimeout} and {@link shouldInjectError} are the only
 * randomness in the proxy, one draw each. Keeping them in pure functions keeps
 * the random source out of the forwarding path and makes partial rates testable
 * without statistical assertions. `random` returns a value in `[0, 1)`, so a
 * rate of `0` never injects and a rate of `1` always does.
 *
 * The three draws are sequential rather than independent overall probabilities.
 * This one is taken first, because a connection that goes away is the most
 * fundamental failure of the three and there is nothing left to time out or to
 * answer once it has: `resetRate: 0.1` with `timeoutRate: 0.5` means 10% of
 * requests are reset and half of the remaining 90% — 45% overall — time out.
 *
 * @internal Not part of the public API; configure via {@link createProxyServer}.
 */
export function shouldResetConnection(
  resetRate: number,
  random: () => number = Math.random,
): boolean {
  return random() < resetRate;
}

/**
 * Decides whether one request should be held open and then answered with a
 * synthetic timeout, once {@link shouldResetConnection} has declined it.
 *
 * `timeoutRate: 0.2` with `errorRate: 0.5` means 20% of the requests that
 * reached this decision time out, and half of the remaining 80% — 40% of them —
 * are failed.
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
 * {@link shouldResetConnection} and {@link shouldInjectTimeout} have declined
 * it.
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

/**
 * Records the fate of one request, for whoever is tracking its completion.
 *
 * Calling it more than once is harmless — the last outcome wins — because for
 * every outcome but one the event is emitted from the response's own
 * completion rather than from here. The exception is `connection:reset`, which
 * has no completion to hang off and so is emitted as it is recorded; that
 * emission is what the exactly-once guard exists for.
 */
type ReportOutcome = (outcome: RequestOutcome) => void;

/** Used when nothing is tracking completions, so no request pays for them. */
const NO_REPORT: ReportOutcome = () => {
  // Deliberately empty: without an `onRequestComplete` hook there is nothing to
  // record and no listener to attach.
};

/**
 * Arranges for `onRequestComplete` to be called once, when this request's
 * response completes, and returns the recorder its outcome is reported to.
 *
 * `close` fires exactly once per response and covers both completion and the
 * client disconnecting, so it is the one place an event can be emitted from
 * without risking a duplicate. Which of the two it was is read from
 * `writableFinished`, which is only true once the whole response has been
 * flushed: a request cut off mid-body is reported as nothing rather than as a
 * success the client never saw.
 *
 * An outcome that was never recorded means the proxy never got as far as
 * choosing one — the client went away during a delay — and is likewise silent.
 *
 * A `connection:reset` is the one outcome that cannot wait for `close`: the
 * proxy is about to destroy the socket, so the response will never become
 * `writableFinished` and the close that follows is indistinguishable from a
 * client that hung up. It is therefore emitted the moment it is recorded, and
 * the guard below is what keeps that from also being reported a second time.
 */
function trackCompletion(
  req: IncomingMessage,
  res: ServerResponse,
  startedAt: number,
  latencyMs: number,
  onRequestComplete: (event: RequestLogEvent) => void,
): ReportOutcome {
  let outcome: RequestOutcome | undefined;
  let emitted = false;

  function emit(chosen: RequestOutcome, statusCode: number | null): void {
    if (emitted) {
      return;
    }

    emitted = true;
    onRequestComplete({
      method: req.method ?? '',
      pathname: requestPathname(req.url ?? '/'),
      statusCode,
      durationMs: performance.now() - startedAt,
      outcome: chosen,
      latencyMs,
    });
  }

  res.once('close', () => {
    if (outcome === undefined || !res.writableFinished) {
      return;
    }

    // Read from the response rather than remembered separately, so the event
    // can only ever report the status the client was actually sent.
    emit(outcome, res.statusCode);
  });

  return (chosen) => {
    outcome = chosen;

    if (chosen === 'connection:reset') {
      // No status: the client was sent nothing at all, and inventing one would
      // describe a transport failure as an HTTP answer.
      emit(chosen, null);
    }
  };
}

/**
 * Destroys the client connection without writing anything to it.
 *
 * The socket is taken down rather than the response ended, which is the whole
 * point: no status line, no headers and no body reach the client, so it sees a
 * transport failure instead of an HTTP answer. Whatever of the request body is
 * still unread goes with the socket, so nothing is consumed or buffered here.
 *
 * Destroying without an error argument means no `ECONNRESET` is manufactured on
 * this side; the server keeps serving, and the outcome for this one request has
 * already been recorded by the time this runs.
 */
function resetConnection(res: ServerResponse): void {
  const socket = res.socket;

  if (socket === null) {
    // The connection is already gone; there is nothing left to destroy, and
    // finishing the response off keeps it from being left pending.
    res.destroy();
    return;
  }

  socket.destroy();
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
function forward(
  req: IncomingMessage,
  res: ServerResponse,
  target: URL,
  report: ReportOutcome,
): void {
  const incoming = parseRequestTarget(req.url ?? '/');

  if (incoming === undefined) {
    // No outcome is recorded: the proxy could not tell what was being asked
    // for, so this is a request it refused rather than one of the four fates a
    // request it understood can meet.
    sendProxyError(res, 400, 'Bad Request');
    return;
  }

  const upstreamUrl = upstreamUrlFor(incoming, target);
  const headers = forwardableHeaders(req.headers);
  headers.host = target.host;

  const sendUpstream = upstreamUrl.protocol === 'https:' ? httpsRequest : httpRequest;
  const upstreamReq = sendUpstream(upstreamUrl, { method: req.method, headers });

  upstreamReq.on('error', () => {
    report('upstream:error');
    sendProxyError(res, 502, 'Bad Gateway');
  });

  upstreamReq.on('response', (upstreamRes) => {
    report('forwarded');
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
 * The server is silent: it prints nothing. Passing an `onRequestComplete` hook
 * is the only way to find out what it did with a request.
 *
 * Chaos decisions use `Math.random` unless a `random` function is supplied, in
 * which case they become as reproducible as that function is; see
 * {@link ProxyServerOptions.random}.
 *
 * @throws {TypeError} If `target` is not an absolute `http:` or `https:` URL.
 * @throws {RangeError} If `latencyMs` or `timeoutMs` is negative, `NaN`, or
 * infinite.
 * @throws {RangeError} If `errorRate`, `timeoutRate` or `resetRate` is outside
 * `0`-`1`, `NaN`, or infinite.
 * @throws {RangeError} If `errorStatus` is not an integer from `400` to `599`.
 */
export function createProxyServer(options: ProxyServerOptions): Server {
  const target = parseTarget(options.target);
  const staticChaos = resolveChaosOptions(options);
  const resolveChaos = options.resolveChaos;
  const onRequestComplete = options.onRequestComplete;
  // One source for the whole server, read once: every decision draws from it,
  // so a seeded generator produces one reproducible stream rather than several
  // that could drift apart.
  const random = options.random ?? Math.random;

  /**
   * Starts one request, choosing exactly one outcome: a destroyed connection, a
   * synthetic timeout, a synthetic error, or normal forwarding.
   *
   * The three injected outcomes are decided in that order and every one of them
   * is answered from here, so no upstream connection is opened and no request
   * body is read. Node discards the unread body as part of ending the response,
   * and a destroyed socket takes it with it.
   *
   * The reset decision comes first because it is the most fundamental of the
   * three: once the connection is gone there is nothing left to hold open or to
   * answer. A request it selects therefore consumes exactly one random value
   * and neither of the later decisions is consulted for it.
   */
  function initiate(
    req: IncomingMessage,
    res: ServerResponse,
    chaos: ResolvedChaosOptions,
    report: ReportOutcome,
  ): void {
    if (shouldResetConnection(chaos.resetRate, random)) {
      // Recorded before the socket goes, because destroying it is what makes
      // the ordinary completion path unable to report this request at all.
      report('connection:reset');
      resetConnection(res);
      return;
    }

    if (shouldInjectTimeout(chaos.timeoutRate, random)) {
      runAfter(chaos.timeoutMs, res, () => {
        report('injected:timeout');
        sendProxyError(res, INJECTED_TIMEOUT_STATUS, INJECTED_TIMEOUT_BODY);
      });
      return;
    }

    if (shouldInjectError(chaos.errorRate, random)) {
      report('injected:error');
      sendProxyError(res, chaos.errorStatus, INJECTED_ERROR_BODY);
      return;
    }

    forward(req, res, target, report);
  }

  return createServer((req, res) => {
    // Taken before anything else, so a duration covers everything the proxy
    // did with the request rather than starting after its own bookkeeping.
    const startedAt = performance.now();
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
      // No outcome is recorded for the same reason as an unusable request
      // target: the proxy never decided what to do with this request.
      sendProxyError(res, 500, CHAOS_RESOLUTION_ERROR_BODY);
      return;
    }

    // Tracking starts once the effective chaos is known, because the event
    // reports the latency that actually applied to this request.
    const report =
      onRequestComplete === undefined
        ? NO_REPORT
        : trackCompletion(req, res, startedAt, chaos.latencyMs, onRequestComplete);

    if (chaos.latencyMs === 0) {
      initiate(req, res, chaos, report);
      return;
    }

    runAfter(chaos.latencyMs, res, () => {
      initiate(req, res, chaos, report);
    });
  });
}
