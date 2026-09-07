import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
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
const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();

    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
  }

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
    '--quiet',
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

describe('runCli --reset-rate', () => {
  it('offers it in the help, next to the other chaos flags', async () => {
    const io = captureIo();

    await expect(runCli(['--help'], io)).resolves.toBe(0);

    const help = io.stdout.join('\n');
    expect(help).toContain('--reset-rate <0-1>');
    expect(help).toContain('Probability of abruptly resetting the client');
  });

  it('reports a rate the proxy core rejects in terms of the flag, without starting', async () => {
    const io = captureIo();

    await expect(
      runCli(['--target', 'http://localhost:3000', '--reset-rate', '5'], io),
    ).resolves.toBe(1);

    expect(io.stdout).toEqual([]);
    expect(io.stderr[0]).toContain('Invalid --reset-rate 5');
  });

  it('reports a rate that is not a number as a usage mistake', async () => {
    const io = captureIo();

    await expect(
      runCli(['--target', 'http://localhost:3000', '--reset-rate', 'often'], io),
    ).resolves.toBe(1);

    expect(io.stderr[0]).toContain('--reset-rate');
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

  it('still reports one on stderr under --quiet', async () => {
    const port = await occupyPort();
    const io = captureIo();

    await expect(
      runCli(['--target', 'http://127.0.0.1:1', '--port', String(port), '--quiet'], io),
    ).resolves.toBe(1);

    // --quiet drops what the CLI would volunteer, never what it has to report.
    expect(io.stdout).toEqual([]);
    expect(io.stderr.join('\n')).toContain(`port ${port} is already in use`);
  });
});

describe('runCli --quiet', () => {
  it('does not suppress --help', async () => {
    const io = captureIo();

    await expect(runCli(['--quiet', '--help'], io)).resolves.toBe(0);

    expect(io.stdout.join('\n')).toContain('chaos-proxy --target <url> [options]');
  });

  it('does not suppress --version', async () => {
    const io = captureIo();

    await expect(runCli(['--quiet', '--version'], io)).resolves.toBe(0);

    expect(io.stdout).toEqual([packageVersion()]);
  });

  it('does not suppress a usage mistake', async () => {
    const io = captureIo();

    await expect(runCli(['--quiet'], io)).resolves.toBe(1);

    expect(io.stdout).toEqual([]);
    expect(io.stderr.join('\n')).toContain('--target');
  });
});

describe('runCli --seed', () => {
  it('reports an empty seed as a usage mistake', async () => {
    const io = captureIo();

    await expect(runCli(['--target', 'http://127.0.0.1:1', '--seed', ''], io)).resolves.toBe(1);

    expect(io.stdout).toEqual([]);
    expect(io.stderr.join('\n')).toContain('--seed');
    expect(io.stderr.join('\n')).toContain('Run `chaos-proxy --help` for usage.');
  });

  it('offers it in the help, as a reproducibility control rather than chaos', async () => {
    const io = captureIo();

    await expect(runCli(['--help'], io)).resolves.toBe(0);

    const help = io.stdout.join('\n');

    expect(help).toContain('--seed <value>');
    expect(help).toContain('Use deterministic chaos decisions for reproducible');
    expect(help).toContain('--seed checkout-test');
  });
});

describe('runCli --preset', () => {
  it('refuses an unknown preset without starting, naming the ones that exist', async () => {
    const io = captureIo();

    await expect(
      runCli(['--target', 'http://127.0.0.1:1', '--preset', 'terrible-network'], io),
    ).resolves.toBe(1);

    expect(io.stdout).toEqual([]);
    expect(io.stderr.join('\n')).toContain('Unknown preset "terrible-network"');
    expect(io.stderr.join('\n')).toContain('slow-api, flaky-api, timeout-heavy, backend-down');
    // An expected user mistake, not a crash.
    expect(io.stderr.join('\n')).not.toContain('at ');
  });

  it('offers the option and every preset in the help', async () => {
    const io = captureIo();

    await expect(runCli(['--help'], io)).resolves.toBe(0);

    const help = io.stdout.join('\n');

    expect(help).toContain('--preset <name>');
    expect(help).toContain('Presets:');

    for (const name of ['slow-api', 'flaky-api', 'timeout-heavy', 'backend-down']) {
      expect(help).toContain(name);
    }
  });

  it('states in the help that an explicit flag beats a preset', async () => {
    const io = captureIo();

    await runCli(['--help'], io);

    expect(io.stdout.join('\n')).toContain(
      'explicit chaos flags  >  --preset  >  config file  >  built-in defaults',
    );
  });
});

/** Writes a config file that is removed after the test that made it. */
function writeTempConfig(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'chaos-proxy-program-'));
  tempDirs.push(dir);
  const path = join(dir, 'chaos.yml');
  writeFileSync(path, contents, 'utf8');

  return path;
}

describe('runCli --print-config', () => {
  it('prints the resolved configuration and succeeds', async () => {
    const io = captureIo();

    await expect(runCli(['--target', 'http://localhost:3000', '--print-config'], io)).resolves.toBe(
      0,
    );

    expect(io.stderr).toEqual([]);
    expect(parseYaml(io.stdout.join('\n'))).toMatchObject({
      target: 'http://localhost:3000',
      port: 4000,
      config: null,
      preset: null,
      seed: null,
    });
  });

  // Nothing is bound, so the port a run would have taken is still free
  // afterwards — the surest evidence available in-process that no listener was
  // opened, since a listening proxy would have taken it.
  it('never starts a server, so the port it names is still free', async () => {
    const port = await occupyPort();
    const io = captureIo();

    // A port that is already in use fails an ordinary run outright; printing
    // the configuration does not care, because it never tries to bind.
    await expect(
      runCli(['--target', 'http://localhost:3000', '--port', String(port), '--print-config'], io),
    ).resolves.toBe(0);

    expect(io.stderr).toEqual([]);
    expect(parseYaml(io.stdout.join('\n'))).toMatchObject({ port });
  });

  // Explicitly requested output is not "informational": --quiet silences what
  // the CLI volunteers, not what it was asked for by name.
  it('is not suppressed by --quiet', async () => {
    const quiet = captureIo();
    const loud = captureIo();

    await expect(
      runCli(['--target', 'http://localhost:3000', '--quiet', '--print-config'], quiet),
    ).resolves.toBe(0);
    await expect(
      runCli(['--target', 'http://localhost:3000', '--print-config'], loud),
    ).resolves.toBe(0);

    expect(quiet.stdout).toEqual(loud.stdout);
    expect(quiet.stdout.join('\n')).toContain('target: http://localhost:3000');
  });

  it('prints the configuration on its own, with no startup summary around it', async () => {
    const io = captureIo();

    await expect(
      runCli(['--target', 'http://localhost:3000', '--preset', 'flaky-api', '--print-config'], io),
    ).resolves.toBe(0);

    const text = io.stdout.join('\n');

    expect(text).not.toContain('listening on');
    expect(text).not.toContain('Chaos Proxy configuration');
    expect(text.split('\n')[0]).toBe('target: http://localhost:3000');
  });

  it('shows the effective chaos rather than what asked for it', async () => {
    const path = writeTempConfig(`target: http://localhost:3000

defaults:
  errorRate: 0.1

rules:
  - match: /api/payments/*
    errorRate: 1
    timeoutRate: 0.2
`);
    const io = captureIo();

    await expect(
      runCli(
        ['--config', path, '--preset', 'flaky-api', '--error-rate', '0.5', '--print-config'],
        io,
      ),
    ).resolves.toBe(0);

    expect(parseYaml(io.stdout.join('\n'))).toMatchObject({
      config: path,
      preset: 'flaky-api',
      defaults: { errorRate: 0.5, errorStatus: 503 },
      rules: [{ match: '/api/payments/*', errorRate: 0.5, errorStatus: 503, timeoutRate: 0.2 }],
    });
  });

  // The same missing-target complaint an ordinary run gets: a configuration
  // that could not be started is not printed as though it could.
  it('still requires a target, and says so on stderr', async () => {
    const io = captureIo();

    await expect(runCli(['--print-config', '--latency', '500'], io)).resolves.toBe(1);

    expect(io.stdout).toEqual([]);
    expect(io.stderr.join('\n')).toContain('--target');
  });

  it('reports an unusable config file on stderr and prints nothing', async () => {
    const path = writeTempConfig('target: http://localhost:3000\nfoo: 1\n');
    const io = captureIo();

    await expect(runCli(['--config', path, '--print-config'], io)).resolves.toBe(1);

    expect(io.stdout).toEqual([]);
    expect(io.stderr.join('\n')).toContain(`Invalid config in ${path}`);
  });

  it('reports a chaos value the proxy core rejects, without printing one', async () => {
    const io = captureIo();

    await expect(
      runCli(['--target', 'http://localhost:3000', '--error-rate', '5', '--print-config'], io),
    ).resolves.toBe(1);

    expect(io.stdout).toEqual([]);
    expect(io.stderr[0]).toContain('--error-rate');
  });

  it.each([['--help'], ['--version']])('leaves %s alone', async (flag) => {
    const io = captureIo();

    await expect(runCli([flag, '--print-config'], io)).resolves.toBe(0);

    expect(io.stdout.join('\n')).not.toContain('target:');
  });

  it('offers the option in the help, alongside the config file it settles', async () => {
    const io = captureIo();

    await runCli(['--help'], io);

    const help = io.stdout.join('\n');

    expect(help).toContain('--print-config');
    expect(help).toContain('./chaos.yml');
  });
});
