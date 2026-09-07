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
- **Request logging** — show what was forwarded, what was degraded, and why.

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
needed today (`src/index.ts`, `src/cli.ts`, `src/cli/`, `src/config/`, and `src/proxy/`); each
remaining directory above is created when the feature that needs it is implemented, rather than up
front as empty scaffolding.

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
lives in `src/config/schema.ts`, shared by the flag and the config file's own `port`.

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

Chaos is normally static, decided once when the server is created. An optional `resolveChaos` hook
makes it request-dependent instead: it is called once per request, and what it returns is layered
over the static options for that request only. There is one proxy server regardless of how many
rules exist, and no shared state is mutated per request. A hook that throws or returns an
out-of-range value fails that one request with a `500` rather than taking the process down.

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

Randomised or ranged delays and timeout durations, choosing between multiple or weighted error
statuses, method- or host-specific rules, connection failures, and request logging do not exist
yet. Neither does config auto-discovery, JSON config, environment variables, hot reload, or
merging several matching rules: a config file is used only when `--config` names it.

It is built on `node:http` and `node:https`, with `yaml` as its one runtime dependency — parsing
YAML by hand would be a defect waiting to happen, and it is the only thing the package needs that
the standard library does not provide.
