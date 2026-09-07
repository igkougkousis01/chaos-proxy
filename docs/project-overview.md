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
- **Connection failures** — refuse, drop, or reset connections. _(resetting the client connection
  before forwarding begins, at a fixed probability, implemented; refusing connections outright and
  mid-stream resets are not)_
- **Endpoint-specific rules** — apply different chaos behaviour per path, method, or pattern.
  _(ordered path rules from a YAML config file implemented; method and host rules are not)_
- **Request logging** — show what was forwarded, what was degraded, and why. _(one line per
  completed request implemented; the "why" — which rule matched — is not)_
- **Reproducible runs** — replay the same chaos decisions instead of new ones every time.
  _(implemented as `--seed`, for a given request order; scenario recording and replay files are
  not)_
- **Named scenarios** — reach a common failure mode without remembering its numbers.
  _(implemented as four built-in `--preset` values; user-defined, downloaded and composed presets
  are not)_

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
needed today (`src/index.ts`, `src/cli.ts`, `src/cli/`, `src/config/`, `src/presets/`,
`src/proxy/`, and `src/random/`); each remaining directory above is created when the feature that
needs it is implemented, rather than up front as empty scaffolding.

`random/` was not on the list above and holds one file, `seeded.ts`, because the seeded generator
is neither chaos behaviour nor command-line concern: the proxy core takes a `() => number`, the
CLI turns a `--seed` string into one, and how the numbers are produced belongs to neither.

`presets/` likewise holds one file, `index.ts`, for a similar reason in reverse: a preset is a
block of ordinary chaos options under a name, so it is not chaos behaviour — the proxy core would
be unable to tell a preset from the flags it stands for — and it is not command-line parsing
either, since what a name means should not be buried in argument handling. It is a table, and it
lives on its own.

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
supply the target, the port, or any chaos setting. `--preset` is carried the same way, as a name
rather than as the chaos it stands for. `src/cli/resolve.ts` combines them into a runnable
command, and owns the precedence the tool promises:

```text
command-line flags  >  --preset  >  config file values  >  built-in defaults
```

Chaos flags are applied last of all, so `--error-rate 0` switches error injection off everywhere,
including inside an endpoint rule that sets it to `1`. `--reset-rate` is an ordinary chaos flag on
exactly those terms, and `resetRate` is an ordinary config field: unlike `--seed` and `--preset` it
describes how an API should misbehave rather than how one run should be driven, so it belongs in a
file that is checked in and shared.

The startup summary reports `Connection resets: <rate>` when the settled global rate is above zero,
and says nothing when it is not — the same rule the other chaos lines follow. Like them it
describes what applies to a request no rule matches; per-rule rates stay in the file rather than
being reprinted as a summary of their own.

`src/presets/index.ts` is the whole of the preset feature: a frozen table of four named blocks of
chaos options — `slow-api`, `flaky-api`, `timeout-heavy` and `backend-down` — plus the summaries
`--help` lists them with, rendered from the table rather than written out beside it. Presets exist
so that trying a common failure mode does not begin with recalling that "flaky" means
`--error-rate 0.25 --error-status 503`.

Nothing downstream knows they exist. The resolver flattens the preset and the typed chaos flags
into the single set of overrides the config layer already applies over its `defaults` and over each
rule, so no merging logic is duplicated and the proxy core receives ordinary effective options. A
preset therefore sits above the whole config file, endpoint rules included: it names the scenario
being tested, and a rule that outranked it would make `--preset backend-down` mean "the backend is
down except where the file says otherwise". Each preset sets only the fields its own scenario is
about, so applying one leaves every unrelated setting alone — `slow-api` over a file whose
`defaults` set `errorRate: 0.1` gives `latencyMs: 1000` and that same `errorRate`.

The table is frozen at both levels and handed out as copies, so a run that layers flags over a
preset cannot change what that preset means for the next one. Preset values are validated by the
proxy core's own validator like any others, and a test walks all four through it, so an invalid
built-in preset cannot ship. `--preset` is a command-line flag only, for the same reason `--seed`
is not the config file's business in reverse: adding a `preset` field would put a second
configuration language next to the one the file already is, with inheritance semantics to settle.
Presets are also not part of the package's public API — a consumer of `createProxyServer` passes
the options directly, and a name for them would be a shortcut it has no use for. Startup names the
preset in use on its own line; the chaos lines below it are read off the settled options, so
`--preset flaky-api --error-rate 0` reports the preset and no error injection at all.

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
- `resetRate` destroys the client connection of that fraction of requests outright. Nothing is
  written to it — no status line, no headers, no body — so the client sees a transport failure
  rather than an HTTP response, and no upstream connection is opened either. It is the only
  outcome that is not an HTTP answer, and the only one with no status code.

Chaos is applied in a fixed order — latency delay, then reset, then timeout, then error, then
forwarding — and each request receives at most one injected outcome. The three rates are evaluated
sequentially: `timeoutRate` only sees the requests `resetRate` did not select, and `errorRate` only
sees what neither did. The reset decision comes first because it is the most fundamental of the
three: once the connection is gone there is nothing left to hold open or to answer, so a request it
selects contacts no upstream and consumes no further random values. If the client disconnects
during either wait, the pending timer is cancelled and nothing is decided, forwarded, or written —
including no reset, since the proxy never got as far as choosing one. Endpoint rules change only
which values those steps use; the ordering and the randomness model are untouched, and there is no
per-rule RNG.

The reset is deliberately taken before forwarding begins rather than part-way through a request
body or a response. Mid-stream failure is a different feature with its own state to manage, and
this one is a socket the proxy destroys before it has opened anything.

Those three decisions are the only randomness there is, and they read it from one place: an
optional `random` function on the server, defaulting to `Math.random`. That is the whole of the
seeding mechanism as far as the proxy core is concerned — it knows nothing about seeds, only that
it was handed a source of numbers in `[0, 1)`.

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

There is one generator per run and every decision draws from it in order, so a request consumes
one, two or three values depending on what happened to it and the sequence follows the order
requests reach the decision. Adding the reset decision at the front of that order deliberately
changed what an existing seed means: a seed replayed against this version produces a different
sequence from the same seed before connection resets existed. Reproducibility is a promise about
repeating a run with the same version and settings, not about a seed meaning the same thing across
versions, and the seeded tests pin the current order rather than pretending the old one survived. Reproducibility is therefore promised for the same request sequence in the same
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
outcome is one of five values: `forwarded` (the upstream answered, whatever it answered),
`injected:error`, `injected:timeout`, `connection:reset`, and `upstream:error`. The event carries
facts and no formatting; `src/cli/log.ts` is where they become a line, so timestamps, alignment and
durations rounded for reading all live on the command-line side and the config layer never sees
them.

`statusCode` is `number | null` rather than `number`, which is a real change to the public event
shape. `null` is only ever a `connection:reset`: that request received no HTTP response, so there
is no status to report. It is nullable rather than optional so the key is always present — an event
is a fixed set of facts about one request, and a field that disappears would make consumers
distinguish "no status" from "an older version that did not report one". No number is invented for
it either: `0`, `499` and `444` would each claim an HTTP answer that never happened, and the CLI
prints `RESET` in that column instead.

Emission hangs off the response's own `close` event, which fires exactly once, so an error path
and a completion path cannot both report the same request. Whether that close was a completion or
a disconnect is read from `writableFinished`: a request the client abandoned mid-response reports
nothing rather than a status it never received, and neither does one abandoned during a delay,
where the proxy never chose an outcome at all. A reset is the one outcome that cannot wait for
that close — the socket is about to be destroyed, so the response never becomes `writableFinished`
and the close that follows is indistinguishable from a client hanging up — so it is emitted the
moment it is recorded, guarded by a flag that keeps the close listener from reporting it twice.
That is what keeps a reset the proxy chose from being misread as a client that went away, without
giving up exactly-once emission. Durations come from `performance.now()`, measured
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
statuses, and method- or host-specific rules do not exist yet. Nor do the connection failures this
one is not: refusing connections outright, resetting part-way through a request body or a response,
half-open sockets, configurable or per-rule reset timing, packet loss, bandwidth throttling, and
upstream-side connection failures after forwarding has begun. Neither do
structured or JSON logs, log files, log levels, request IDs, tracing, metrics, or naming the rule
that matched in a log line; nor config auto-discovery, JSON config, environment variables, hot
reload, or merging several matching rules: a config file is used only when `--config` names it.
Nor, on the reproducibility side, do scenario recording, replay files, per-rule or per-endpoint
seeds, per-request deterministic hashing, order-independent reproducibility, or any form of
distributed or coordinated seeding. On the preset side there are no user-defined or downloaded
presets, no preset files or remote registry, no `preset` field in the config file, no preset
inheritance or composition, no applying two at once, and no per-rule or per-endpoint preset names.

It is built on `node:http` and `node:https`, with `yaml` as its one runtime dependency — parsing
YAML by hand would be a defect waiting to happen, and it is the only thing the package needs that
the standard library does not provide.
