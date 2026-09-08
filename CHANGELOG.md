# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

There is no `0.1.0` entry below. That was the version the manifest carried through development; it
was never tagged and never published, so `1.0.0` is the first release.

## [Unreleased]

## [1.0.0] - 2026-09-08

### Added

- HTTP and HTTPS proxying to a target API, preserving method, path, query string, body and
  headers.
- Latency injection — a fixed delay added to every request.
- HTTP error injection — a share of requests answered with a synthetic status instead of being
  forwarded.
- Timeout injection — a share of requests held open for a fixed duration and then answered `504`.
- Connection reset injection — a share of requests whose client connection is destroyed outright,
  with no HTTP response at all.
- Endpoint-specific rules in a YAML config file, with exact and trailing-wildcard path matching,
  applied first-match-wins over shared `defaults`.
- Automatic discovery of a `chaos.yml` in the working directory, with `--config` for anything
  else.
- `--print-config`, which prints the fully resolved configuration as YAML and exits without
  binding a port or contacting the upstream.
- Four built-in presets — `slow-api`, `flaky-api`, `timeout-heavy` and `backend-down`.
- `--seed`, which makes chaos decisions reproducible for a given request order.
- Request logging: one line per completed request, with `--quiet` to suppress everything the CLI
  volunteers.
- Graceful shutdown on `SIGINT` and `SIGTERM`, letting requests in flight finish.
- A programmatic API: `createProxyServer`, with optional `resolveChaos` and `onRequestComplete`
  hooks.
- CLI diagnostics written for the person who typed the command: `--help` lists every flag with its
  default, a mistyped flag or out-of-range value is reported on its own with a pointer to `--help`,
  and an unrecognised config field is reported alongside the fields that do exist.
- A packaging smoke test (`npm run package:smoke`) that packs the tarball, installs it into an
  empty project outside the repository, and drives the installed copy — CLI, public API, a
  forwarded request, an injected failure and signal shutdown.
- Release automation: a tag-triggered workflow that checks the tag against the manifest version,
  runs the quality gate and the smoke test, packs the tarball and attaches it to a GitHub Release.
  Publishing to npm is deliberately not part of it.

### Security

- The proxy binds to `127.0.0.1` only, and that is deliberately not configurable.
- Request logging reports method, path, status, duration and outcome. Headers, cookies,
  authorization and bodies are never logged.

[unreleased]: https://github.com/igkougkousis01/chaos-proxy/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/igkougkousis01/chaos-proxy/releases/tag/v1.0.0
