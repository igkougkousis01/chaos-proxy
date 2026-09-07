# Chaos Proxy

A local developer tool for testing how an application behaves when its API misbehaves.

> **Status: under development.** The proxy core can forward HTTP traffic to a target API, inject
> a fixed artificial latency, inject synthetic HTTP errors, and inject synthetic timeouts. Other
> chaos behaviour (connection failures) does not exist yet, and the CLI currently only prints its
> name — every option below is programmatic only.

## What it will do

Chaos Proxy will sit between an application and an API and deliberately degrade that
connection — injecting latency, HTTP errors, timeouts, and connection failures — so that loading
states, retries, error handling, and timeout behaviour can be exercised locally.

See [docs/project-overview.md](docs/project-overview.md) for the full scope and planned
capabilities.

## Proxy core

The forwarding layer is available programmatically. `createProxyServer` returns a standard
Node.js `http.Server`, so it is started and stopped like any other:

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

`latencyMs` adds a fixed artificial delay to every request. It is programmatic only — there is
no CLI flag for it yet.

```ts
const server = createProxyServer({
  target: 'http://localhost:5000',
  latencyMs: 500,
});
```

The delay is paid once per request, before the proxy opens the upstream connection; request and
response bodies then stream through as usual, so no individual chunk is slowed down. If the
client disconnects while the delay is still running, no upstream request is made at all.

Omitting `latencyMs` (or setting it to `0`) means no artificial delay. Negative, `NaN`, and
infinite values are rejected with a `RangeError` when the server is created — they are never
silently clamped.

## Error injection

`errorRate` is the probability, from `0` to `1`, that a request is answered with a synthetic HTTP
error instead of being forwarded. `errorStatus` chooses the status code and defaults to `500`.
Like `latencyMs`, both are programmatic only — there are no CLI flags for them yet.

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

The decision happens **after** any `latencyMs` delay, so `latencyMs: 500` with `errorRate: 1`
makes every request wait roughly 500 ms and then fail — a slow failure, like a real one. If the
client disconnects while the delay is still running, nothing is decided and nothing is sent.

Omitting `errorRate` (or setting it to `0`) means requests are never failed. Rates outside
`0`-`1`, `NaN`, and infinities are rejected with a `RangeError` when the server is created, as is
an `errorStatus` that is not an integer from `400` to `599`.

Each request is decided independently. Choosing between several status codes, weighting them,
scoping errors to particular endpoints or methods, and configuring any of this from the CLI or a
config file are not supported.

## Timeout injection

`timeoutRate` is the probability, from `0` to `1`, that a request is held open and then answered
with `504 Gateway Timeout` instead of being forwarded. `timeoutMs` is how long it is held, and
defaults to `30000`. Both are programmatic only — there are no CLI flags for them yet.

```ts
const server = createProxyServer({
  target: 'http://localhost:5000',
  timeoutRate: 0.2, // roughly 1 request in 5 stalls
  timeoutMs: 3000,
});
```

An injected timeout is answered by the proxy itself: no upstream connection is opened and no
request body is forwarded or buffered. The request simply stays pending for `timeoutMs`, which is
what lets a client hit its own timeout, and the proxy then sends the plain-text body
`Chaos Proxy injected timeout` rather than leaving the socket open forever. If the client
disconnects while the request is being held, the wait is cancelled and nothing is sent.

This is a deliberately stalled request, not detection of a genuinely slow upstream: the proxy
never contacts the target for a timed-out request.

### Ordering

Chaos is applied in a fixed order, and each request gets **at most one** injected outcome:

```text
request -> latencyMs delay -> timeout? -> error? -> forward upstream
```

Any `latencyMs` delay is paid first. Then `timeoutRate` is evaluated; if it selects the request,
it is held and answered with `504`, and `errorRate` never gets to decide. Only requests that are
not timed out are offered to `errorRate`, and only requests that neither selects are forwarded.
So `latencyMs: 100` with `timeoutRate: 1` and `timeoutMs: 3000` makes a request wait roughly
3.1 seconds and then fail with `504`.

The two rates are therefore sequential rather than independent overall probabilities.
`timeoutRate: 0.2` with `errorRate: 0.5` means 20% of requests time out, and half of the
remaining 80% — 40% overall — receive a synthetic error.

Omitting `timeoutRate` (or setting it to `0`) means requests are never timed out. Rates outside
`0`-`1`, `NaN`, and infinities are rejected with a `RangeError` when the server is created, as
are negative, `NaN`, and infinite `timeoutMs` values. A `timeoutMs` of `0` is accepted and means
the `504` is sent on the next timer tick, without waiting.

Random or ranged timeout durations, jitter, dropped or reset TCP connections, per-endpoint
timeouts, and configuring any of this from the CLI or a config file are not supported.

## Requirements

- Node.js >= 22.12
- npm

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

After `npm run build`, the compiled CLI can be run directly:

```bash
node dist/cli.js
```

## Project status

| Area                | Status       |
| ------------------- | ------------ |
| Project scaffolding | Done         |
| CLI entry point     | Placeholder  |
| HTTP forwarding     | Done         |
| Latency injection   | Fixed delay  |
| Error injection     | Programmatic |
| Timeout injection   | Programmatic |
| Other chaos         | Not started  |

## License

MIT
