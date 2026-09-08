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
with Node's built-in `util.parseArgs`. A missing `--target` is deliberately not diagnosed there:
a `./chaos.yml` may still supply one, and only the resolver knows whether such a file exists, so
the complaint waits until config discovery has had its say. Every chaos flag maps onto one `createProxyServer` option —
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

Which config file that is comes from `src/config/discover.ts`: an explicit `--config`, otherwise a
`chaos.yml` in the working directory, otherwise none. Resolution therefore starts by asking one
helper where the config is rather than by testing for files itself, and the proxy core still knows
nothing about file names, working directories, YAML or discovery.

Resolution produces two things from one pass: the options `createProxyServer` is handed, and a
normalised description of what those options mean. The description — `EffectiveConfig` — is the
settled target, port, config path, preset and seed, plus the complete chaos a request receives when
no rule matches and the complete chaos each rule applies. It is derived by running the proxy core's
own `resolveChaosOptions` over the very same merged chaos the running server gets, in the same two
steps the server takes it in, so it is a rendering of the run rather than a second opinion about
it. There is one precedence implementation, and `--print-config` reads it rather than repeating it.

`--print-config` prints that description as YAML on stdout and exits `0`, having created no server,
bound no port and contacted no upstream. It goes through everything an ordinary run goes through
first, so a missing target, an unusable config file, or a chaos value the core rejects fails on
stderr exactly as it would have on a real run rather than printing a configuration that could not
have started. `src/cli/print.ts` is the whole of the rendering: it fixes the key order, prints every
value including the zeroes and the defaults nothing configured, and prints `null` for an absent
config, preset or seed — consistency is worth more than compactness in output whose entire purpose
is answering "what will this actually do". It is a view of a run and not a formatter: comments,
ordering and formatting from the source file are gone, nothing is written back to disk, and there
are no `--init`, `--write-config` or `--migrate-config` commands to go with it. `--quiet` does not
suppress it, because `--quiet` silences what the CLI volunteers rather than what it was asked for.

The startup summary reports `Connection resets: <rate>` when the settled global rate is above zero,
and says nothing when it is not — the same rule every chaos line follows. Like them it describes
what applies to a request no rule matches; per-rule rates stay in the file rather than being
reprinted as a summary of their own.

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
in flight finish rather than cutting them off. `Press Ctrl+C to stop.` closes the startup summary,
so how to stop it is on screen rather than assumed.

`--help` is a map of the command line rather than its documentation: the tool and what it does,
three invocations — including the bare one that picks up `./chaos.yml` — then the options in two
groups, the presets, and four examples short enough to type. The prose it used to carry about
chaos ordering, log-line shapes and precedence is in the README, where a reader who wants it can
find it and a reader who does not is not scrolling past it. It is plain text with no colour, so it
reads the same in a terminal, a pipe and a log.

The startup summary answers two questions in order: what this run is pointed at — target, config
file, preset, seed — and what it will do to a request. Only lines that apply are printed. A chaos
setting that is off is not mentioned, because a summary that reported `0%` would describe chaos
that never happens, and `Rules:` appears only when the file contributed some, since `Rules: 0`
reads as a file that failed to take effect. The chaos lines are read off the settled options and
run in the order the flags are documented and `--print-config` prints them, so the three places a
setting can be read all agree.

Every user-facing failure has one shape: `chaos-proxy:` and a concise problem, then at most one
line saying what to do about it, both on stderr with a non-zero exit code and no stack trace. One
function writes them, which is what keeps the shape from drifting apart between a usage mistake, a
value the proxy core rejected, an unusable config file and a port that would not bind. The pointer
to `--help` is added only where the help would help — a mistyped flag, a stray argument — rather
than after every failure, since a config file's contents and an occupied port are not things
`--help` has anything to say about. `parseArgs` complaints are rewritten in the CLI's own voice
for the same reason: Node words them for a library's caller, down to three lines of advice about
values that start with a dash. Ranges are still the proxy core's to own — the split into problem
and expectation is a line break, not a second copy of the rules — with `--port` the exception it
already was, so text that is not a number and a number out of range are answered with the same
sentence.

stdout carries what was asked for and what the run is doing: help, the version, the startup
summary, request lines, `--print-config`, and the shutdown notice. stderr carries only what went
wrong. Nothing crosses over, so `chaos-proxy --print-config > run.yml` writes configuration and
nothing else, and a request log is never mistaken for a diagnostic.

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

- `discover.ts` decides which file, if any, this run should read: an explicit `--config` path,
  otherwise `./chaos.yml` if it is there, otherwise nothing. It is the only place the filesystem is
  consulted about where a config lives, and it always answers with an absolute path. An explicit
  path is returned whether or not anything is at it, so `--config` naming a missing file fails
  rather than falling back — a silent fallback would run a configuration nobody asked for and look
  like success. The conventional file's absence is not an error, and no other name, and no other
  directory, is ever looked at.
- `load.ts` reads the file — resolving a relative path against the working directory — and runs it
  through the YAML parser, turning a missing file, a directory, an unreadable file, or a syntax
  error into a plain one-line message. It is also where a schema complaint acquires the path it was
  found in, so validation stays a function of a parsed document while its messages still name a
  file. That matters more now that the file in effect may be one the user never typed.
- `schema.ts` validates the parsed document. The schema is `target`, `port`, `defaults` and
  `rules`, and nothing else: an unknown field at any level is an error rather than something to
  ignore, since a misspelled `errorRate` that is silently dropped looks exactly like chaos that
  does not work — and the message lists the fields that do exist, because the mistake is almost
  always a misspelling and the answer is a short closed set. Every message opens with where the
  problem is, `defaults.errorRate` or `rules[2].match`, before saying what it is. Chaos values are
  handed to the proxy core's own validator and its complaint is re-worded with the path in the
  file, so the config file can never accept a value the programmatic API rejects. There is no
  third-party validation library and no second schema language: `ConfigError` carries the problem
  apart from the rendered message, which is the whole of the machinery needed to re-report it
  against a path.
- `rules.ts` owns matching and merging. A `match` is either an exact path or a trailing `/*`
  prefix; anything else — a `*` in the middle, `**`, a regular expression, a query string — is
  rejected when the file is read. Matching uses the request pathname the proxy already parses for
  forwarding, so the query string never affects which rule applies. The first matching rule wins
  outright: rules are never combined and never scored for specificity, so a file reads top to
  bottom. A rule overrides only the fields it names, leaving the rest of `defaults` intact.

The config layer translates all of that into effective proxy options; the proxy core knows nothing
about YAML, files, or rules.

On the command line, request logging is on by default and `--quiet` turns it off, along with the
startup summary, the stop hint and the shutdown notice — everything the CLI volunteers rather than
everything it has to say, so errors still reach stderr and `--help`, `--version` and
`--print-config` still print. It is a flag only: the config file has no `logging` section, because
a per-run choice about terminal noise does not belong in a file describing how an API should
misbehave.

Randomised or ranged delays and timeout durations, choosing between multiple or weighted error
statuses, and method- or host-specific rules do not exist yet. Nor do the connection failures this
one is not: refusing connections outright, resetting part-way through a request body or a response,
half-open sockets, configurable or per-rule reset timing, packet loss, bandwidth throttling, and
upstream-side connection failures after forwarding has begun. Neither do
structured or JSON logs, log files, log levels, request IDs, tracing, metrics, or naming the rule
that matched in a log line; nor colours, themes, shell completion, interactive prompts, a config
wizard or any other terminal machinery — the output is plain text a pipe can read; nor JSON or TOML config, environment variables or `${VAR}`
interpolation, remote or URL config, multiple config files, includes, inheritance, hot reload, file
watching, or merging several matching rules. Config discovery is deliberately the narrowest rule
that is useful: `./chaos.yml` and nothing else — no `chaos.yaml`, no `.chaos.yml`, no
parent-directory walk, no home directory, and no `package.json` — so which file a run used is
always a single unambiguous answer, and `--print-config` prints it.
Nor, on the reproducibility side, do scenario recording, replay files, per-rule or per-endpoint
seeds, per-request deterministic hashing, order-independent reproducibility, or any form of
distributed or coordinated seeding. On the preset side there are no user-defined or downloaded
presets, no preset files or remote registry, no `preset` field in the config file, no preset
inheritance or composition, no applying two at once, and no per-rule or per-endpoint preset names.

It is built on `node:http` and `node:https`, with `yaml` as its one runtime dependency — parsing
YAML by hand would be a defect waiting to happen, and it is the only thing the package needs that
the standard library does not provide.

## Distribution and release

The repository and the package are not the same thing, and the difference is where a tool like
this usually breaks: everything works against `src/` with `node_modules/` present, and then the
first person to install it finds a `bin` entry pointing at a file that was never packed.

What ships is therefore narrow and stated rather than inferred. `files` is `dist`, minus the
source and declaration maps, plus `examples/` — npm adds `package.json`, `README.md` and `LICENSE`
on its own. The maps are excluded because they name files in `src/`, which deliberately does not
ship: a map whose sources are absent points at nothing. `src/`, `tests/`, `docs/` and `.github/`
are the repository's business and not a consumer's. `prepack` rebuilds `dist/` before anything is
packed, so a stale or missing build cannot become a tarball.

The public API is one export, `createProxyServer`, plus its types. `exports` has a single `.` entry
and no wildcard, so the config layer, the CLI, the preset table, the seeded generator and the log
formatter are all reachable in `dist/` and none of them are importable. That is deliberate: they
are how this tool is built, not what it offers.

`scripts/package-smoke.mjs` is what proves any of that. It packs the package, installs the tarball
into a temporary project outside the repository, and drives the installed copy — asserting what did
and did not ship, that the `bin` target exists with its shebang intact, that `--help` and
`--version` work, that `createProxyServer` imports, that a real request is forwarded and an
injected error is not, and that `SIGINT` and `SIGTERM` exit `0`. It is a Node script rather than a
shell one so it runs the same on macOS and Linux, and it cleans up its tarball, its temporary
directory and its child processes in a `finally`. CI runs it on both platforms, on top of a
quality job across Node 22 and 24 — the oldest line `engines` claims and the current one.

Node support is `>=22.12` because that is what has actually been tested. Broadening it to Node 20
would mean claiming something no run has checked, which is worse than a narrower range.

Releases are cut from tags rather than from pushes. `.github/workflows/release.yml` fires on a
`v*` tag or a manual dispatch, checks the tag against the manifest version before it builds
anything, runs the quality gate and the package smoke test, packs the tarball and attaches it to a
GitHub Release. A manual dispatch is a dry run and never a release: it produces the artifact and
stops, whichever branch or tag it was started from, because creating the release requires the push
event as well as the tag. That condition is deliberately narrower than the one guarding the version
check, so a run that creates a release has always verified the tag first — a property a test
asserts rather than two conditions that happen to match. It is the only workflow with write
permission, and it holds no npm token: publishing to the registry is a deliberate manual step for
now. The package is `@igkougkousis/chaos-proxy` — scoped, because the unscoped name on npm is
someone else's project, and scoped under the maintainer's _npm_ username rather than their GitHub
one, which is the difference `1.0.2` exists to correct — and it has never been published, which is
precisely why the first publish cannot be automated: npm grants a trusted publisher only to a
package that already exists.
`docs/npm-publishing.md` has the sequence.

The version in the manifest is bumped in its own commit immediately before the tag, never as part
of the work being released. `docs/release-checklist.md` is the sequence.
