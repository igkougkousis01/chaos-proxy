# Chaos Proxy

A local developer tool for testing how an application behaves when its API misbehaves.

> **Status: under development.** The proxy core can forward HTTP traffic to a target API, but
> no chaos behaviour (latency, errors, timeouts) exists yet. The CLI currently only prints its
> name.

## What it will do

Chaos Proxy will sit between an application and an API and deliberately degrade that
connection — injecting latency, HTTP errors, timeouts, and connection failures — so that loading
states, retries, error handling, and timeout behaviour can be exercised locally.

See [docs/project-overview.md](docs/project-overview.md) for the full scope and planned
capabilities.

## Proxy core

The forwarding layer is available programmatically. `createProxyServer` returns a standard
Node.js `http.Server`, so it is started and stopped like any other:

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

| Area                | Status      |
| ------------------- | ----------- |
| Project scaffolding | Done        |
| CLI entry point     | Placeholder |
| HTTP forwarding     | Done        |
| Chaos behaviour     | Not started |

## License

MIT
