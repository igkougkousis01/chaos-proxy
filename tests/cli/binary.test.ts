import { execFile, spawn } from 'node:child_process';
import type { ChildProcessByStdio } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { parse as parseYaml } from 'yaml';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { STOP_HINT } from '../../src/cli/program.js';

/**
 * These tests drive the compiled `dist/cli.js` as a real child process, so they
 * cover the parts that only exist outside the module: the shebang, the `bin`
 * entry, exit codes, and signal handling. Everything that can be checked
 * in-process is covered in `options.test.ts` and `program.test.ts` instead, so
 * this file stays small.
 */

const execFileAsync = promisify(execFile);

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const cliPath = fileURLToPath(new URL('../../dist/cli.js', import.meta.url));

/** How long any single wait in this file may take before it is a failure. */
const WAIT_TIMEOUT_MS = 15_000;

beforeAll(async () => {
  // The tests must run against freshly compiled output, not whatever `dist/`
  // happened to contain.
  await execFileAsync('npm', ['run', 'build'], { cwd: repoRoot });
}, 180_000);

interface CliProcess {
  readonly child: ChildProcessByStdio<null, Readable, Readable>;
  readonly stdout: () => string;
  readonly stderr: () => string;
  /** Resolves once the process has exited, with its code and signal. */
  readonly exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

const running = new Set<CliProcess>();
const openServers = new Set<Server>();
const tempDirs: string[] = [];

afterEach(async () => {
  const children = [...running];
  running.clear();
  await Promise.all(
    children.map(async (cli) => {
      cli.child.kill('SIGKILL');
      await cli.exit;
    }),
  );

  const servers = [...openServers];
  openServers.clear();
  await Promise.all(
    servers.map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => {
            resolve();
          });
        }),
    ),
  );

  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();

    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

/** A scratch directory that is removed after the test that made it. */
function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'chaos-proxy-cli-'));
  tempDirs.push(dir);

  return dir;
}

/** Writes a config file that is removed after the test that made it. */
function writeTempConfig(contents: string, name = 'chaos.yml'): string {
  const path = join(makeTempDir(), name);
  writeFileSync(path, contents, 'utf8');

  return path;
}

/** Writes `name` into `dir`, for tests about which file gets picked up. */
function writeConfigIn(dir: string, name: string, contents: string): string {
  const path = join(dir, name);
  writeFileSync(path, contents, 'utf8');

  return path;
}

/**
 * Spawns the built CLI, capturing both streams.
 *
 * `cwd` defaults to the repository root, which holds no `chaos.yml`, so an
 * ordinary test is unaffected by config discovery. A test about discovery
 * passes a scratch directory instead, so nothing is left to the directory the
 * suite happens to be run from.
 */
function startCli(args: readonly string[], cwd = repoRoot): CliProcess {
  const child = spawn(process.execPath, [cliPath, ...args], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });

  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => {
        resolve({ code, signal });
      });
    },
  );

  const cli: CliProcess = { child, stdout: () => stdout, stderr: () => stderr, exit };
  running.add(cli);

  return cli;
}

/**
 * Waits for `expected` to appear on the CLI's stdout, or fails with what it saw.
 *
 * A pattern is accepted as well as a literal, because a request log line
 * carries a timestamp and a duration that no test should be pinning down.
 */
function waitForOutput(cli: CliProcess, expected: string | RegExp): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;

    function finish(error?: Error): void {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);
      cli.child.stdout.off('data', onData);

      if (error) {
        reject(error);
      } else {
        resolve();
      }
    }

    function seen(): boolean {
      return typeof expected === 'string'
        ? cli.stdout().includes(expected)
        : expected.test(cli.stdout());
    }

    function describe(what: string): Error {
      return new Error(`${what}\nstdout: ${cli.stdout()}\nstderr: ${cli.stderr()}`);
    }

    function onData(): void {
      if (seen()) {
        finish();
      }
    }

    const timer = setTimeout(() => {
      finish(describe(`timed out waiting for ${String(expected)}.`));
    }, WAIT_TIMEOUT_MS);

    cli.child.stdout.on('data', onData);
    void cli.exit.then(
      () => {
        finish(seen() ? undefined : describe('the CLI exited first.'));
      },
      () => {
        finish(describe('the CLI could not be started.'));
      },
    );
    onData();
  });
}

/** The TCP address a test server is listening on. */
function addressOf(server: Server): AddressInfo {
  const address = server.address();

  if (address === null || typeof address === 'string') {
    throw new Error('expected the server to be listening on a TCP port');
  }

  return address;
}

/** Starts a temporary upstream that records what it received. */
async function startUpstream(
  handler: (req: IncomingMessage, res: ServerResponse) => void = (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('upstream ok');
  },
): Promise<{ origin: string; requests: IncomingMessage[]; connectionCount: () => number }> {
  const requests: IncomingMessage[] = [];
  const server = createServer((req, res) => {
    requests.push(req);
    handler(req, res);
  });
  let connections = 0;
  server.on('connection', () => {
    connections += 1;
  });
  openServers.add(server);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  return {
    origin: `http://127.0.0.1:${addressOf(server).port}`,
    requests,
    connectionCount: () => connections,
  };
}

/** Binds a loopback port and releases it, so nothing is listening there. */
async function findFreePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = addressOf(server);
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });

  return port;
}

/** Occupies a loopback port for the duration of one test. */
async function occupyPort(): Promise<number> {
  const server = createServer();
  openServers.add(server);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  return addressOf(server).port;
}

/**
 * Starts the CLI against `target` on a free port and waits until `readyText`
 * has been printed.
 *
 * Startup lines can arrive in separate chunks, so readiness defaults to the
 * stop hint: it is the last line of every summary, and a caller that has seen
 * it can assert on any line above it without racing the next chunk.
 */
async function startProxyCli(
  target: string,
  chaosArgs: readonly string[] = [],
  readyText: string | RegExp = STOP_HINT,
): Promise<{ cli: CliProcess; baseUrl: string }> {
  const port = await findFreePort();
  const cli = startCli(['--target', target, '--port', String(port), ...chaosArgs]);
  await waitForOutput(cli, readyText);

  return { cli, baseUrl: `http://127.0.0.1:${port}` };
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Requests `url`, retrying until the proxy is accepting connections.
 *
 * `--quiet` prints nothing at all, so there is no startup line to wait for; the
 * listener itself becomes the readiness signal. The retry loop is bounded, so a
 * proxy that never comes up fails rather than hanging.
 */
async function fetchWhenListening(url: string): Promise<Response> {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;

  for (;;) {
    try {
      return await fetch(url);
    } catch (error) {
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for ${url} to accept connections`, { cause: error });
      }

      await sleep(50);
    }
  }
}

/** What one raw request through the built CLI got back. */
interface RequestAttempt {
  /** Status the client received, or `undefined` if it never got a response. */
  readonly statusCode: number | undefined;
  /** Whether the request failed at the transport level instead. */
  readonly failed: boolean;
}

/**
 * Sends a request with the raw client and reports whether it got a response.
 *
 * `fetch` turns every transport failure into the same opaque `TypeError`, which
 * cannot tell a connection the proxy dropped from a proxy that is not running.
 * Which error code the platform produces is deliberately not asserted on.
 */
function attempt(url: string): Promise<RequestAttempt> {
  return new Promise<RequestAttempt>((resolve, reject) => {
    const req = httpRequest(url, (res) => {
      res.resume();
      res.once('end', () => {
        resolve({ statusCode: res.statusCode, failed: false });
      });
      res.once('error', () => {
        resolve({ statusCode: res.statusCode, failed: false });
      });
    });

    req.on('error', () => {
      resolve({ statusCode: undefined, failed: true });
    });

    req.end();
    setTimeout(() => {
      req.destroy();
      reject(new Error(`timed out waiting for ${url}`));
    }, WAIT_TIMEOUT_MS).unref();
  });
}

describe('package bin entry', () => {
  it('points at built output that node can execute directly', () => {
    const manifest: unknown = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    );

    expect(manifest).toMatchObject({ bin: { 'chaos-proxy': './dist/cli.js' } });

    const built = readFileSync(cliPath, 'utf8');
    expect(built.split('\n')[0]).toBe('#!/usr/bin/env node');
  });
});

describe('the built CLI', () => {
  it('prints help and exits successfully', async () => {
    const cli = startCli(['--help']);

    await expect(cli.exit).resolves.toMatchObject({ code: 0 });
    expect(cli.stdout()).toContain('chaos-proxy --target <url> [options]');
    expect(cli.stdout()).toContain('--error-rate');
    expect(cli.stderr()).toBe('');
  }, 20_000);

  it('prints the package version and exits successfully', async () => {
    const manifest: unknown = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    );
    const version =
      typeof manifest === 'object' && manifest !== null && 'version' in manifest
        ? String(manifest.version)
        : '';
    const cli = startCli(['--version']);

    await expect(cli.exit).resolves.toMatchObject({ code: 0 });
    expect(cli.stdout().trim()).toBe(version);
  }, 20_000);

  it('fails without a target and never listens', async () => {
    const cli = startCli([]);

    const { code } = await cli.exit;

    expect(code).not.toBe(0);
    expect(cli.stdout()).toBe('');
    expect(cli.stderr()).toContain('--target');
  }, 20_000);

  it('fails on an invalid port and never listens', async () => {
    const cli = startCli(['--target', 'http://127.0.0.1:1', '--port', '0']);

    const { code } = await cli.exit;

    expect(code).not.toBe(0);
    expect(cli.stdout()).toBe('');
    expect(cli.stderr()).toContain('--port');
  }, 20_000);

  it('fails cleanly when the port is already in use', async () => {
    const port = await occupyPort();
    const cli = startCli(['--target', 'http://127.0.0.1:1', '--port', String(port)]);

    const { code } = await cli.exit;

    expect(code).toBe(1);
    expect(cli.stderr()).toContain(`Port ${port} is already in use`);
    expect(cli.stderr()).toContain('Choose another port with --port.');
    // An expected user error, not a crash.
    expect(cli.stderr()).not.toContain('at ');
  }, 20_000);

  it('forwards a request to the upstream and shuts down on SIGINT', async () => {
    const upstream = await startUpstream();
    const { cli, baseUrl } = await startProxyCli(upstream.origin);

    expect(cli.stdout()).toContain('Chaos Proxy listening on http://127.0.0.1:');

    const response = await fetch(`${baseUrl}/api/users?page=2`);

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe('upstream ok');
    expect(upstream.requests[0]?.url).toBe('/api/users?page=2');

    cli.child.kill('SIGINT');

    await expect(cli.exit).resolves.toMatchObject({ code: 0, signal: null });
    expect(cli.stdout()).toContain('shutting down');
  }, 30_000);

  it('shuts down on SIGTERM', async () => {
    const upstream = await startUpstream();
    const { cli } = await startProxyCli(upstream.origin);

    cli.child.kill('SIGTERM');

    await expect(cli.exit).resolves.toMatchObject({ code: 0, signal: null });
    expect(cli.stdout()).toContain('Received SIGTERM');
  }, 30_000);

  it('applies --latency to requests it forwards', async () => {
    const upstream = await startUpstream();
    const { baseUrl } = await startProxyCli(
      upstream.origin,
      ['--latency', '300'],
      'Latency: 300ms',
    );

    const startedAt = performance.now();
    const response = await fetch(`${baseUrl}/api/users`);
    const elapsed = performance.now() - startedAt;

    expect(response.status).toBe(200);
    // Lower bound only, with slack for timer coarseness and loaded runners.
    expect(elapsed).toBeGreaterThanOrEqual(250);
  }, 30_000);

  it('applies --error-rate and --error-status without reaching the upstream', async () => {
    const upstream = await startUpstream();
    const { baseUrl } = await startProxyCli(
      upstream.origin,
      ['--error-rate', '1', '--error-status', '503'],
      'Error injection: 100% -> 503',
    );

    const response = await fetch(`${baseUrl}/api/users`);

    expect(response.status).toBe(503);
    await expect(response.text()).resolves.toBe('Chaos Proxy injected error');
    expect(upstream.requests).toHaveLength(0);
  }, 30_000);
});

describe('the built CLI help', () => {
  it('opens with what the tool is and how it is invoked', async () => {
    const cli = startCli(['--help']);

    await expect(cli.exit).resolves.toMatchObject({ code: 0 });

    const help = cli.stdout();

    expect(help.split('\n')[0]).toBe('Chaos Proxy');
    expect(help).toContain('Inject latency, HTTP errors, timeouts and connection resets');
    expect(help).toContain('chaos-proxy --target <url> [options]');
    expect(help).toContain('chaos-proxy --config <path> [options]');
    expect(cli.stderr()).toBe('');
  }, 20_000);

  it('offers every chaos flag and every preset', async () => {
    const cli = startCli(['--help']);

    await expect(cli.exit).resolves.toMatchObject({ code: 0 });

    const help = cli.stdout();

    for (const flag of [
      '--latency <ms>',
      '--error-rate <0-1>',
      '--error-status <400-599>',
      '--timeout-rate <0-1>',
      '--timeout <ms>',
      '--reset-rate <0-1>',
    ]) {
      expect(help).toContain(flag);
    }

    for (const preset of ['slow-api', 'flaky-api', 'timeout-heavy', 'backend-down']) {
      expect(help).toContain(preset);
    }
  }, 20_000);

  // Someone who never opens the README has to learn this from help alone,
  // otherwise a checked-in chaos.yml looks like chaos coming from nowhere.
  it('says that ./chaos.yml is loaded on its own', async () => {
    const cli = startCli(['--help']);

    await expect(cli.exit).resolves.toMatchObject({ code: 0 });
    expect(cli.stdout()).toContain('./chaos.yml');
    expect(cli.stdout()).toContain('auto-loads ./chaos.yml when present');
  }, 20_000);

  it('shows examples, and stays short enough to read', async () => {
    const cli = startCli(['--help']);

    await expect(cli.exit).resolves.toMatchObject({ code: 0 });

    const help = cli.stdout();

    expect(help).toContain('Examples:');
    expect(help).toContain('chaos-proxy --target http://localhost:3000 --preset flaky-api');
    expect(help.trimEnd().split('\n').length).toBeLessThanOrEqual(60);
  }, 20_000);
});

describe('the built CLI startup summary', () => {
  it('reports the run and how to stop it, and nothing that is switched off', async () => {
    const upstream = await startUpstream();
    const { cli } = await startProxyCli(upstream.origin);

    const lines = cli.stdout().trimEnd().split('\n');

    expect(lines[0]).toMatch(/^Chaos Proxy listening on http:\/\/127\.0\.0\.1:\d+$/);
    expect(lines[1]).toBe(`Target: ${upstream.origin}`);
    expect(lines[2]).toBe(STOP_HINT);
    expect(lines).toHaveLength(3);
  }, 30_000);

  it('exits cleanly on Ctrl+C, and says so once', async () => {
    const upstream = await startUpstream();
    const { cli } = await startProxyCli(upstream.origin);

    cli.child.kill('SIGINT');

    await expect(cli.exit).resolves.toMatchObject({ code: 0, signal: null });

    const output = cli.stdout();

    expect(output).toContain('Received SIGINT, shutting down Chaos Proxy.');
    // The hint belongs to a proxy that is running, not to one that is stopping.
    expect(output.split(STOP_HINT)).toHaveLength(2);
    expect(output.indexOf(STOP_HINT)).toBeLessThan(output.indexOf('shutting down'));
    expect(cli.stderr()).toBe('');
  }, 30_000);

  it('describes a run with a config file, a preset and a seed', async () => {
    const upstream = await startUpstream();
    const dir = makeTempDir();
    writeConfigIn(
      dir,
      'chaos.yml',
      `target: ${upstream.origin}\n\ndefaults:\n  latencyMs: 20\n\nrules:\n  - match: /api/*\n    errorRate: 0\n`,
    );
    const port = await findFreePort();
    const cli = startCli(
      ['--port', String(port), '--preset', 'flaky-api', '--seed', 'checkout-test'],
      dir,
    );

    await waitForOutput(cli, STOP_HINT);

    const lines = cli.stdout().trimEnd().split('\n');

    expect(lines.slice(1)).toEqual([
      `Target: ${upstream.origin}`,
      `Config: ${join(realpathSync(dir), 'chaos.yml')}`,
      'Preset: flaky-api',
      'Seed: checkout-test',
      'Latency: 20ms',
      'Error injection: 25% -> 503',
      'Rules: 1',
      STOP_HINT,
    ]);
  }, 30_000);
});

describe('the built CLI errors', () => {
  it('refuses an unknown option without a stack trace, and points at the help', async () => {
    const cli = startCli(['--erro-rate', '0.5']);

    const { code } = await cli.exit;

    expect(code).toBe(1);
    expect(cli.stdout()).toBe('');
    expect(cli.stderr().trimEnd().split('\n')).toEqual([
      'chaos-proxy: Unknown option --erro-rate.',
      'Run `chaos-proxy --help` for usage.',
    ]);
    expect(cli.stderr()).not.toContain('    at ');
  }, 20_000);

  it('refuses a numeric value out of range, saying what was expected', async () => {
    const cli = startCli(['--target', 'http://127.0.0.1:1', '--error-rate', '2']);

    const { code } = await cli.exit;

    expect(code).toBe(1);
    expect(cli.stdout()).toBe('');
    expect(cli.stderr().trimEnd().split('\n')).toEqual([
      'chaos-proxy: Invalid --error-rate 2.',
      'Expected a number between 0 and 1 inclusive.',
    ]);
    expect(cli.stderr()).not.toContain('    at ');
  }, 20_000);

  it('says what to provide when nothing supplies a target', async () => {
    const cli = startCli([], makeTempDir());

    const { code } = await cli.exit;

    expect(code).toBe(1);
    expect(cli.stderr().trimEnd().split('\n')).toEqual([
      'chaos-proxy: Missing required target.',
      'Provide --target <url>, or set "target" in ./chaos.yml.',
    ]);
  }, 20_000);
});

describe('the built CLI request logging', () => {
  it('prints one completion line per request by default', async () => {
    const upstream = await startUpstream();
    const { cli, baseUrl } = await startProxyCli(upstream.origin);

    const response = await fetch(`${baseUrl}/api/users?page=2`);
    expect(response.status).toBe(200);
    await response.text();

    // Components rather than a whole line: the timestamp and the duration are
    // real and must not be pinned down.
    await waitForOutput(cli, /\d{2}:\d{2}:\d{2} +GET +\/api\/users -> 200 \d+ms forwarded/);

    // The query string is forwarded but deliberately kept out of the log line.
    expect(upstream.requests[0]?.url).toBe('/api/users?page=2');
    expect(cli.stdout()).not.toContain('page=2');
    expect(cli.stderr()).toBe('');
  }, 30_000);

  it('prints one line per request and no more', async () => {
    const upstream = await startUpstream();
    const { cli, baseUrl } = await startProxyCli(upstream.origin);

    for (const path of ['/one', '/two', '/three']) {
      await (await fetch(`${baseUrl}${path}`)).text();
    }

    await waitForOutput(cli, '/three');
    await sleep(200);

    const completionLines = cli
      .stdout()
      .split('\n')
      .filter((line) => /-> \d{3} /.test(line));

    expect(completionLines).toHaveLength(3);
  }, 30_000);

  it('reports the effective latency alongside a forwarded request', async () => {
    const upstream = await startUpstream();
    const { cli, baseUrl } = await startProxyCli(
      upstream.origin,
      ['--latency', '300'],
      'Latency: 300ms',
    );

    await (await fetch(`${baseUrl}/api/profile`)).text();

    await waitForOutput(cli, /\/api\/profile -> 200 \d+ms forwarded latency:\+300ms/);
  }, 30_000);

  it('identifies an injected error', async () => {
    const upstream = await startUpstream();
    const { cli, baseUrl } = await startProxyCli(
      upstream.origin,
      ['--error-rate', '1', '--error-status', '503'],
      'Error injection: 100% -> 503',
    );

    const response = await fetch(`${baseUrl}/api/payments/123`, { method: 'POST' });
    expect(response.status).toBe(503);
    await response.text();

    await waitForOutput(cli, /POST +\/api\/payments\/123 -> 503 \d+ms injected:error/);
  }, 30_000);

  it('identifies an injected timeout', async () => {
    const upstream = await startUpstream();
    const { cli, baseUrl } = await startProxyCli(
      upstream.origin,
      ['--timeout-rate', '1', '--timeout', '50'],
      'Timeout injection: 100% after 50ms',
    );

    const response = await fetch(`${baseUrl}/api/search`);
    expect(response.status).toBe(504);
    await response.text();

    await waitForOutput(cli, /\/api\/search -> 504 \d+ms injected:timeout/);
  }, 30_000);

  it('documents --quiet in its help', async () => {
    const cli = startCli(['--help']);

    await expect(cli.exit).resolves.toMatchObject({ code: 0 });
    expect(cli.stdout()).toContain('--quiet');
  }, 20_000);
});

describe('the built CLI with --quiet', () => {
  it('prints neither startup nor request lines, but still proxies', async () => {
    const upstream = await startUpstream();
    const port = await findFreePort();
    const cli = startCli(['--target', upstream.origin, '--port', String(port), '--quiet']);

    const response = await fetchWhenListening(`http://127.0.0.1:${port}/api/users`);

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe('upstream ok');
    expect(upstream.requests[0]?.url).toBe('/api/users');

    // Long enough that a completion line would have been written by now.
    await sleep(200);

    expect(cli.stdout()).toBe('');
    expect(cli.stderr()).toBe('');
  }, 30_000);

  it('stays silent through shutdown as well', async () => {
    const upstream = await startUpstream();
    const port = await findFreePort();
    const cli = startCli(['--target', upstream.origin, '--port', String(port), '--quiet']);

    await fetchWhenListening(`http://127.0.0.1:${port}/api/users`);
    cli.child.kill('SIGINT');

    await expect(cli.exit).resolves.toMatchObject({ code: 0, signal: null });
    expect(cli.stdout()).toBe('');
    expect(cli.stderr()).toBe('');
  }, 30_000);

  it('still reports a startup failure on stderr', async () => {
    const port = await occupyPort();
    const cli = startCli(['--target', 'http://127.0.0.1:1', '--port', String(port), '--quiet']);

    const { code } = await cli.exit;

    expect(code).toBe(1);
    expect(cli.stdout()).toBe('');
    expect(cli.stderr()).toContain(`Port ${port} is already in use`);
  }, 20_000);

  it('still reports a usage mistake on stderr', async () => {
    const cli = startCli(['--quiet']);

    const { code } = await cli.exit;

    expect(code).not.toBe(0);
    expect(cli.stdout()).toBe('');
    expect(cli.stderr()).toContain('--target');
  }, 20_000);

  it('prints no stop hint, since it prints no summary to end', async () => {
    const upstream = await startUpstream();
    const port = await findFreePort();
    const cli = startCli(['--target', upstream.origin, '--port', String(port), '--quiet']);

    await fetchWhenListening(`http://127.0.0.1:${port}/api/users`);
    await sleep(200);

    expect(cli.stdout()).not.toContain(STOP_HINT);
  }, 30_000);

  it.each([['--help'], ['--version']])(
    'still prints %s',
    async (flag) => {
      const cli = startCli(['--quiet', flag]);

      await expect(cli.exit).resolves.toMatchObject({ code: 0 });
      expect(cli.stdout().trim()).not.toBe('');
      expect(cli.stderr()).toBe('');
    },
    20_000,
  );
});

describe('the built CLI with --config', () => {
  it('serves endpoint rules from a YAML file and forwards everything else', async () => {
    const upstream = await startUpstream();
    const configPath = writeTempConfig(`target: ${upstream.origin}

rules:
  - match: /fail/*
    errorRate: 1
    errorStatus: 503
`);
    const port = await findFreePort();
    const cli = startCli(['--config', configPath, '--port', String(port)]);
    await waitForOutput(cli, 'Rules: 1');

    expect(cli.stdout()).toContain(`Config: ${configPath}`);
    expect(cli.stdout()).toContain(`Target: ${upstream.origin}`);

    const baseUrl = `http://127.0.0.1:${port}`;
    const healthy = await fetch(`${baseUrl}/healthy`);

    expect(healthy.status).toBe(200);
    await expect(healthy.text()).resolves.toBe('upstream ok');

    const failed = await fetch(`${baseUrl}/fail/test`);

    expect(failed.status).toBe(503);
    await expect(failed.text()).resolves.toBe('Chaos Proxy injected error');

    // Only the healthy request ever reached the upstream.
    expect(upstream.requests.map((request) => request.url)).toEqual(['/healthy']);

    cli.child.kill('SIGINT');
    await expect(cli.exit).resolves.toMatchObject({ code: 0, signal: null });
  }, 30_000);

  it('lets --port and a chaos flag override the config file', async () => {
    const upstream = await startUpstream();
    const configPath = writeTempConfig(`target: ${upstream.origin}

port: 1

rules:
  - match: /fail/*
    errorRate: 1
    errorStatus: 503
`);
    const port = await findFreePort();
    const cli = startCli(['--config', configPath, '--port', String(port), '--error-rate', '0']);
    await waitForOutput(cli, 'Rules: 1');

    // Port 1 from the config would never have bound, and the rule's certain
    // failure is switched off by the flag.
    expect(cli.stdout()).toContain(`http://127.0.0.1:${port}`);

    const response = await fetch(`http://127.0.0.1:${port}/fail/test`);

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe('upstream ok');

    cli.child.kill('SIGINT');
    await expect(cli.exit).resolves.toMatchObject({ code: 0 });
  }, 30_000);

  it('fails cleanly on a config file that is not there', async () => {
    const cli = startCli(['--config', join(tmpdir(), 'chaos-proxy-does-not-exist.yml')]);

    const { code } = await cli.exit;

    expect(code).toBe(1);
    expect(cli.stdout()).toBe('');
    expect(cli.stderr()).toContain('Config file not found');
    // An expected user mistake, not a crash.
    expect(cli.stderr()).not.toContain('at ');
  }, 20_000);

  it('fails cleanly on an invalid config file', async () => {
    const configPath = writeTempConfig('target: http://localhost:3000\nrules:\n  - errorRate: 1\n');
    const cli = startCli(['--config', configPath]);

    const { code } = await cli.exit;

    expect(code).toBe(1);
    expect(cli.stdout()).toBe('');
    expect(cli.stderr()).toContain('rules[0] is missing the required "match" field');
    expect(cli.stderr()).not.toContain('at ');
  }, 20_000);
});

/**
 * The outcome of every completed request the CLI has logged, in order.
 *
 * The log line is the only place a built CLI says what it did with a request,
 * and its outcome word is the part these tests care about — the timestamp and
 * the duration are real and stay unpinned.
 */
function loggedOutcomes(cli: CliProcess): string[] {
  // `RESET` stands where a status would be for a connection the proxy dropped:
  // that request never received one, so there is no number to match on.
  return [...cli.stdout().matchAll(/-> (?:\d{3}|RESET) \d+ms (\S+)/g)].map(
    (match) => match[1] ?? '',
  );
}

/** Waits until the CLI has logged `count` completed requests. */
async function waitForOutcomes(cli: CliProcess, count: number): Promise<void> {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;

  while (loggedOutcomes(cli).length < count) {
    if (Date.now() > deadline) {
      throw new Error(
        `timed out waiting for ${count} completions.\nstdout: ${cli.stdout()}\nstderr: ${cli.stderr()}`,
      );
    }

    await sleep(20);
  }
}

/** Chaos rates used by every seeded run below, so only the seed ever differs. */
const SEEDED_CHAOS = [
  '--error-rate',
  '0.5',
  '--timeout-rate',
  '0.25',
  // Short, so a run that does time out a request costs the suite nothing. It
  // does not affect which requests are selected.
  '--timeout',
  '50',
] as const;

/** Starts the built CLI with a seed and waits for it to announce that seed. */
async function startSeededCli(
  target: string,
  seed: string,
): Promise<{ cli: CliProcess; baseUrl: string }> {
  const port = await findFreePort();
  const cli = startCli([
    '--target',
    target,
    '--port',
    String(port),
    ...SEEDED_CHAOS,
    '--seed',
    seed,
  ]);
  await waitForOutput(cli, `Seed: ${seed}`);

  return { cli, baseUrl: `http://127.0.0.1:${port}` };
}

/** What one seeded run did: the statuses the client saw and the logged fates. */
interface SeededRun {
  readonly statuses: number[];
  readonly outcomes: string[];
}

/**
 * Drives one seeded CLI through `count` requests, sent strictly one at a time.
 *
 * Ordering is the condition on the whole promise, so these are deliberately
 * sequential: each request is answered and reported before the next is sent.
 */
async function runSeeded(target: string, seed: string, count: number): Promise<SeededRun> {
  const { cli, baseUrl } = await startSeededCli(target, seed);
  const statuses: number[] = [];

  for (let index = 0; index < count; index += 1) {
    const response = await fetch(`${baseUrl}/api/item/${index}`);
    await response.text();
    statuses.push(response.status);
    await waitForOutcomes(cli, index + 1);
  }

  const outcomes = loggedOutcomes(cli);

  cli.child.kill('SIGINT');
  await cli.exit;

  return { statuses, outcomes };
}

describe('the built CLI with --seed', () => {
  it('documents --seed in its help', async () => {
    const cli = startCli(['--help']);

    await expect(cli.exit).resolves.toMatchObject({ code: 0 });
    expect(cli.stdout()).toContain('--seed <value>');
    expect(cli.stdout()).toContain('Deterministic chaos decisions');
  }, 20_000);

  it('announces the seed it was given', async () => {
    const upstream = await startUpstream();
    const { cli } = await startSeededCli(upstream.origin, 'checkout-test');

    expect(cli.stdout()).toContain('Seed: checkout-test');
  }, 30_000);

  it('replays the same outcomes across two separate runs', async () => {
    const upstream = await startUpstream();

    const first = await runSeeded(upstream.origin, 'checkout-test', 6);
    const second = await runSeeded(upstream.origin, 'checkout-test', 6);

    expect(first.statuses).toEqual(second.statuses);
    expect(first.outcomes).toEqual(second.outcomes);

    // Pinned from the generator, so this is a promise about which requests
    // fail rather than only about two runs agreeing with each other. The reset
    // decision draws first even at a rate of 0, so these are not the values
    // this seed produced before connection resets existed.
    expect(first.statuses).toEqual([500, 200, 504, 504, 500, 200]);
    expect(first.outcomes).toEqual([
      'injected:error',
      'forwarded',
      'injected:timeout',
      'injected:timeout',
      'injected:error',
      'forwarded',
    ]);
  }, 60_000);

  it('produces different outcomes for a different seed', async () => {
    const upstream = await startUpstream();

    const checkout = await runSeeded(upstream.origin, 'checkout-test', 6);
    const other = await runSeeded(upstream.origin, 'other-seed', 6);

    expect(checkout.statuses).not.toEqual(other.statuses);
    expect(other.statuses).toEqual([500, 200, 200, 500, 500, 504]);
  }, 60_000);

  it('rejects an empty seed rather than running unseeded', async () => {
    const cli = startCli(['--target', 'http://127.0.0.1:1', '--seed', '']);

    const { code } = await cli.exit;

    expect(code).toBe(1);
    expect(cli.stdout()).toBe('');
    expect(cli.stderr()).toContain('--seed');
    // An expected user mistake, not a crash.
    expect(cli.stderr()).not.toContain('at ');
  }, 20_000);

  it('says nothing about seeding when no seed was given', async () => {
    const upstream = await startUpstream();
    const { cli, baseUrl } = await startProxyCli(upstream.origin, ['--error-rate', '0.5']);

    const response = await fetch(`${baseUrl}/api/users`);
    await response.text();
    await waitForOutcomes(cli, 1);

    expect(cli.stdout()).not.toContain('Seed');
    expect(cli.stderr()).toBe('');
  }, 30_000);

  it('suppresses the seed line under --quiet, while still seeding the run', async () => {
    const upstream = await startUpstream();
    const port = await findFreePort();
    const cli = startCli([
      '--target',
      upstream.origin,
      '--port',
      String(port),
      ...SEEDED_CHAOS,
      '--seed',
      'checkout-test',
      '--quiet',
    ]);

    const statuses: number[] = [];
    const first = await fetchWhenListening(`http://127.0.0.1:${port}/api/item/0`);
    await first.text();
    statuses.push(first.status);

    for (let index = 1; index < 6; index += 1) {
      const response = await fetch(`http://127.0.0.1:${port}/api/item/${index}`);
      await response.text();
      statuses.push(response.status);
    }

    // The same sequence the announced run produced, from a run that announced
    // nothing at all.
    expect(statuses).toEqual([500, 200, 504, 504, 500, 200]);
    expect(cli.stdout()).toBe('');
    expect(cli.stderr()).toBe('');
  }, 30_000);
});

/**
 * Starts the built CLI with a preset and waits for it to announce that preset.
 *
 * The startup line is the readiness signal as well as the thing under test:
 * a preset that was accepted but never reported would leave nothing to wait on.
 */
async function startPresetCli(
  target: string,
  preset: string,
  extraArgs: readonly string[] = [],
): Promise<{ cli: CliProcess; baseUrl: string }> {
  const port = await findFreePort();
  const cli = startCli([
    '--target',
    target,
    '--port',
    String(port),
    '--preset',
    preset,
    ...extraArgs,
  ]);
  // The stop hint is the last line of the summary, so waiting for it means the
  // whole summary has arrived and a test can assert on any line of it.
  await waitForOutput(cli, STOP_HINT);
  expect(cli.stdout()).toContain(`Preset: ${preset}`);

  return { cli, baseUrl: `http://127.0.0.1:${port}` };
}

describe('the built CLI with --preset', () => {
  it('documents the option and every preset in its help', async () => {
    const cli = startCli(['--help']);

    await expect(cli.exit).resolves.toMatchObject({ code: 0 });

    const help = cli.stdout();

    expect(help).toContain('--preset <name>');
    expect(help).toContain('Presets:');
    expect(help).toContain('slow-api');
    expect(help).toContain('flaky-api');
    expect(help).toContain('timeout-heavy');
    expect(help).toContain('backend-down');
    expect(cli.stderr()).toBe('');
  }, 20_000);

  it('refuses an unknown preset and never listens', async () => {
    const cli = startCli(['--target', 'http://127.0.0.1:1', '--preset', 'terrible-network']);

    const { code } = await cli.exit;

    expect(code).not.toBe(0);
    expect(cli.stdout()).toBe('');
    expect(cli.stderr()).toContain('chaos-proxy: Unknown preset "terrible-network".');
    expect(cli.stderr()).toContain(
      'Available presets: slow-api, flaky-api, timeout-heavy, backend-down.',
    );
    // An expected user mistake, not a crash.
    expect(cli.stderr()).not.toContain('at ');
  }, 20_000);

  // One process-level check that a preset really does reach the forwarding
  // path; which numbers each preset stands for is settled at the resolver, so
  // the rest of them cost the suite nothing.
  it('slows every request down under slow-api', async () => {
    const upstream = await startUpstream();
    const { cli, baseUrl } = await startPresetCli(upstream.origin, 'slow-api');

    // Waited for rather than read straight off, because startup lines can
    // arrive in separate chunks and this one comes after the preset line.
    await waitForOutput(cli, 'Latency: 1000ms');

    const startedAt = performance.now();
    const response = await fetch(`${baseUrl}/api/users`);
    const elapsed = performance.now() - startedAt;

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe('upstream ok');
    // Lower bound only, with slack for timer coarseness and loaded runners.
    expect(elapsed).toBeGreaterThanOrEqual(800);
  }, 30_000);

  it('fails every request without touching the upstream under backend-down', async () => {
    const upstream = await startUpstream();
    const { cli, baseUrl } = await startPresetCli(upstream.origin, 'backend-down');

    expect(cli.stdout()).toContain('Error injection: 100% -> 503');

    for (const path of ['/api/users', '/api/payments/123']) {
      const response = await fetch(`${baseUrl}${path}`);

      expect(response.status).toBe(503);
      await expect(response.text()).resolves.toBe('Chaos Proxy injected error');
    }

    // The preset is a synthetic failure, not an unreachable target: the
    // upstream is up and running and simply never hears from the proxy.
    expect(upstream.requests).toHaveLength(0);

    await waitForOutcomes(cli, 2);
    expect(loggedOutcomes(cli)).toEqual(['injected:error', 'injected:error']);

    cli.child.kill('SIGINT');
    await expect(cli.exit).resolves.toMatchObject({ code: 0, signal: null });
    expect(cli.stdout()).toContain('shutting down');
  }, 30_000);

  it('reports the effective chaos rather than the preset definition when a flag overrides it', async () => {
    const upstream = await startUpstream();
    const { cli, baseUrl } = await startPresetCli(upstream.origin, 'flaky-api', [
      '--error-rate',
      '0',
    ]);

    // Named as asked for, but no claim about failures that cannot happen.
    expect(cli.stdout()).toContain('Preset: flaky-api');
    expect(cli.stdout()).not.toContain('Error injection');

    const response = await fetch(`${baseUrl}/api/users`);

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe('upstream ok');
  }, 30_000);

  it('says nothing about a preset when none was given', async () => {
    const upstream = await startUpstream();
    const { cli } = await startProxyCli(upstream.origin);

    expect(cli.stdout()).not.toContain('Preset');
  }, 30_000);

  it('suppresses the preset line under --quiet, while still applying it', async () => {
    const upstream = await startUpstream();
    const port = await findFreePort();
    const cli = startCli([
      '--target',
      upstream.origin,
      '--port',
      String(port),
      '--preset',
      'backend-down',
      '--quiet',
    ]);

    const response = await fetchWhenListening(`http://127.0.0.1:${port}/api/users`);

    expect(response.status).toBe(503);
    await expect(response.text()).resolves.toBe('Chaos Proxy injected error');
    expect(upstream.requests).toHaveLength(0);

    // Long enough that a startup or completion line would have been written.
    await sleep(200);

    expect(cli.stdout()).toBe('');
    expect(cli.stderr()).toBe('');
  }, 30_000);
});

/**
 * Seed for the preset run below, chosen so that the preset's 25% actually
 * selects some of six requests and the pinned sequence says something.
 */
const PRESET_SEED = 'flaky-test';

/** Drives one preset-and-seed run through `count` requests, one at a time. */
async function runSeededPreset(target: string, count: number): Promise<SeededRun> {
  const { cli, baseUrl } = await startPresetCli(target, 'flaky-api', ['--seed', PRESET_SEED]);
  const statuses: number[] = [];

  for (let index = 0; index < count; index += 1) {
    const response = await fetch(`${baseUrl}/api/item/${index}`);
    await response.text();
    statuses.push(response.status);
    await waitForOutcomes(cli, index + 1);
  }

  const outcomes = loggedOutcomes(cli);

  cli.child.kill('SIGINT');
  await cli.exit;

  return { statuses, outcomes };
}

describe('the built CLI with --preset and --seed', () => {
  // A preset is configuration and nothing more, so a seeded run stays exactly
  // as reproducible as it is without one. There is no preset-specific seed.
  it('replays the same outcomes across two separate runs', async () => {
    const upstream = await startUpstream();

    const first = await runSeededPreset(upstream.origin, 6);
    const second = await runSeededPreset(upstream.origin, 6);

    expect(first.outcomes).toEqual(second.outcomes);
    expect(first.statuses).toEqual(second.statuses);

    // Pinned, so this promises which requests the preset's 25% failed rather
    // than only that two runs agreed with each other.
    expect(first.outcomes).toEqual([
      'forwarded',
      'injected:error',
      'forwarded',
      'injected:error',
      'injected:error',
      'forwarded',
    ]);
    expect(first.statuses).toEqual([200, 503, 200, 503, 503, 200]);
  }, 60_000);
});

describe('the built CLI with --reset-rate', () => {
  it('documents the option in its help', async () => {
    const cli = startCli(['--help']);

    await expect(cli.exit).resolves.toMatchObject({ code: 0 });
    expect(cli.stdout()).toContain('--reset-rate <0-1>');
    expect(cli.stdout()).toContain('Probability of abruptly resetting the connection');
  }, 20_000);

  it('refuses a rate outside 0-1 and never listens', async () => {
    const port = await findFreePort();
    const cli = startCli([
      '--target',
      'http://localhost:3000',
      '--port',
      String(port),
      '--reset-rate',
      '5',
    ]);

    const { code } = await cli.exit;

    expect(code).toBe(1);
    expect(cli.stdout()).toBe('');
    expect(cli.stderr()).toContain('Invalid --reset-rate 5');
    expect(cli.stderr()).not.toContain('at ');
  }, 20_000);

  it('announces the rate at startup only when resets are actually switched on', async () => {
    const upstream = await startUpstream();
    const { cli } = await startProxyCli(
      upstream.origin,
      ['--reset-rate', '0.25'],
      'Connection resets: 25%',
    );

    expect(cli.stdout()).toContain('Connection resets: 25%');

    const quiet = await startProxyCli(upstream.origin, ['--reset-rate', '0']);

    expect(quiet.cli.stdout()).not.toContain('Connection resets');

    const none = await startProxyCli(upstream.origin);

    expect(none.cli.stdout()).not.toContain('Connection resets');
  }, 40_000);

  it('drops the client connection without contacting the upstream, and keeps running', async () => {
    const upstream = await startUpstream();
    const { cli, baseUrl } = await startProxyCli(
      upstream.origin,
      ['--reset-rate', '1'],
      'Connection resets: 100%',
    );

    const result = await attempt(`${baseUrl}/api/users`);

    // A transport failure rather than an HTTP response: no status reached the
    // client at all, injected or otherwise.
    expect(result.failed).toBe(true);
    expect(result.statusCode).toBeUndefined();

    await waitForOutcomes(cli, 1);

    // Exactly one line, and it says what actually happened.
    expect(loggedOutcomes(cli)).toEqual(['connection:reset']);
    expect(cli.stdout()).toMatch(/GET\s+\/api\/users -> RESET \d+ms connection:reset/);
    expect(cli.stdout()).not.toContain('-> 502');
    expect(cli.stdout()).not.toContain('-> 500');

    // The upstream was never dialled, let alone sent a request. The wait is
    // what makes that an assertion rather than a race with the dial.
    await sleep(100);
    expect(upstream.requests).toHaveLength(0);
    expect(upstream.connectionCount()).toBe(0);

    // A second request proves the process survived destroying a socket.
    const again = await attempt(`${baseUrl}/api/users`);
    expect(again.failed).toBe(true);
    await waitForOutcomes(cli, 2);
    expect(loggedOutcomes(cli)).toEqual(['connection:reset', 'connection:reset']);

    // And it still shuts down cleanly.
    cli.child.kill('SIGINT');
    await expect(cli.exit).resolves.toMatchObject({ code: 0, signal: null });
    expect(cli.stderr()).toBe('');
  }, 40_000);

  it('leaves forwarding untouched at a rate of 0', async () => {
    const upstream = await startUpstream();
    const { cli, baseUrl } = await startProxyCli(upstream.origin, ['--reset-rate', '0']);

    const response = await fetch(`${baseUrl}/api/users`);

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe('upstream ok');
    expect(upstream.requests.map((request) => request.url)).toEqual(['/api/users']);

    cli.child.kill('SIGINT');
    await expect(cli.exit).resolves.toMatchObject({ code: 0 });
  }, 30_000);
});

describe('the built CLI with a resetRate rule', () => {
  it('resets the paths a rule names and forwards everything else', async () => {
    const upstream = await startUpstream();
    const configPath = writeTempConfig(`target: ${upstream.origin}

rules:
  - match: /reset/*
    resetRate: 1
`);
    const port = await findFreePort();
    const cli = startCli(['--config', configPath, '--port', String(port)]);
    await waitForOutput(cli, 'Rules: 1');

    const baseUrl = `http://127.0.0.1:${port}`;
    const healthy = await fetch(`${baseUrl}/healthy`);

    expect(healthy.status).toBe(200);
    await expect(healthy.text()).resolves.toBe('upstream ok');

    const reset = await attempt(`${baseUrl}/reset/test`);

    expect(reset.failed).toBe(true);
    expect(reset.statusCode).toBeUndefined();

    await waitForOutcomes(cli, 2);
    expect(loggedOutcomes(cli)).toEqual(['forwarded', 'connection:reset']);

    // Only the healthy request ever reached the upstream. A per-rule reset is
    // not summarised at startup, so nothing there mentions one either.
    expect(upstream.requests.map((request) => request.url)).toEqual(['/healthy']);
    expect(cli.stdout()).not.toContain('Connection resets');

    cli.child.kill('SIGINT');
    await expect(cli.exit).resolves.toMatchObject({ code: 0, signal: null });
  }, 30_000);

  it('lets --reset-rate 0 switch off a config file that resets everything', async () => {
    const upstream = await startUpstream();
    const configPath = writeTempConfig(`target: ${upstream.origin}

defaults:
  resetRate: 1
`);
    const port = await findFreePort();
    const cli = startCli(['--config', configPath, '--port', String(port), '--reset-rate', '0']);
    await waitForOutput(cli, `Config: ${configPath}`);

    // The flag typed on the spot is the final word, so nothing is reset and
    // startup says nothing about resets either.
    expect(cli.stdout()).not.toContain('Connection resets');

    const response = await fetch(`http://127.0.0.1:${port}/api/users`);

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe('upstream ok');

    cli.child.kill('SIGINT');
    await expect(cli.exit).resolves.toMatchObject({ code: 0 });
  }, 30_000);
});

/**
 * The conventional config file and `--print-config`, driven as real processes.
 *
 * Both are about where the command was run from and what it wrote to stdout,
 * which is exactly what an in-process test cannot show: every one of these runs
 * the compiled CLI in a scratch directory of its own.
 */
describe('the built CLI config discovery', () => {
  const CONFIG = `target: http://127.0.0.1:1

defaults:
  latencyMs: 250
`;

  it('loads ./chaos.yml without being asked to', async () => {
    const dir = makeTempDir();
    const path = writeConfigIn(dir, 'chaos.yml', CONFIG);
    const cli = startCli(['--print-config'], dir);

    await expect(cli.exit).resolves.toMatchObject({ code: 0 });
    expect(cli.stdout()).toContain(`config: ${realpathSync(path)}`);
    expect(cli.stdout()).toContain('latencyMs: 250');
  }, 20_000);

  it('says nothing about a config file when there is none', async () => {
    const cli = startCli(['--target', 'http://127.0.0.1:1', '--print-config'], makeTempDir());

    await expect(cli.exit).resolves.toMatchObject({ code: 0 });
    expect(cli.stdout()).toContain('config: null');
    expect(cli.stdout()).not.toContain('Config: none');
    expect(cli.stderr()).toBe('');
  }, 20_000);

  it('lets an explicit --config beat the conventional file', async () => {
    const dir = makeTempDir();
    writeConfigIn(dir, 'chaos.yml', 'target: http://127.0.0.1:1\ndefaults:\n  latencyMs: 250\n');
    const other = writeConfigIn(
      dir,
      'other.yml',
      'target: http://127.0.0.1:2\ndefaults:\n  latencyMs: 999\n',
    );
    const cli = startCli(['--config', 'other.yml', '--print-config'], dir);

    await expect(cli.exit).resolves.toMatchObject({ code: 0 });
    expect(cli.stdout()).toContain(`config: ${realpathSync(other)}`);
    expect(cli.stdout()).toContain('latencyMs: 999');
    expect(cli.stdout()).toContain('target: http://127.0.0.1:2');
  }, 20_000);

  // Explicit intent wins even when it is wrong: falling back here would run a
  // configuration nobody asked for and call it success.
  it('fails on an explicit missing --config even with a chaos.yml right there', async () => {
    const dir = makeTempDir();
    writeConfigIn(dir, 'chaos.yml', CONFIG);
    const cli = startCli(['--config', './missing.yml', '--print-config'], dir);

    const { code } = await cli.exit;

    expect(code).toBe(1);
    expect(cli.stdout()).toBe('');
    expect(cli.stderr()).toContain('Config file not found');
    expect(cli.stderr()).toContain('missing.yml');
    expect(cli.stderr()).not.toContain('at ');
  }, 20_000);

  it('names the discovered file in its startup summary, and serves it', async () => {
    const upstream = await startUpstream();
    const dir = makeTempDir();
    const path = writeConfigIn(
      dir,
      'chaos.yml',
      `target: ${upstream.origin}\n\nrules:\n  - match: /fail/*\n    errorRate: 1\n    errorStatus: 503\n`,
    );
    const port = await findFreePort();
    const cli = startCli(['--port', String(port)], dir);

    await waitForOutput(cli, 'Rules: 1');

    expect(cli.stdout()).toContain(`Config: ${realpathSync(path)}`);

    const failed = await fetch(`http://127.0.0.1:${port}/fail/now`);
    const forwarded = await fetch(`http://127.0.0.1:${port}/ok`);

    expect(failed.status).toBe(503);
    expect(forwarded.status).toBe(200);

    cli.child.kill('SIGINT');
    await expect(cli.exit).resolves.toMatchObject({ code: 0 });
  }, 30_000);

  it('reports a broken conventional file against the path it found', async () => {
    const dir = makeTempDir();
    const path = writeConfigIn(dir, 'chaos.yml', 'target: http://127.0.0.1:1\nlogging: debug\n');
    const cli = startCli([], dir);

    const { code } = await cli.exit;

    expect(code).toBe(1);
    expect(cli.stdout()).toBe('');
    expect(cli.stderr()).toContain(`Invalid config in ${realpathSync(path)}`);
    expect(cli.stderr()).toContain('unknown field "logging"');
    expect(cli.stderr()).not.toContain('at ');
  }, 20_000);
});

describe('the built CLI with --print-config', () => {
  it('documents the option in its help', async () => {
    const cli = startCli(['--help']);

    await expect(cli.exit).resolves.toMatchObject({ code: 0 });
    expect(cli.stdout()).toContain('--print-config');
    expect(cli.stdout()).toContain('./chaos.yml');
  }, 20_000);

  it('prints clean YAML, exits 0, and never listens or contacts the upstream', async () => {
    const upstream = await startUpstream();
    const dir = makeTempDir();
    writeConfigIn(
      dir,
      'chaos.yml',
      `target: ${upstream.origin}\n\ndefaults:\n  latencyMs: 100\n\nrules:\n  - match: /api/payments/*\n    errorRate: 1\n    errorStatus: 503\n`,
    );
    const port = await findFreePort();
    const cli = startCli(['--port', String(port), '--print-config'], dir);

    await expect(cli.exit).resolves.toMatchObject({ code: 0 });
    expect(cli.stderr()).toBe('');

    // Parses as YAML on its own, with no summary line wrapped around it.
    const document = parseYaml(cli.stdout()) as Record<string, unknown>;

    expect(document).toMatchObject({
      target: upstream.origin,
      port,
      preset: null,
      seed: null,
      defaults: { latencyMs: 100, errorRate: 0, errorStatus: 500, resetRate: 0 },
      rules: [{ match: '/api/payments/*', latencyMs: 100, errorRate: 1, errorStatus: 503 }],
    });
    expect(cli.stdout()).not.toContain('listening on');

    // Nothing was started: the port it named is still free to bind, and the
    // upstream never saw a connection.
    await expect(attempt(`http://127.0.0.1:${port}/`)).resolves.toMatchObject({ failed: true });
    expect(upstream.connectionCount()).toBe(0);
    expect(upstream.requests).toHaveLength(0);
  }, 30_000);

  it('still prints under --quiet', async () => {
    const dir = makeTempDir();
    writeConfigIn(dir, 'chaos.yml', 'target: http://127.0.0.1:1\n');
    const quiet = startCli(['--quiet', '--print-config'], dir);

    await expect(quiet.exit).resolves.toMatchObject({ code: 0 });
    expect(quiet.stdout()).toContain('target: http://127.0.0.1:1');

    const loud = startCli(['--print-config'], dir);
    await loud.exit;

    expect(quiet.stdout()).toBe(loud.stdout());
  }, 30_000);

  it('prints the same text every run', async () => {
    const dir = makeTempDir();
    writeConfigIn(
      dir,
      'chaos.yml',
      'target: http://127.0.0.1:1\n\nrules:\n  - match: /a/*\n    resetRate: 0.5\n',
    );
    const args = ['--preset', 'flaky-api', '--seed', 'checkout-test', '--print-config'];
    const runs = [startCli(args, dir), startCli(args, dir), startCli(args, dir)];

    await Promise.all(runs.map((run) => run.exit));

    expect(new Set(runs.map((run) => run.stdout())).size).toBe(1);
    expect(runs[0]?.stdout()).toContain('seed: checkout-test');
    expect(runs[0]?.stdout()).toContain('preset: flaky-api');
  }, 30_000);

  it('fails with the ordinary missing-target error when nothing supplies one', async () => {
    const cli = startCli(['--print-config'], makeTempDir());

    const { code } = await cli.exit;

    expect(code).not.toBe(0);
    expect(cli.stdout()).toBe('');
    expect(cli.stderr()).toContain('--target');
  }, 20_000);
});
