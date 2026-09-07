# Chaos Proxy

A local developer tool for testing how an application behaves when its API misbehaves.

> **Status: under development.** The project is being bootstrapped and does **not** proxy any
> traffic yet. The CLI currently only prints its name.

## What it will do

Chaos Proxy will sit between an application and an API and deliberately degrade that
connection — injecting latency, HTTP errors, timeouts, and connection failures — so that loading
states, retries, error handling, and timeout behaviour can be exercised locally.

See [docs/project-overview.md](docs/project-overview.md) for the full scope and planned
capabilities.

## Requirements

- Node.js >= 22.12
- npm

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

After `npm run build`, the compiled CLI can be run directly:

```bash
node dist/cli.js
```

## Project status

| Area                    | Status      |
| ----------------------- | ----------- |
| Project scaffolding     | Done        |
| CLI entry point         | Placeholder |
| Proxy / chaos behaviour | Not started |

## License

MIT

