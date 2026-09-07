# Chaos Proxy

A local developer tool for testing how an application behaves when its API misbehaves.

> **Status: under development.** Chaos Proxy runs from the command line and can forward HTTP
> traffic to a target API, inject a fixed artificial latency, inject synthetic HTTP errors, and
> inject synthetic timeouts — globally, or per endpoint through a YAML config file. Connection
> failures do not exist yet.

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
| `--config <path>`          |            | YAML config file with defaults and endpoint rules.              |
| `--port <1-65535>`         | `4000`     | Port to listen on, on `127.0.0.1`.                              |
| `--latency <ms>`           | `0`        | Fixed delay added to every request.                             |
| `--error-rate <0-1>`       | `0`        | Fraction of requests answered with a synthetic error.           |
| `--error-status <400-599>` | `500`      | Status code used by injected errors.                            |
| `--timeout-rate <0-1>`     | `0`        | Fraction of requests held open and then timed out.              |
| `--timeout <ms>`           | `30000`    | How long a timed-out request is held before it gets a `504`.    |
| `-h`, `--help`             |            | Print usage and exit.                                           |
| `-v`, `--version`          |            | Print the package version and exit.                             |

`--target` is required unless the config file supplies it.

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

### Per-request chaos

Chaos is the same for every request unless you pass a `resolveChaos` hook, which is called once
per request and whose result is layered over the static options:

```ts
const server = createProxyServer({
  target: 'http://localhost:5000',
  latencyMs: 100,
  resolveChaos: (request) =>
    request.url?.startsWith('/api/payments/') === true ? { errorRate: 1, errorStatus: 503 } : {},
});
```

Payments now fail, everything else is forwarded, and both still wait 100 ms — a field the hook
leaves out keeps its static value. This is exactly how `--config` is implemented: the config layer
turns `defaults` plus ordered rules into one such hook, so the proxy core never knows YAML exists.
The hook is optional and purely additive; static options on their own work as they always have.

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

Each request is decided independently. Choosing between several status codes and weighting them
are not supported. Scoping errors to particular endpoints is done with a
[config file](#config-file); scoping them to particular methods is not supported.

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

Random or ranged timeout durations, jitter, and dropped or reset TCP connections are not
supported. Per-endpoint timeouts are configured with a [config file](#config-file).

## Config file

Different routes usually need different failure behaviour: payments should fail, search should
stall, everything else should just be slow. Put that in a YAML file and pass it with `--config`.

```yaml
# chaos.yml
target: http://localhost:3000

defaults:
  latencyMs: 100

rules:
  - match: /api/payments/*
    errorRate: 1
    errorStatus: 503
```

```bash
chaos-proxy --config chaos.yml
```

```text
Chaos Proxy listening on http://127.0.0.1:4000
Target: http://localhost:3000
Config: /home/you/project/chaos.yml
Rules: 1
Latency: 100ms
```

Every request is now delayed by 100 ms, and anything under `/api/payments/` fails with `503`
instead of being forwarded. A relative path is resolved against the directory you run the command
from. There is no auto-discovery: a config file is used only when `--config` names it.

[`examples/chaos.yml`](examples/chaos.yml) is a complete file to copy.

### Schema

| Field      | Type   | Description                                                |
| ---------- | ------ | ---------------------------------------------------------- |
| `target`   | string | API to forward to. Required unless `--target` supplies it. |
| `port`     | number | Port to listen on, `1`-`65535`. Same meaning as `--port`.  |
| `defaults` | map    | Chaos applied to every request. Same fields as the flags.  |
| `rules`    | list   | Endpoint rules, tried in order. Each needs a `match`.      |

`defaults` and each rule accept the chaos settings `latencyMs`, `errorRate`, `errorStatus`,
`timeoutRate` and `timeoutMs` — the same names, meanings and ranges as the `createProxyServer`
options below, validated by the same code. Any other field, at any level, is a mistake and is
reported as one rather than being ignored:

```text
chaos-proxy: Invalid config: unknown field "errorate" in rules[0].
```

### Matching

A rule's `match` is a path, and matching deliberately supports exactly two forms:

| Pattern           | Matches                                                    | Does not match                           |
| ----------------- | ---------------------------------------------------------- | ---------------------------------------- |
| `/api/search`     | `/api/search`, `/api/search?q=test`                        | `/api/search/advanced`, `/api/searching` |
| `/api/payments/*` | `/api/payments/`, `/api/payments/123`, `/api/payments/a/b` | `/api/payments`                          |

Rules match on the request **path only**, so a query string never affects which rule is chosen.
Patterns must start with `/`, and `*` is allowed only as a trailing `/*`. Regular expressions,
`**`, a `*` in the middle, and matching on method, host or query string are not supported;
`/api/*/details` is rejected when the file is read, not quietly ignored.

### Rule precedence

**The first matching rule wins.** Rules are never combined and never scored against each other,
so a file can be read from top to bottom:

```yaml
rules:
  - match: /api/*
    errorRate: 0.1

  - match: /api/payments/*
    errorRate: 1
```

`/api/payments/123` matches `/api/*` first, so it gets `errorRate: 0.1` — the second rule never
runs. Put the specific rules above the general ones.

A matching rule overrides only the fields it actually names; everything else keeps its value from
`defaults`. With the file above plus `defaults: { latencyMs: 100, errorStatus: 500 }`, a request
to `/api/payments/123` ends up with `latencyMs: 100`, `errorRate: 0.1` and `errorStatus: 500`.

### Precedence overall

```text
command-line flags  >  config file  >  built-in defaults
```

A flag you type wins over the config file, and that includes rules:

```bash
chaos-proxy --config chaos.yml --port 5000 --error-rate 0
```

`--port 5000` overrides the file's `port`, and `--error-rate 0` switches error injection off
everywhere — including inside a rule that sets `errorRate: 1`. The reasoning is that a flag typed
on the spot is the more deliberate of the two.

Configuration is `--config` only. Environment variables, `.chaosrc`-style auto-discovery, JSON
config, hot reload, and config includes are not supported.

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
| Config files        | YAML, with endpoint rules         |
| Other chaos         | Not started                       |

## License

MIT
