# Contributing

Thanks for taking an interest. Bug reports and small, focused pull requests are both welcome.

## Requirements

- Node.js >= 22.12 (see [`engines`](package.json))
- npm

## Getting set up

```bash
git clone https://github.com/igkougkousis01/chaos-proxy.git
cd chaos-proxy
npm ci
```

Use `npm ci` rather than `npm install`, so you get the dependency versions the lockfile and CI
agree on.

## Making a change

1. Branch off `main`.
2. Keep the change focused. One PR should do one thing; unrelated fixes, formatting sweeps and
   refactors belong in their own.
3. Add or update tests if behaviour changed. A bug fix should come with the test that would have
   caught it.
4. Update the docs if behaviour changed — the README documents every flag and config field, and
   `docs/project-overview.md` records what exists and what is deliberately out of scope.
5. Add an entry under `## [Unreleased]` in [CHANGELOG.md](CHANGELOG.md) for anything a user would
   notice.

## Before opening a pull request

```bash
npm run check
```

That runs the same gate CI does: typecheck, lint, format check, tests, build.

If your change touches the package itself — `package.json`, the build output, the `bin` entry, the
`exports` map, what gets shipped — also run:

```bash
npm run package:smoke
```

That packs the package, installs it into a throwaway project outside the repository, and drives
the installed copy: the CLI as a child process, the public API as an import, and a real request
forwarded through a real proxy. It is the only thing that catches a package that works here and
breaks for everyone else.

## Scope

Chaos Proxy is deliberately small: a single-process local CLI with one runtime dependency. New
chaos primitives are in scope; dashboards, telemetry, hosted services and plugin systems are not.
`docs/project-overview.md` has the boundaries. If you are planning something substantial, open an
issue first — it is easier to agree on the shape before the code exists.

## Releases

Maintainers only: [docs/release-checklist.md](docs/release-checklist.md).
