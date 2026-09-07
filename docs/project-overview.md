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
needed today (`src/index.ts`, `src/cli.ts`, and `src/proxy/`); each remaining directory above is
created when the feature that needs it is implemented, rather than up front as empty scaffolding.

## Current status

The repository is bootstrapped with the Node.js + TypeScript toolchain (ESM, Vitest, ESLint,
Prettier) and a placeholder CLI entry point that prints the tool name.

`src/proxy/` implements the forwarding layer: `createProxyServer({ target })` returns a Node.js
`http.Server` that streams requests through to an `http:` or `https:` target and streams the
upstream response back, preserving method, path, query string, body, and headers. Unreachable
targets produce a `502 Bad Gateway` instead of crashing the process.

The chaos behaviour implemented so far also lives there, and is programmatic only:

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

Randomised or ranged delays and timeout durations, choosing between multiple or weighted error
statuses, per-endpoint or per-method rules, connection failures, configuration loading, and CLI
argument parsing do not exist yet.

It is built on `node:http` and `node:https` with no runtime dependencies.
