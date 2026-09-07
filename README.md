# Chaos Proxy

A local developer tool for testing how an application behaves when its API misbehaves.

> **Status: under development.** Chaos Proxy runs from the command line and can forward HTTP
> traffic to a target API, inject a fixed artificial latency, inject synthetic HTTP errors, and
> inject synthetic timeouts. Connection failures, per-endpoint rules, and configuration files do
> not exist yet.

Chaos Proxy sits between an application and an API and deliberately degrades that connection, so
that loading states, retries, error handling, and timeout behaviour can be exercised locally.

See [docs/project-overview.md](docs/project-overview.md) for the full scope and planned
capabilities.

## Requirements

- Node.js >= 22.12
- npm

## Install

The package is not published yet, so install it from a clone:

```bash
git clone https://github.com/igkougkousis01/chaos-proxy.git
cd chaos-proxy
npm install
npm run build
npm link
```

`npm link` puts the `chaos-proxy` command on your `PATH`. Without it, the built CLI can always be
run directly:

```bash
node dist/cli.js --target http://localhost:3000
```

## Usage

Point Chaos Proxy at the API you want to degrade, then point your application at Chaos Proxy:

```bash
chaos-proxy --target http://localhost:3000
```

```text
Chaos Proxy listening on http://127.0.0.1:4000
Target: http://localhost:3000
```

Requests now travel `application -> http://127.0.0.1:4000 -> http://localhost:3000`, unchanged
until you ask for chaos:

```bash
chaos-proxy \
  --target http://localhost:3000 \
  --port 4000 \
  --latency 500 \
  --error-rate 0.2 \
  --error-status 503
```

```text
Chaos Proxy listening on http://127.0.0.1:4000
Target: http://localhost:3000
Latency: 500ms
Error injection: 20% -> 503
```

Every request is now delayed by 500 ms, and roughly one in five is answered with `503` instead of
being forwarded. Press `Ctrl+C` (or send `SIGTERM`) to stop: the proxy stops accepting new
connections, lets requests already in flight finish, and exits.

The listener is bound to `127.0.0.1` only, so a proxy whose whole purpose is to break traffic is
never reachable from the rest of the network. That is deliberate and not configurable.

### Options

| Option                     | Default    | Description                                                     |
| -------------------------- | ---------- | --------------------------------------------------------------- |
| `--target <url>`           | _required_ | API to forward to. Must be an absolute `http:` or `https:` URL. |
| `--port <1-65535>`         | `4000`     | Port to listen on, on `127.0.0.1`.                              |
| `--latency <ms>`           | `0`        | Fixed delay added to every request.                             |
| `--error-rate <0-1>`       | `0`        | Fraction of requests answered with a synthetic error.           |
| `--error-status <400-599>` | `500`      | Status code used by injected errors.                            |
| `--timeout-rate <0-1>`     | `0`        | Fraction of requests held open and then timed out.              |
| `--timeout <ms>`           | `30000`    | How long a timed-out request is held before it gets a `504`.    |
| `-h`, `--help`             |            | Print usage and exit.                                           |
| `-v`, `--version`          |            | Print the package version and exit.                             |

Invalid values are rejected before the server starts, with a message naming the option — they are
never silently clamped. A port that is already in use is reported as such rather than as a stack
trace.

## Proxy core

The forwarding layer is also available programmatically, and the CLI is a consumer of it.
`createProxyServer` returns a standard Node.js `http.Server`, so it is started and stopped like
any other:

```ts
import { createProxyServer } from 'chaos-proxy';

const server = createProxyServer({ target: 'http://localhost:5000' });

server.listen(4000);
// GET http://localhost:4000/api/users?page=2
//   -> GET http://localhost:5000/api/users?page=2
```

It forwards the request method, path, query string, body, and headers upstream (rewriting `Host`
to the target), and streams the upstream status, headers, and body back to the client. `http:`
and `https:` targets are both supported; anything else is rejected when the server is created. If
the target cannot be reached, the client receives `502 Bad Gateway`.

The local proxy listener itself is plain HTTP.

## Latency injection

`--latency` (`latencyMs`) adds a fixed artificial delay to every request.

```bash
chaos-proxy --target http://localhost:5000 --latency 500
```

```ts
const server = createProxyServer({
  target: 'http://localhost:5000',
  latencyMs: 500,
});
```

The delay is paid once per request, before the proxy opens the upstream connection; request and
response bodies then stream through as usual, so no individual chunk is slowed down. If the
client disconnects while the delay is still running, no upstream request is made at all.

Omitting it (or setting it to `0`) means no artificial delay. Negative, `NaN`, and infinite
values are rejected when the server is created — they are never silently clamped.

## Error injection

`--error-rate` (`errorRate`) is the probability, from `0` to `1`, that a request is answered with
a synthetic HTTP error instead of being forwarded. `--error-status` (`errorStatus`) chooses the
status code and defaults to `500`.

```bash
chaos-proxy --target http://localhost:5000 --error-rate 0.2 --error-status 503
```

```ts
const server = createProxyServer({
  target: 'http://localhost:5000',
  errorRate: 0.2, // roughly 1 request in 5 fails
  errorStatus: 503,
});
```

An injected error is decided per request and answered by the proxy itself: no upstream connection
is opened and no request body is forwarded. The client receives the configured status with the
plain-text body `Chaos Proxy injected error`.

The decision happens **after** any latency delay, so `--latency 500 --error-rate 1` makes every
request wait roughly 500 ms and then fail — a slow failure, like a real one. If the client
disconnects while the delay is still running, nothing is decided and nothing is sent.

Omitting `--error-rate` (or setting it to `0`) means requests are never failed. Rates outside
`0`-`1`, `NaN`, and infinities are rejected when the server is created, as is an error status
that is not an integer from `400` to `599`.

Each request is decided independently. Choosing between several status codes, weighting them, and
scoping errors to particular endpoints or methods are not supported.

## Timeout injection

`--timeout-rate` (`timeoutRate`) is the probability, from `0` to `1`, that a request is held open
and then answered with `504 Gateway Timeout` instead of being forwarded. `--timeout`
(`timeoutMs`) is how long it is held, and defaults to `30000`.

```bash
chaos-proxy --target http://localhost:5000 --timeout-rate 0.2 --timeout 3000
```

```ts
const server = createProxyServer({
  target: 'http://localhost:5000',
  timeoutRate: 0.2, // roughly 1 request in 5 stalls
  timeoutMs: 3000,
});
```

An injected timeout is answered by the proxy itself: no upstream connection is opened and no
request body is forwarded or buffered. The request simply stays pending for the configured
duration, which is what lets a client hit its own timeout, and the proxy then sends the
plain-text body `Chaos Proxy injected timeout` rather than leaving the socket open forever. If
the client disconnects while the request is being held, the wait is cancelled and nothing is
sent.

This is a deliberately stalled request, not detection of a genuinely slow upstream: the proxy
never contacts the target for a timed-out request.

### Ordering

Chaos is applied in a fixed order, and each request gets **at most one** injected outcome:

```text
request -> latency delay -> timeout? -> error? -> forward upstream
```

Any latency delay is paid first. Then the timeout rate is evaluated; if it selects the request,
it is held and answered with `504`, and the error rate never gets to decide. Only requests that
are not timed out are offered to the error rate, and only requests that neither selects are
forwarded. So `--latency 100 --timeout-rate 1 --timeout 3000` makes a request wait roughly
3.1 seconds and then fail with `504`.

The two rates are therefore sequential rather than independent overall probabilities.
`--timeout-rate 0.2 --error-rate 0.5` means 20% of requests time out, and half of the remaining
80% — 40% overall — receive a synthetic error.

Omitting `--timeout-rate` (or setting it to `0`) means requests are never timed out. Rates outside
`0`-`1`, `NaN`, and infinities are rejected when the server is created, as are negative, `NaN`,
and infinite timeout durations. A timeout of `0` is accepted and means the `504` is sent on the
next timer tick, without waiting.

Random or ranged timeout durations, jitter, dropped or reset TCP connections, and per-endpoint
timeouts are not supported.

## Development

```bash
npm install
```

| Script                 | Description                      |
| ---------------------- | -------------------------------- |
| `npm run dev`          | Run the CLI from source          |
| `npm run build`        | Compile TypeScript to `dist/`    |
| `npm test`             | Run the test suite once          |
| `npm run test:watch`   | Run tests in watch mode          |
| `npm run typecheck`    | Type-check without emitting      |
| `npm run lint`         | Lint with ESLint                 |
| `npm run lint:fix`     | Lint and apply fixable issues    |
| `npm run format`       | Format with Prettier             |
| `npm run format:check` | Check formatting without writing |

`npm run dev` takes the same flags as the built CLI:

```bash
npm run dev -- --target http://localhost:3000 --latency 500
```

## Project status

| Area                | Status                            |
| ------------------- | --------------------------------- |
| Project scaffolding | Done                              |
| CLI                 | Done (flags, startup, shutdown)   |
| HTTP forwarding     | Done                              |
| Latency injection   | Fixed delay                       |
| Error injection     | Fixed status, fixed probability   |
| Timeout injection   | Fixed duration, fixed probability |
| Config files        | Not started                       |
| Other chaos         | Not started                       |

## License

MIT
