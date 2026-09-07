# Chaos Proxy — Project Overview

## Purpose

Chaos Proxy is a local developer tool for testing application resilience by deliberately
degrading communication between an application and an API.

Instead of waiting for a real outage, a developer points their application at Chaos Proxy, which
forwards traffic to the real API while injecting controlled failures. The application then
experiences slow, failing, or unreachable endpoints on demand, locally and repeatably.

## Planned capabilities

Chaos Proxy should eventually support:

- **Latency injection** — add fixed or randomised delays to responses.
- **HTTP error injection** — return chosen status codes (500, 503, 429, …) instead of real
  responses.
- **Request timeouts** — hold a request open so the client hits its own timeout.
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
needed today (`src/index.ts` and `src/cli.ts`); each directory above is created when the feature
that needs it is implemented, rather than up front as empty scaffolding.

## Current status

The repository is bootstrapped with the Node.js + TypeScript toolchain (ESM, Vitest, ESLint,
Prettier) and a placeholder CLI entry point that prints the tool name. No proxying or chaos
behaviour exists yet.
