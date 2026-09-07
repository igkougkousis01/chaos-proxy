import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';

import { runCli } from '../../src/cli/program.js';
import type { CliIo } from '../../src/cli/program.js';

/** Everything the CLI wrote, kept apart by stream. */
interface CapturedIo extends CliIo {
  readonly stdout: string[];
  readonly stderr: string[];
}

function captureIo(): CapturedIo {
  const stdout: string[] = [];
  const stderr: string[] = [];

  return {
    stdout,
    stderr,
    out: (text) => {
      stdout.push(text);
    },
    err: (text) => {
      stderr.push(text);
    },
  };
}

const openServers = new Set<Server>();

afterEach(async () => {
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
});

/** The TCP address a test server is listening on. */
function addressOf(server: Server): AddressInfo {
  const address = server.address();

  if (address === null || typeof address === 'string') {
    throw new Error('expected the server to be listening on a TCP port');
  }

  return address;
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

function packageVersion(): string {
  const manifest: unknown = JSON.parse(
    readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
  );

  if (typeof manifest !== 'object' || manifest === null || !('version' in manifest)) {
    throw new Error('package.json has no version');
  }

  return String(manifest.version);
}

describe('runCli --help', () => {
  it('prints usage and succeeds', async () => {
    const io = captureIo();

    await expect(runCli(['--help'], io)).resolves.toBe(0);

    const help = io.stdout.join('\n');
    expect(io.stderr).toEqual([]);
    expect(help).toContain('chaos-proxy --target <url> [options]');
    expect(help).toContain('Examples:');
    expect(help).toContain('chaos-proxy --target http://localhost:3000');
  });

  it.each([
    '--target',
    '--port',
    '--latency',
    '--error-rate',
    '--error-status',
    '--timeout-rate',
    '--timeout',
    '--help',
    '--version',
  ])('documents %s', async (flag) => {
    const io = captureIo();

    await runCli(['--help'], io);

    expect(io.stdout.join('\n')).toContain(flag);
  });

  it('states the default port and that it binds to loopback only', async () => {
    const io = captureIo();

    await runCli(['--help'], io);

    const help = io.stdout.join('\n');
    expect(help).toContain('Default: 4000');
    expect(help).toContain('127.0.0.1');
  });
});

describe('runCli --version', () => {
  it('prints the package version', async () => {
    const io = captureIo();

    await expect(runCli(['--version'], io)).resolves.toBe(0);

    expect(io.stdout).toEqual([packageVersion()]);
  });
});

describe('runCli usage errors', () => {
  it('refuses to start without a target', async () => {
    const io = captureIo();

    await expect(runCli([], io)).resolves.toBe(1);

    expect(io.stdout).toEqual([]);
    expect(io.stderr.join('\n')).toContain('--target');
    expect(io.stderr.join('\n')).toContain('--help');
  });

  it.each(['0', '65536', 'abc', '4000.5'])('refuses to start on a port of %j', async (port) => {
    const io = captureIo();

    await expect(runCli(['--target', 'http://127.0.0.1:1', '--port', port], io)).resolves.toBe(1);

    expect(io.stdout).toEqual([]);
    expect(io.stderr.join('\n')).toContain('--port');
  });

  it('refuses an unknown flag', async () => {
    const io = captureIo();

    await expect(runCli(['--target', 'http://127.0.0.1:1', '--chaos', '11'], io)).resolves.toBe(1);

    expect(io.stderr.join('\n')).toContain('--chaos');
  });

  it('reports a target the proxy core rejects, without starting', async () => {
    const io = captureIo();

    await expect(runCli(['--target', 'localhost:3000'], io)).resolves.toBe(1);

    expect(io.stdout).toEqual([]);
    expect(io.stderr.join('\n')).toContain('localhost:3000');
  });

  it.each([
    [['--error-rate', '5'], '--error-rate'],
    [['--timeout-rate', '5'], '--timeout-rate'],
    [['--error-status', '200'], '--error-status'],
    [['--latency=-1'], '--latency'],
  ])('reports %j in terms of the flag that carried it', async (args, flag) => {
    const io = captureIo();

    await expect(runCli(['--target', 'http://127.0.0.1:1', ...args], io)).resolves.toBe(1);

    expect(io.stdout).toEqual([]);
    expect(io.stderr[0]).toContain(flag);
  });
});

describe('runCli startup failures', () => {
  it('reports a port that is already in use instead of throwing', async () => {
    const port = await occupyPort();
    const io = captureIo();

    await expect(
      runCli(['--target', 'http://127.0.0.1:1', '--port', String(port)], io),
    ).resolves.toBe(1);

    expect(io.stdout).toEqual([]);
    expect(io.stderr.join('\n')).toContain(`port ${port} is already in use`);
  });
});
