# Chaos Proxy — Project Overview

## Purpose

Chaos Proxy is a local developer tool for testing application resilience by deliberately
degrading communication between an application and an API.

Instead of waiting for a real outage, a developer points their application at Chaos Proxy, which
forwards traffic to the real API while injecting controlled failures. The application then
experiences slow, failing, or unreachable endpoints on demand, locally and repeatably.

## Planned capabilities

Chaos Proxy should eventually support:

- **Latency injection** — add fixed or randomised delays to responses. _(fixed delays
  implemented)_
- **HTTP error injection** — return chosen status codes (500, 503, 429, …) instead of real
  responses. _(a single fixed status, at a fixed probability, implemented)_
- **Request timeouts** — hold a request open so the client hits its own timeout. _(a fixed
  hold, at a fixed probability, implemented)_
- **Connection failures** — refuse, drop, or reset connections.
- **Endpoint-specific rules** — apply different chaos behaviour per path, method, or pattern.
  _(ordered path rules from a YAML config file implemented; method and host rules are not)_
- **Request logging** — show what was forwarded, what was degraded, and why. _(one line per
  completed request implemented; the "why" — which rule matched — is not)_
- **Reproducible runs** — replay the same chaos decisions instead of new ones every time.
  _(implemented as `--seed`, for a given request order; scenario recording and replay files are
  not)_

## Target users

Primarily frontend and full-stack developers who need to test:

- loading states
- retry logic
- error states
- timeout behaviour
- generally degraded network conditions

The tool is aimed at local development and manual/automated testing, not at production traffic.

## MVP boundaries

To prevent scope creep, the first MVP explicitly does **not** include:

- authentication
- databases
- user accounts
- SaaS / cloud hosting
- AI features
- a web dashboard
- Kubernetes functionality

The MVP is a single-process, locally run CLI. Anything on this list is out of scope until the
core proxy and chaos behaviour are complete and proven useful.

## Desired initial architecture

As functionality lands, the source tree is expected to grow roughly into:

```text
src/
├── cli/      # argument parsing, command wiring, user-facing output
├── proxy/    # HTTP forwarding to the target API
├── chaos/    # latency, error, timeout, and connection-failure behaviour
├── config/   # loading and validating chaos rules
└── logger/   # request/response and chaos-decision logging
```

This is a target, not a starting point. The repository deliberately keeps the minimum structure
needed today (`src/index.ts`, `src/cli.ts`, `src/cli/`, `src/config/`, `src/proxy/`, and
`src/random/`); each remaining directory above is created when the feature that needs it is
implemented, rather than up front as empty scaffolding.

`random/` was not on the list above and holds one file, `seeded.ts`, because the seeded generator
is neither chaos behaviour nor command-line concern: the proxy core takes a `() => number`, the
CLI turns a `--seed` string into one, and how the numbers are produced belongs to neither.

`logger/` has not been created, and request logging did not warrant it: the proxy core reports a
small event and `src/cli/log.ts` turns it into a line. A directory would be a home for a logging
subsystem, and there is no subsystem — no levels, no sinks, no formats to choose between.

## Current status

The repository is bootstrapped with the Node.js + TypeScript toolchain (ESM, Vitest, ESLint,
Prettier).

`src/cli/` implements the command-line interface, which is how the tool is normally used:

```bash
chaos-proxy --target http://localhost:3000 --latency 500 --error-rate 0.2
```

`src/cli.ts` is the executable entry point and does nothing but call `runCli`, which lives in
`src/cli/program.ts` alongside startup and shutdown; `src/cli/options.ts` parses the command line
with Node's built-in `util.parseArgs`. Every chaos flag maps onto one `createProxyServer` option —
the CLI checks only that a value is a number, and leaves the ranges to the proxy core, which stays
the single authority on them. `--port` is the exception: no core validator owns it, so its range
lives in `src/config/schema.ts`, shared by the flag and the config file's own `port`. `--seed` is
not a chaos flag at all — it changes where the decisions get their numbers, not what they decide —
so it is carried separately and never reaches the chaos block.

Parsing reports only what the user typed and settles nothing, because a config file may still
supply the target, the port, or any chaos setting. `src/cli/resolve.ts` combines the two into a
runnable command, and owns the precedence the tool promises:

```text
command-line flags  >  config file values  >  built-in defaults
```

Chaos flags are applied last of all, so `--error-rate 0` switches error injection off everywhere,
including inside an endpoint rule that sets it to `1`.

The proxy binds to `127.0.0.1` only, and that is deliberately not configurable: a tool whose
purpose is to break traffic should never be reachable from the LAN by accident. `SIGINT` and
`SIGTERM` stop it by closing the listener and releasing idle keep-alive sockets, letting requests
in flight finish rather than cutting them off. Usage mistakes, options the core rejects, and a
port that is already in use are all reported as a single readable line and a non-zero exit code,
without a stack trace; unexpected errors are still allowed to surface normally.

`src/proxy/` implements the forwarding layer: `createProxyServer({ target })` returns a Node.js
`http.Server` that streams requests through to an `http:` or `https:` target and streams the
upstream response back, preserving method, path, query string, body, and headers. Unreachable
targets produce a `502 Bad Gateway` instead of crashing the process.

The chaos behaviour implemented so far also lives there, and each part of it is reachable
from the CLI:

- `latencyMs` adds a fixed artificial delay before the upstream request is opened, leaving body
  streaming untouched.
- `errorRate` and `errorStatus` answer that fraction of requests with a synthetic HTTP error
  (default `500`, plain text) instead of forwarding them, without opening an upstream connection.
- `timeoutRate` and `timeoutMs` hold that fraction of requests open for a fixed duration (default
  `30000` ms) and then answer `504 Gateway Timeout` with a plain-text body, again without opening
  an upstream connection or forwarding the request body. This is an injected stall, not detection
  of a genuinely slow upstream.

Chaos is applied in a fixed order — latency delay, then timeout, then error, then forwarding —
and each request receives at most one injected outcome. The two rates are evaluated sequentially:
`errorRate` only sees the requests that `timeoutRate` did not select. If the client disconnects
during either wait, the pending timer is cancelled and nothing is decided, forwarded, or written.
Endpoint rules change only which values those steps use; the ordering and the randomness model are
untouched, and there is no per-rule RNG.

Those two decisions are the only randomness there is, and they read it from one place: an optional
`random` function on the server, defaulting to `Math.random`. That is the whole of the seeding
mechanism as far as the proxy core is concerned — it knows nothing about seeds, only that it was
handed a source of numbers in `[0, 1)`.

`src/random/seeded.ts` is what the command line hands it for `--seed`. It hashes the seed string
to a 32-bit integer with FNV-1a over the string's UTF-16 code units and steps a Mulberry32
generator from it — both defined purely in 32-bit integer arithmetic, so the same seed yields the
same sequence on every platform and Node version. Neither is cryptographic and neither is meant to
be: this is a reproducibility tool. The generator's output is pinned exactly in
`tests/random/seeded.test.ts`, which makes changing the algorithm a deliberate decision about what
every existing seed means rather than a detail that can drift.

Seeding is a command-line flag and nothing else. There is no `seed` field in the config schema,
because a seed describes one run rather than how an API should misbehave, and a file that is
checked in and shared is the wrong place for it. `--seed` requires a non-empty value: an empty one
would fall back to ordinary randomness while looking exactly like a reproducible run.

There is one generator per run and both decisions draw from it in order, so a request consumes one
or two values depending on what happened to it and the sequence follows the order requests reach
the decision. Reproducibility is therefore promised for the same request sequence in the same
order, not for an arbitrary set of concurrent requests: two requests in flight at once may reach
the decision in either order and swap outcomes between runs. Making that irrelevant would mean
deriving each request's draws from the request itself, which is a different feature and not this
one. The seed appears once in the startup summary and nowhere else — request log lines are
unchanged, and no random value or draw counter is ever printed.

Chaos is normally static, decided once when the server is created. An optional `resolveChaos` hook
makes it request-dependent instead: it is called once per request, and what it returns is layered
over the static options for that request only. There is one proxy server regardless of how many
rules exist, and no shared state is mutated per request. A hook that throws or returns an
out-of-range value fails that one request with a `500` rather than taking the process down.

The proxy core prints nothing. A second optional hook, `onRequestComplete`, reports what happened
to each request that completed — method, pathname, status, duration, outcome, and the artificial
latency that actually applied — and a caller that does not supply it gets no output at all. The
outcome is one of four values: `forwarded` (the upstream answered, whatever it answered),
`injected:error`, `injected:timeout`, and `upstream:error`. The event carries facts and no
formatting; `src/cli/log.ts` is where they become a line, so timestamps, alignment and durations
rounded for reading all live on the command-line side and the config layer never sees them.

Emission hangs off the response's own `close` event, which fires exactly once, so an error path
and a completion path cannot both report the same request. Whether that close was a completion or
a disconnect is read from `writableFinished`: a request the client abandoned mid-response reports
nothing rather than a status it never received, and neither does one abandoned during a delay,
where the proxy never chose an outcome at all. Durations come from `performance.now()`, measured
from the moment the request arrives, so an adjusted system clock cannot produce a negative one.
The two paths where the proxy refuses a request before choosing any outcome — an unparsable
request target, and a `resolveChaos` hook that cannot produce usable options — report nothing,
since neither is one of the four fates a request it understood can meet.

`src/config/` implements the YAML config file, and is the only consumer of that hook:

- `load.ts` reads the file — resolving a relative path against the working directory — and runs it
  through the YAML parser, turning a missing file, a directory, an unreadable file, or a syntax
  error into a plain one-line message.
- `schema.ts` validates the parsed document. The schema is `target`, `port`, `defaults` and
  `rules`, and nothing else: an unknown field at any level is an error rather than something to
  ignore, since a misspelled `errorRate` that is silently dropped looks exactly like chaos that
  does not work. Chaos values are handed to the proxy core's own validator and its complaint is
  re-worded with the path in the file, so the config file can never accept a value the
  programmatic API rejects.
- `rules.ts` owns matching and merging. A `match` is either an exact path or a trailing `/*`
  prefix; anything else — a `*` in the middle, `**`, a regular expression, a query string — is
  rejected when the file is read. Matching uses the request pathname the proxy already parses for
  forwarding, so the query string never affects which rule applies. The first matching rule wins
  outright: rules are never combined and never scored for specificity, so a file reads top to
  bottom. A rule overrides only the fields it names, leaving the rest of `defaults` intact.

The config layer translates all of that into effective proxy options; the proxy core knows nothing
about YAML, files, or rules.

On the command line, request logging is on by default and `--quiet` turns it off, along with the
startup summary and the shutdown notice — everything the CLI volunteers rather than everything it
has to say, so errors still reach stderr and `--help` and `--version` still print. It is a flag
only: the config file has no `logging` section, because a per-run choice about terminal noise does
not belong in a file describing how an API should misbehave.

Randomised or ranged delays and timeout durations, choosing between multiple or weighted error
statuses, method- or host-specific rules, and connection failures do not exist yet. Neither do
structured or JSON logs, log files, log levels, request IDs, tracing, metrics, or naming the rule
that matched in a log line; nor config auto-discovery, JSON config, environment variables, hot
reload, or merging several matching rules: a config file is used only when `--config` names it.
Nor, on the reproducibility side, do scenario recording, replay files, per-rule or per-endpoint
seeds, per-request deterministic hashing, order-independent reproducibility, or any form of
distributed or coordinated seeding.

It is built on `node:http` and `node:https`, with `yaml` as its one runtime dependency — parsing
YAML by hand would be a defect waiting to happen, and it is the only thing the package needs that
the standard library does not provide.
