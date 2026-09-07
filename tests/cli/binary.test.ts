import { execFile, spawn } from 'node:child_process';
import type { ChildProcessByStdio } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

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

/** Writes a config file that is removed after the test that made it. */
function writeTempConfig(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'chaos-proxy-cli-'));
  tempDirs.push(dir);
  const path = join(dir, 'chaos.yml');
  writeFileSync(path, contents, 'utf8');

  return path;
}

/** Spawns the built CLI, capturing both streams. */
function startCli(args: readonly string[]): CliProcess {
  const child = spawn(process.execPath, [cliPath, ...args], {
    cwd: repoRoot,
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
): Promise<{ origin: string; requests: IncomingMessage[] }> {
  const requests: IncomingMessage[] = [];
  const server = createServer((req, res) => {
    requests.push(req);
    handler(req, res);
  });
  openServers.add(server);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  return { origin: `http://127.0.0.1:${addressOf(server).port}`, requests };
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
 * Startup lines can arrive in separate chunks, so callers wait for the last
 * line they care about rather than for the first one.
 */
async function startProxyCli(
  target: string,
  chaosArgs: readonly string[] = [],
  readyText = `Target: ${target}`,
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
    expect(cli.stderr()).toContain(`port ${port} is already in use`);
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
      'Timeout injection: 100% -> 50ms',
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
    expect(cli.stderr()).toContain(`port ${port} is already in use`);
  }, 20_000);

  it('still reports a usage mistake on stderr', async () => {
    const cli = startCli(['--quiet']);

    const { code } = await cli.exit;

    expect(code).not.toBe(0);
    expect(cli.stdout()).toBe('');
    expect(cli.stderr()).toContain('--target');
  }, 20_000);
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
  return [...cli.stdout().matchAll(/-> \d{3} \d+ms (\S+)/g)].map((match) => match[1] ?? '');
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
    expect(cli.stdout()).toContain('Use deterministic chaos decisions for reproducible');
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
    // fail rather than only about two runs agreeing with each other.
    expect(first.statuses).toEqual([200, 200, 200, 500, 500, 500]);
    expect(first.outcomes).toEqual([
      'forwarded',
      'forwarded',
      'forwarded',
      'injected:error',
      'injected:error',
      'injected:error',
    ]);
  }, 60_000);

  it('produces different outcomes for a different seed', async () => {
    const upstream = await startUpstream();

    const checkout = await runSeeded(upstream.origin, 'checkout-test', 6);
    const other = await runSeeded(upstream.origin, 'other-seed', 6);

    expect(checkout.statuses).not.toEqual(other.statuses);
    expect(other.statuses).toEqual([500, 200, 200, 504, 200, 504]);
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
    expect(statuses).toEqual([200, 200, 200, 500, 500, 500]);
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
  await waitForOutput(cli, `Preset: ${preset}`);

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
    expect(cli.stderr()).toContain('Unknown preset "terrible-network"');
    expect(cli.stderr()).toContain('slow-api, flaky-api, timeout-heavy, backend-down');
    // An expected user mistake, not a crash.
    expect(cli.stderr()).not.toContain('at ');
  }, 20_000);

  // One process-level check that a preset really does reach the forwarding
  // path; which numbers each preset stands for is settled at the resolver, so
  // the rest of them cost the suite nothing.
  it('slows every request down under slow-api', async () => {
    const upstream = await startUpstream();
    const { cli, baseUrl } = await startPresetCli(upstream.origin, 'slow-api');

    expect(cli.stdout()).toContain('Latency: 1000ms');

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

/** Drives one preset-and-seed run through `count` requests, one at a time. */
async function runSeededPreset(target: string, count: number): Promise<SeededRun> {
  const { cli, baseUrl } = await startPresetCli(target, 'flaky-api', ['--seed', 'checkout-test']);
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
      'forwarded',
      'forwarded',
      'injected:error',
      'injected:error',
      'forwarded',
    ]);
    expect(first.statuses).toEqual([200, 200, 200, 503, 503, 200]);
  }, 60_000);
});
