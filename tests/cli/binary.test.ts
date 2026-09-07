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

/** Waits for `text` to appear on the CLI's stdout, or fails with what it saw. */
function waitForOutput(cli: CliProcess, text: string): Promise<void> {
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
      return cli.stdout().includes(text);
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
      finish(describe(`timed out waiting for ${JSON.stringify(text)}.`));
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
