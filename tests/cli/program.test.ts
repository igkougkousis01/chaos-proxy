import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';

import { parseCliArgs } from '../../src/cli/options.js';
import { STOP_HINT, runCli, startupLines } from '../../src/cli/program.js';
import type { CliIo } from '../../src/cli/program.js';
import { resolveCommand } from '../../src/cli/resolve.js';

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

/** Writes a config file that is removed after the test that made it. */
function writeTempConfig(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'chaos-proxy-program-'));
  tempDirs.push(dir);
  const path = join(dir, 'chaos.yml');
  writeFileSync(path, contents, 'utf8');

  return path;
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

/**
 * The summary a command line would print once it was listening.
 *
 * Composed from a settled command rather than from a running server, so every
 * combination worth checking costs a parse instead of a port. What a real
 * process prints is pinned end to end in `binary.test.ts`.
 */
function summaryFor(argv: readonly string[]): string[] {
  const parsed = parseCliArgs(argv);

  if (parsed.kind !== 'run') {
    throw new Error(`expected a run command, got ${parsed.kind}`);
  }

  return startupLines('http://127.0.0.1:4000', resolveCommand(parsed.command));
}

const TARGET = 'http://localhost:3000';

describe('the startup summary', () => {
  it('says where it is listening, what it points at, and how to stop it', () => {
    expect(summaryFor(['--target', TARGET])).toEqual([
      'Chaos Proxy listening on http://127.0.0.1:4000',
      `Target: ${TARGET}`,
      'Press Ctrl+C to stop.',
    ]);
  });

  it('ends with the stop hint however much else it has to say', () => {
    const summary = summaryFor([
      '--target',
      TARGET,
      '--preset',
      'flaky-api',
      '--latency',
      '250',
      '--seed',
      'checkout-test',
    ]);

    expect(summary.at(-1)).toBe(STOP_HINT);
    expect(summary.filter((line) => line === STOP_HINT)).toHaveLength(1);
  });

  it('names the preset that was chosen', () => {
    expect(summaryFor(['--target', TARGET, '--preset', 'flaky-api'])).toContain(
      'Preset: flaky-api',
    );
  });

  it('names the seed exactly as it was typed', () => {
    expect(summaryFor(['--target', TARGET, '--seed', 'checkout-test'])).toContain(
      'Seed: checkout-test',
    );
  });

  it.each([
    [['--latency', '250'], 'Latency: 250ms'],
    [['--error-rate', '0.25', '--error-status', '503'], 'Error injection: 25% -> 503'],
    [['--timeout-rate', '0.1', '--timeout', '3000'], 'Timeout injection: 10% after 3000ms'],
    [['--reset-rate', '0.05'], 'Connection resets: 5%'],
  ])('reports %j as %j', (args, line) => {
    expect(summaryFor(['--target', TARGET, ...args])).toContain(line);
  });

  // Nothing switched off is ever mentioned: a summary that listed every chaos
  // mode would say a run injects errors when it injects nothing at all.
  it.each([
    [[], 'Latency:'],
    [['--latency', '0'], 'Latency:'],
    [['--error-rate', '0'], 'Error injection:'],
    [['--timeout-rate', '0'], 'Timeout injection:'],
    [['--reset-rate', '0'], 'Connection resets:'],
    [[], 'Seed:'],
    [[], 'Preset:'],
    [[], 'Config:'],
    [[], 'Rules:'],
  ])('says nothing about %j, so no %j line appears', (args, absent) => {
    const summary = summaryFor(['--target', TARGET, ...args]).join('\n');

    expect(summary).not.toContain(absent);
  });

  // The chaos lines are read off the settled options, so a preset a flag has
  // overridden away is named without being credited with chaos it no longer
  // causes.
  it('never claims chaos a flag switched off after a preset asked for it', () => {
    const summary = summaryFor(['--target', TARGET, '--preset', 'flaky-api', '--error-rate', '0']);

    expect(summary).toContain('Preset: flaky-api');
    expect(summary.join('\n')).not.toContain('Error injection:');
  });

  it('puts everything in one order, whatever order the flags were typed in', () => {
    expect(
      summaryFor([
        '--reset-rate',
        '0.05',
        '--seed',
        'checkout-test',
        '--timeout-rate',
        '0.1',
        '--timeout',
        '3000',
        '--latency',
        '250',
        '--preset',
        'flaky-api',
        '--target',
        TARGET,
      ]),
    ).toEqual([
      'Chaos Proxy listening on http://127.0.0.1:4000',
      `Target: ${TARGET}`,
      'Preset: flaky-api',
      'Seed: checkout-test',
      'Latency: 250ms',
      'Error injection: 25% -> 503',
      'Timeout injection: 10% after 3000ms',
      'Connection resets: 5%',
      'Press Ctrl+C to stop.',
    ]);
  });
});

describe('the startup summary with a config file', () => {
  it('names the file in effect and how many rules came with it', () => {
    const path = writeTempConfig(`target: ${TARGET}

defaults:
  latencyMs: 250

rules:
  - match: /api/payments/*
    errorRate: 1

  - match: /api/upload/*
    resetRate: 0.5
`);

    expect(summaryFor(['--config', path])).toEqual([
      'Chaos Proxy listening on http://127.0.0.1:4000',
      `Target: ${TARGET}`,
      `Config: ${path}`,
      'Latency: 250ms',
      'Rules: 2',
      'Press Ctrl+C to stop.',
    ]);
  });

  // A file of defaults and no rules is an ordinary file. `Rules: 0` would read
  // as one that failed to take effect.
  it('says nothing about rules when the file has none', () => {
    const path = writeTempConfig(`target: ${TARGET}

defaults:
  latencyMs: 250
`);
    const summary = summaryFor(['--config', path]).join('\n');

    expect(summary).toContain(`Config: ${path}`);
    expect(summary).not.toContain('Rules:');
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
    expect(help).toContain('Probability of abruptly resetting the connection');
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
  it('refuses to start without a target, saying what to provide', async () => {
    const io = captureIo();

    await expect(runCli([], io)).resolves.toBe(1);

    expect(io.stdout).toEqual([]);
    // The action a reader can take, rather than a pointer to the whole help.
    expect(io.stderr).toEqual([
      'chaos-proxy: Missing required target.',
      'Provide --target <url>, or set "target" in ./chaos.yml.',
    ]);
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

/** Whether a message ends in a full stop, or in a path that must not take one. */
function endsProperly(line: string): boolean {
  const lastWord = line.split(' ').at(-1) ?? '';

  return line.endsWith('.') || lastWord.includes('/');
}

// One table over every user mistake the CLI can be handed, checking the
// properties they all share rather than each wording twice: nothing on stdout,
// a non-zero code, one problem line, at most one action, and no stack trace.
describe('every user-facing error', () => {
  const BAD_COMMAND_LINES: readonly (readonly string[])[] = [
    [],
    ['--erro-rate', '0.5'],
    ['--target'],
    ['http://localhost:3000'],
    ['--target', 'localhost:3000'],
    ['--target', TARGET, '--preset', 'terrible-network'],
    ['--target', TARGET, '--port', '0'],
    ['--target', TARGET, '--latency', 'abc'],
    ['--target', TARGET, '--latency=-1'],
    ['--target', TARGET, '--error-rate', '2'],
    ['--target', TARGET, '--error-status', '200'],
    ['--target', TARGET, '--timeout-rate', '2'],
    ['--target', TARGET, '--timeout=-1'],
    ['--target', TARGET, '--reset-rate', '2'],
    ['--target', TARGET, '--seed', ''],
    ['--config', '/nowhere/missing.yml'],
  ];

  it.each(BAD_COMMAND_LINES)('reports %j on stderr alone, and fails', async (...argv) => {
    const io = captureIo();

    await expect(runCli(argv, io)).resolves.toBe(1);
    expect(io.stdout).toEqual([]);
    expect(io.stderr.length).toBeGreaterThan(0);
    expect(io.stderr.length).toBeLessThanOrEqual(2);
  });

  it.each(BAD_COMMAND_LINES)('says what is wrong in %j without a stack trace', async (...argv) => {
    const io = captureIo();

    await runCli(argv, io);

    const [problem, ...rest] = io.stderr;

    expect(problem).toMatch(/^chaos-proxy: \S/);
    expect(io.stderr.join('\n')).not.toContain('    at ');
    expect(io.stderr.join('\n')).not.toContain('Error:');

    // A sentence ends in a full stop, unless it ends in a path — there a full
    // stop is one more character the reader has to decide is not part of the
    // filename.
    for (const line of [problem, ...rest]) {
      expect(endsProperly(line ?? '')).toBe(true);
    }
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
    expect(io.stderr).toEqual([
      `chaos-proxy: Port ${port} is already in use on 127.0.0.1.`,
      'Choose another port with --port.',
    ]);
    // A port that is taken is not a usage mistake, and --help cannot help.
    expect(io.stderr.join('\n')).not.toContain('--help');
  });

  it('still reports one on stderr under --quiet', async () => {
    const port = await occupyPort();
    const io = captureIo();

    await expect(
      runCli(['--target', 'http://127.0.0.1:1', '--port', String(port), '--quiet'], io),
    ).resolves.toBe(1);

    // --quiet drops what the CLI would volunteer, never what it has to report.
    expect(io.stdout).toEqual([]);
    expect(io.stderr.join('\n')).toContain(`Port ${port} is already in use`);
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

  it('does not suppress an unknown option', async () => {
    const io = captureIo();

    await expect(runCli(['--quiet', '--erro-rate', '0.5'], io)).resolves.toBe(1);

    expect(io.stderr.join('\n')).toContain('Unknown option --erro-rate.');
  });

  it('does not suppress a value the proxy core rejects', async () => {
    const io = captureIo();

    await expect(
      runCli(['--quiet', '--target', 'http://localhost:3000', '--error-rate', '5'], io),
    ).resolves.toBe(1);

    expect(io.stderr).toEqual([
      'chaos-proxy: Invalid --error-rate 5.',
      'Expected a number between 0 and 1 inclusive.',
    ]);
  });

  it('does not suppress a config file it cannot use', async () => {
    const path = writeTempConfig('target: http://localhost:3000\nfoo: 1\n');
    const io = captureIo();

    await expect(runCli(['--quiet', '--config', path], io)).resolves.toBe(1);

    expect(io.stdout).toEqual([]);
    expect(io.stderr.join('\n')).toContain(`Invalid config in ${path}`);
  });

  // A file problem is not a usage mistake, so nothing points at --help: the
  // answer is in the file, and the message already says which one.
  it('reports a config file that is not there without pointing at the help', async () => {
    const io = captureIo();

    await expect(runCli(['--config', '/nowhere/missing.yml'], io)).resolves.toBe(1);

    expect(io.stderr).toEqual(['chaos-proxy: Config file not found: /nowhere/missing.yml']);
  });
});

describe('runCli --seed', () => {
  it('reports an empty seed as a usage mistake', async () => {
    const io = captureIo();

    await expect(runCli(['--target', 'http://127.0.0.1:1', '--seed', ''], io)).resolves.toBe(1);

    expect(io.stdout).toEqual([]);
    expect(io.stderr).toEqual([
      'chaos-proxy: Invalid --seed "".',
      'Expected a non-empty value, for example checkout-test.',
    ]);
  });

  it('offers it in the help, as a reproducibility control rather than chaos', async () => {
    const io = captureIo();

    await expect(runCli(['--help'], io)).resolves.toBe(0);

    const help = io.stdout.join('\n');

    expect(help).toContain('--seed <value>');
    expect(help).toContain('Deterministic chaos decisions');
    expect(help).toContain('--seed test-run');
  });
});

describe('runCli --preset', () => {
  it('refuses an unknown preset without starting, naming the ones that exist', async () => {
    const io = captureIo();

    await expect(
      runCli(['--target', 'http://127.0.0.1:1', '--preset', 'terrible-network'], io),
    ).resolves.toBe(1);

    expect(io.stdout).toEqual([]);
    expect(io.stderr).toEqual([
      'chaos-proxy: Unknown preset "terrible-network".',
      'Available presets: slow-api, flaky-api, timeout-heavy, backend-down.',
    ]);
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
      'A preset is a starting point, so an explicit chaos flag still wins over it.',
    );
  });
});

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
