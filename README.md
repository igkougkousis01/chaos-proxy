# Chaos Proxy

A local developer tool for testing how an application behaves when its API misbehaves.

> **Status: under development.** Chaos Proxy runs from the command line and can forward HTTP
> traffic to a target API, inject a fixed artificial latency, inject synthetic HTTP errors, inject
> synthetic timeouts, and abruptly reset client connections — globally, or per endpoint through a
> YAML config file — printing one line per request as it goes. Named presets cover the common
> scenarios, and `--seed` makes a run reproducible. Refusing connections outright and mid-stream
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
12:41:03 GET    /api/users -> 200 42ms forwarded
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
12:41:12 GET    /api/profile -> 200 548ms forwarded latency:+500ms
12:41:15 POST   /api/orders -> 503 520ms injected:error latency:+500ms
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
| `--preset <name>`          |            | Use a built-in chaos preset. See [Presets](#presets).           |
| `--port <1-65535>`         | `4000`     | Port to listen on, on `127.0.0.1`.                              |
| `--latency <ms>`           | `0`        | Fixed delay added to every request.                             |
| `--error-rate <0-1>`       | `0`        | Fraction of requests answered with a synthetic error.           |
| `--error-status <400-599>` | `500`      | Status code used by injected errors.                            |
| `--timeout-rate <0-1>`     | `0`        | Fraction of requests held open and then timed out.              |
| `--timeout <ms>`           | `30000`    | How long a timed-out request is held before it gets a `504`.    |
| `--reset-rate <0-1>`       | `0`        | Fraction of requests whose client connection is abruptly reset. |
| `--seed <value>`           |            | Make chaos decisions deterministic, for reproducible runs.      |
| `--quiet`                  |            | Print nothing but errors.                                       |
| `-h`, `--help`             |            | Print usage and exit.                                           |
| `-v`, `--version`          |            | Print the package version and exit.                             |

`--target` is required unless the config file supplies it.

Invalid values are rejected before the server starts, with a message naming the option — they are
never silently clamped. A port that is already in use is reported as such rather than as a stack
trace.

### Request output

Every request that completes prints one line, so what the proxy did to it is visible while the
application is being exercised:

```text
12:41:03 GET    /api/users -> 200 42ms forwarded
12:41:07 POST   /api/payments/123 -> 503 510ms injected:error
12:41:09 GET    /api/search -> 504 2104ms injected:timeout
12:41:11 GET    /api/cart -> RESET 12ms connection:reset
12:41:12 GET    /api/profile -> 200 548ms forwarded latency:+500ms
```

Local time, method, path, the status the client received, how long the whole request took, and
what became of it. The outcome is one of `forwarded`, `injected:error`, `injected:timeout`,
`connection:reset` or `upstream:error` — an upstream `500` is `forwarded`, because the upstream
chose it. `latency:+N` is appended when an artificial delay applied, and shows the value that
actually applied, so a request an endpoint rule slowed down reports the rule's latency rather
than the default.

A reset request never received a status, so `RESET` stands where one would be. That is a
transport outcome rather than an HTTP one, and no status code is invented for it — `0`, `499` and
`444` would each claim an answer the client never got.

Query strings are left out, and so are headers, bodies and anything else that could carry a token
or a cookie into a terminal. A request whose client disconnects before the response completes
prints nothing rather than a status it never received.

`--quiet` turns off informational output — the startup summary, these lines, and the shutdown
notice. Errors still go to stderr, and `--help` and `--version` still print.

```bash
chaos-proxy --target http://localhost:3000 --quiet
```

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

### Request completion events

The proxy core prints nothing. Pass `onRequestComplete` to be told what happened to each request
that completed:

```ts
import { createProxyServer } from 'chaos-proxy';
import type { RequestLogEvent } from 'chaos-proxy';

const server = createProxyServer({
  target: 'http://localhost:5000',
  onRequestComplete: (event: RequestLogEvent) => {
    // { method: 'GET', pathname: '/api/users', statusCode: 200,
    //   durationMs: 42.13, outcome: 'forwarded', latencyMs: 0 }
  },
});
```

It is called exactly once per request, after the response has completed, and never for a request
whose response was cut short. `durationMs` is measured on a monotonic clock and left unrounded;
formatting it — and the timestamp next to it — is the caller's job. This is exactly how the CLI's
request output is implemented, so the core never learns what a terminal is.

`statusCode` is `number | null`. It is `null` only for a `connection:reset`, which received no
HTTP response at all; every other outcome carries the status the client was actually sent.

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

Omitting `--timeout-rate` (or setting it to `0`) means requests are never timed out. Rates outside
`0`-`1`, `NaN`, and infinities are rejected when the server is created, as are negative, `NaN`,
and infinite timeout durations. A timeout of `0` is accepted and means the `504` is sent on the
next timer tick, without waiting.

Random or ranged timeout durations and jitter are not supported. Per-endpoint timeouts are
configured with a [config file](#config-file).

## Connection reset injection

`--reset-rate` (`resetRate`) is the probability, from `0` to `1`, that a request has its client
connection abruptly terminated. Selected requests have their client connection abruptly
terminated without an HTTP response.

```bash
chaos-proxy \
  --target http://localhost:3000 \
  --reset-rate 0.1
```

```ts
const server = createProxyServer({
  target: 'http://localhost:5000',
  resetRate: 0.1, // roughly 1 request in 10 loses its connection
});
```

```text
Chaos Proxy listening on http://127.0.0.1:4000
Target: http://localhost:3000
Connection resets: 10%
12:41:11 GET    /api/cart -> RESET 12ms connection:reset
```

This is a transport failure rather than an HTTP one. No status line, no headers and no body are
sent, so the client sees a dropped connection — a `fetch` rejection, a `curl` "connection reset by
peer" — rather than a response it could inspect or retry on the strength of. Applications that
only handle `5xx` are exactly what this is for.

No upstream connection is opened and the request body is never read, let alone forwarded or
buffered: whatever of it was still in flight goes with the socket. The proxy itself stays healthy
and keeps serving the next request as usual.

### Ordering

Chaos is applied in a fixed order, and each request gets **at most one** injected outcome:

```text
request -> latency delay -> reset? -> timeout? -> error? -> forward upstream
```

Any latency delay is paid first. Then the reset rate is evaluated; if it selects the request, the
connection is destroyed and neither the timeout rate nor the error rate gets to decide — there is
nothing left to hold open or to answer. Only requests it declines are offered to the timeout rate,
only requests that survive both are offered to the error rate, and only requests none of the three
selects are forwarded. So `--latency 100 --reset-rate 1` makes a request wait roughly 100 ms and
then lose its connection, and `--latency 100 --timeout-rate 1 --timeout 3000` makes one wait
roughly 3.1 seconds and then fail with `504`.

The rates are therefore sequential rather than independent overall probabilities.
`--timeout-rate 0.2 --error-rate 0.5` means 20% of requests time out, and half of the remaining
80% — 40% overall — receive a synthetic error. `--reset-rate 0.1` in front of them takes its 10%
first, and the other two divide up what is left.

Omitting `--reset-rate` (or setting it to `0`) means connections are never reset. Rates outside
`0`-`1`, `NaN`, and infinities are rejected when the server is created, by exactly the same
validator as every other rate.

The reset happens before any forwarding begins. Resetting a connection part-way through a request
body or a response, refusing connections outright, half-open sockets, and configurable reset
timing are all out of scope. Per-endpoint resets are configured with a [config file](#config-file).

## Presets

Reaching for the tool to see what a flaky API does to an application should not start with
remembering that "flaky" means `--error-rate 0.25 --error-status 503`. A preset is a named
starting point for one common scenario:

```bash
chaos-proxy \
  --target http://localhost:3000 \
  --preset flaky-api
```

```text
Chaos Proxy listening on http://127.0.0.1:4000
Target: http://localhost:3000
Preset: flaky-api
Error injection: 25% -> 503
```

| Preset          | Behaviour                                    |
| --------------- | -------------------------------------------- |
| `slow-api`      | Adds 1000 ms latency to every request        |
| `flaky-api`     | 25% of requests fail with `503`              |
| `timeout-heavy` | 30% of requests are held 3000 ms, then `504` |
| `backend-down`  | 100% of requests fail with `503`             |

No built-in preset resets connections, so applying one never starts dropping them; combine
`--reset-rate` with a preset if that is what you want.

`backend-down` is a synthetic failure like any other: the proxy answers `503` itself, and the
target is never contacted. Nothing is done to the connection or to the target, so the upstream can
be perfectly healthy while every request fails.

An unknown name is rejected before the server starts, and the ones that exist are offered:

```text
chaos-proxy: Unknown preset "terrible-network". Available presets: slow-api, flaky-api, timeout-heavy, backend-down.
```

### Preset precedence

```text
explicit CLI flags  >  --preset  >  config file  >  built-in defaults
```

A preset is a base scenario rather than a mode, so a flag typed alongside it still wins:

```bash
chaos-proxy --target http://localhost:3000 --preset flaky-api --error-rate 0.5
```

Half the requests now fail, still with `503` — the flag replaced the rate and left the rest of the
preset alone.

A preset sets only the fields its scenario is about, so it never resets anything else. With a
config file whose `defaults` set `latencyMs: 100` and `errorRate: 0.1`, adding `--preset slow-api`
gives `latencyMs: 1000` and leaves `errorRate: 0.1` exactly where it was.

**A preset sits above the whole config file, endpoint rules included.** With this file:

```yaml
rules:
  - match: /api/payments/*
    errorRate: 1
```

`--preset flaky-api` gives `/api/payments/*` an `errorRate` of `0.25` like everywhere else. That is
deliberate: a preset names the scenario being tested, and a rule that outranked it would make
`--preset backend-down` mean "the backend is down except where the file says otherwise". The
startup summary always describes the settled values, so `--preset flaky-api --error-rate 0` names
the preset and then reports no error injection at all.

Presets change configuration and nothing else. `--preset flaky-api --seed checkout-test` is exactly
as reproducible as any other seeded run — there is no preset-specific seed, and the per-request log
lines are unchanged.

Presets are a command-line convenience only: there is no `preset` field in the [config
file](#config-file), no user-defined or downloaded presets, no preset files, no inheritance or
composition, and no combining two at once.

## Reproducible runs

Chaos is random, which is exactly what makes an interesting failure hard to look at twice.
`--seed` replaces the randomness with a generator built from a seed you choose, so a run can be
repeated:

```bash
chaos-proxy \
  --target http://localhost:3000 \
  --error-rate 0.3 \
  --timeout-rate 0.1 \
  --seed checkout-test
```

```text
Chaos Proxy listening on http://127.0.0.1:4000
Target: http://localhost:3000
Error injection: 30% -> 500
Timeout injection: 10% -> 30000ms
Seed: checkout-test
```

Using the same seed, configuration, and request order produces the same chaos decision sequence.
Run the checkout flow, watch the third request fail, fix something, and run it again: the third
request fails again. Without `--seed`, decisions are ordinarily random, exactly as before.

The seed is an opaque string — `checkout-test`, `12345` and `abc` are all fine, and none of them
is treated as a number. It is used exactly as typed: case and whitespace are significant, so
`checkout-test` and `Checkout-Test` are different runs. An empty seed is rejected rather than
quietly ignored.

### What is and is not promised

There is one generator per run, and every chaos decision draws from it in the documented order —
the reset decision, then the timeout decision if the reset decision declined, then the error
decision if the timeout decision declined too. A request therefore consumes one, two or three
values depending on what happened to it, and the sequence follows the order requests reach that
decision.

**Adding a decision changes what an existing seed means.** Connection resets introduced a third
draw at the front of that order, so a seed replayed against this version produces a different
sequence from the same seed on an earlier one. Reproducibility is a promise about repeating a run
with the same version and settings, not about a seed meaning the same thing forever.

**Concurrent request ordering can change which request consumes which random value.** Two
requests in flight at once may reach the decision in either order, so the outcomes can swap
between runs. Reproducibility holds for the same request sequence in the same order — a scripted
scenario, or an application driven the same way twice — not for an arbitrary set of concurrent
requests.

Seeding is a command-line flag only: it describes one run rather than how an API should misbehave,
so there is no `seed` field in the [config file](#config-file), no per-rule or per-endpoint seed,
and no per-request seeding that would make ordering irrelevant. `Seed: <value>` is printed once at
startup and nowhere else — per-request log lines are unchanged, and no random value or draw
counter is ever printed.

The seed is not a scenario file: nothing is recorded and nothing is replayed. Change any rate, and
the same seed will produce different outcomes, because the same numbers are being compared against
different thresholds.

Programmatically, the same thing is a `random` option — any function returning a value in
`[0, 1)`:

```ts
const server = createProxyServer({
  target: 'http://localhost:5000',
  errorRate: 0.3,
  random: myDeterministicGenerator, // defaults to Math.random
});
```

The seeded generator behind `--seed` is internal, because a plain `() => number` is all the option
asks for.

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

  - match: /api/upload/*
    resetRate: 0.5
```

```bash
chaos-proxy --config chaos.yml
```

```text
Chaos Proxy listening on http://127.0.0.1:4000
Target: http://localhost:3000
Config: /home/you/project/chaos.yml
Rules: 2
Latency: 100ms
```

Every request is now delayed by 100 ms, anything under `/api/payments/` fails with `503` instead
of being forwarded, and half the requests under `/api/upload/` lose their connection. The startup
summary describes what applies to a request no rule matches, so per-rule rates are left in the
file rather than reprinted. A relative path is resolved against the directory you run the command
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
`timeoutRate`, `timeoutMs` and `resetRate` — the same names, meanings and ranges as the
`createProxyServer` options below, validated by the same code. Any other field, at any level, is a mistake and is
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
command-line flags  >  --preset  >  config file  >  built-in defaults
```

A flag you type wins over the config file, and that includes rules:

```bash
chaos-proxy --config chaos.yml --port 5000 --error-rate 0
```

`--port 5000` overrides the file's `port`, and `--error-rate 0` switches error injection off
everywhere — including inside a rule that sets `errorRate: 1`. The reasoning is that a flag typed
on the spot is the more deliberate of the two. A [preset](#presets) sits between the two, above
everything the file says and below anything typed.

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

| Area                | Status                               |
| ------------------- | ------------------------------------ |
| Project scaffolding | Done                                 |
| CLI                 | Done (flags, startup, shutdown)      |
| HTTP forwarding     | Done                                 |
| Latency injection   | Fixed delay                          |
| Error injection     | Fixed status, fixed probability      |
| Timeout injection   | Fixed duration, fixed probability    |
| Connection resets   | Fixed probability, before forwarding |
| Config files        | YAML, with endpoint rules            |
| Presets             | Four built-in scenarios              |
| Request logging     | One line per completed request       |
| Reproducibility     | `--seed`, per request sequence       |
| Other chaos         | Not started                          |

## License

MIT
