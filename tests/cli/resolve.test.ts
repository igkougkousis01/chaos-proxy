import type { IncomingMessage } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { DEFAULT_PORT, parseCliArgs } from '../../src/cli/options.js';
import { resolveCommand } from '../../src/cli/resolve.js';
import type { ResolvedCommand } from '../../src/cli/resolve.js';
import { CliError } from '../../src/cli/options.js';
import { ConfigError } from '../../src/config/schema.js';
import type { ChaosOptions } from '../../src/index.js';

/**
 * These tests pin down the precedence the CLI promises:
 *
 *     command-line flags > config file values > built-in defaults
 *
 * They go through `parseCliArgs` as well as `resolveCommand`, so an argv here
 * means exactly what the same argv means in a terminal.
 */

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();

    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

/** Writes a config file that is removed after the test that made it. */
function writeConfig(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'chaos-proxy-resolve-'));
  tempDirs.push(dir);
  const path = join(dir, 'chaos.yml');
  writeFileSync(path, contents, 'utf8');

  return path;
}

/** Runs a whole command line through parsing and resolution. */
function resolve(argv: readonly string[]): ResolvedCommand {
  const parsed = parseCliArgs(argv);

  if (parsed.kind !== 'run') {
    throw new Error(`expected a run command, got ${parsed.kind}`);
  }

  return resolveCommand(parsed.command);
}

/** The chaos the resolved command applies to a request for `url`. */
function chaosFor(command: ResolvedCommand, url: string): ChaosOptions {
  const resolveChaos = command.proxy.resolveChaos;

  if (resolveChaos === undefined) {
    throw new Error('expected the command to resolve chaos per request');
  }

  return resolveChaos({ url } as IncomingMessage);
}

describe('resolveCommand without a config file', () => {
  it('passes the flags straight through, with the default port', () => {
    const command = resolve(['--target', 'http://localhost:3000', '--latency', '500']);

    expect(command).toEqual({
      port: DEFAULT_PORT,
      proxy: { target: 'http://localhost:3000', latencyMs: 500 },
      configPath: undefined,
      ruleCount: 0,
      seed: undefined,
    });
  });

  it('leaves the proxy on static options, with no per-request hook', () => {
    expect(resolve(['--target', 'http://localhost:3000']).proxy.resolveChaos).toBeUndefined();
  });
});

describe('target precedence', () => {
  it('takes the target from the config file when no flag gives one', () => {
    const path = writeConfig('target: http://localhost:3000\n');

    expect(resolve(['--config', path]).proxy.target).toBe('http://localhost:3000');
  });

  it('prefers the command-line target over the config file', () => {
    const path = writeConfig('target: http://localhost:3000\n');

    expect(resolve(['--config', path, '--target', 'http://localhost:9999']).proxy.target).toBe(
      'http://localhost:9999',
    );
  });

  it('refuses to run when neither supplies a target', () => {
    const path = writeConfig('defaults:\n  latencyMs: 100\n');

    expect(() => resolve(['--config', path])).toThrow(CliError);
    expect(() => resolve(['--config', path])).toThrow(/does not set "target"/);
  });

  it('names the config file in that complaint', () => {
    const path = writeConfig('defaults:\n  latencyMs: 100\n');

    expect(() => resolve(['--config', path])).toThrow(path);
  });
});

describe('port precedence', () => {
  it('takes the port from the config file', () => {
    const path = writeConfig('target: http://localhost:3000\nport: 4321\n');

    expect(resolve(['--config', path]).port).toBe(4321);
  });

  it('prefers --port over the config file', () => {
    const path = writeConfig('target: http://localhost:3000\nport: 4000\n');

    expect(resolve(['--config', path, '--port', '5000']).port).toBe(5000);
  });

  it('falls back to the built-in default when neither supplies one', () => {
    const path = writeConfig('target: http://localhost:3000\n');

    expect(resolve(['--config', path]).port).toBe(DEFAULT_PORT);
  });
});

describe('chaos precedence', () => {
  it('applies the config defaults to every request', () => {
    const path = writeConfig('target: http://localhost:3000\ndefaults:\n  latencyMs: 100\n');
    const command = resolve(['--config', path]);

    expect(command.proxy.latencyMs).toBe(100);
  });

  it('prefers a chaos flag over the config defaults', () => {
    const path = writeConfig('target: http://localhost:3000\ndefaults:\n  latencyMs: 100\n');

    expect(resolve(['--config', path, '--latency', '500']).proxy.latencyMs).toBe(500);
  });

  it('leaves config defaults the flags do not mention alone', () => {
    const path = writeConfig(
      'target: http://localhost:3000\ndefaults:\n  latencyMs: 100\n  errorRate: 0.1\n',
    );
    const command = resolve(['--config', path, '--latency', '500']);

    expect(command.proxy).toMatchObject({ latencyMs: 500, errorRate: 0.1 });
  });

  it('applies a rule on top of the defaults for a matching request', () => {
    const path = writeConfig(`target: http://localhost:3000

defaults:
  latencyMs: 100
  errorRate: 0.1
  errorStatus: 500

rules:
  - match: /api/payments/*
    errorRate: 1
    errorStatus: 503
`);
    const command = resolve(['--config', path]);

    expect(command.ruleCount).toBe(1);
    expect(chaosFor(command, '/api/payments/123')).toEqual({
      latencyMs: 100,
      errorRate: 1,
      errorStatus: 503,
    });
    expect(chaosFor(command, '/api/users')).toEqual({
      latencyMs: 100,
      errorRate: 0.1,
      errorStatus: 500,
    });
  });

  it('lets a chaos flag override a rule, disabling it everywhere', () => {
    const path = writeConfig(`target: http://localhost:3000

rules:
  - match: /api/payments/*
    errorRate: 1
`);
    const command = resolve(['--config', path, '--error-rate', '0']);

    expect(chaosFor(command, '/api/payments/123')).toEqual({ errorRate: 0 });
    expect(command.proxy.errorRate).toBe(0);
  });

  it('only installs a per-request hook when there are rules to apply', () => {
    const withoutRules = writeConfig('target: http://localhost:3000\ndefaults:\n  latencyMs: 10\n');
    const withRules = writeConfig(
      'target: http://localhost:3000\nrules:\n  - match: /a\n    errorRate: 1\n',
    );

    expect(resolve(['--config', withoutRules]).proxy.resolveChaos).toBeUndefined();
    expect(resolve(['--config', withRules]).proxy.resolveChaos).toBeDefined();
  });
});

describe('reporting the config in use', () => {
  it('reports the absolute path and how many rules it holds', () => {
    const path = writeConfig(
      'target: http://localhost:3000\nrules:\n  - match: /a\n  - match: /b\n',
    );
    const command = resolve(['--config', path]);

    expect(command.configPath).toBe(path);
    expect(command.ruleCount).toBe(2);
  });
});

describe('config failures', () => {
  it('surfaces a file that is not there as a config error', () => {
    expect(() => resolve(['--config', join(tmpdir(), 'chaos-proxy-absent.yml')])).toThrow(
      ConfigError,
    );
  });

  it('surfaces an invalid config before anything is resolved', () => {
    const path = writeConfig('target: http://localhost:3000\nfoo: 1\n');

    expect(() => resolve(['--config', path])).toThrow('Invalid config: unknown field "foo".');
  });
});

describe('seeding', () => {
  /** The random function a resolved command hands the proxy core. */
  function randomOf(command: ResolvedCommand): () => number {
    const random = command.proxy.random;

    if (random === undefined) {
      throw new Error('expected the command to supply a random function');
    }

    return random;
  }

  it('leaves the proxy on Math.random when no seed was given', () => {
    const command = resolve(['--target', 'http://localhost:3000']);

    expect(command.seed).toBeUndefined();
    expect(command.proxy.random).toBeUndefined();
    expect('random' in command.proxy).toBe(false);
  });

  it('turns a seed into a generator and keeps the string for reporting', () => {
    const command = resolve(['--target', 'http://localhost:3000', '--seed', 'checkout-test']);

    expect(command.seed).toBe('checkout-test');
    expect(typeof randomOf(command)).toBe('function');
  });

  it('produces the sequence that seed stands for', () => {
    const random = randomOf(resolve(['--target', 'http://localhost:3000', '--seed', '12345']));

    expect([random(), random(), random()]).toEqual([
      0.40825439128093421, 0.3569058203138411, 0.8735486085060984,
    ]);
  });

  it('gives every run of the same seed the same sequence', () => {
    const argv = ['--target', 'http://localhost:3000', '--seed', 'checkout-test'];
    const first = randomOf(resolve(argv));
    const second = randomOf(resolve(argv));

    expect([first(), first(), first()]).toEqual([second(), second(), second()]);
  });

  it('gives different seeds different sequences', () => {
    const first = randomOf(resolve(['--target', 'http://localhost:3000', '--seed', 'a']));
    const second = randomOf(resolve(['--target', 'http://localhost:3000', '--seed', 'b']));

    expect(first()).not.toBe(second());
  });

  it('seeds a run that also uses a config file, without touching its rules', () => {
    const path = writeConfig(
      'target: http://localhost:3000\nrules:\n  - match: /fail/*\n    errorRate: 1\n',
    );
    const command = resolve(['--config', path, '--seed', 'checkout-test']);

    expect(command.seed).toBe('checkout-test');
    expect(typeof randomOf(command)).toBe('function');
    expect(chaosFor(command, '/fail/now')).toEqual({ errorRate: 1 });
  });

  // Seeding is a property of one run, not of how an API should misbehave, so
  // the config file has no say in it either way.
  it('ignores a "seed" field in the config file by rejecting it as unknown', () => {
    const path = writeConfig('target: http://localhost:3000\nseed: checkout-test\n');

    expect(() => resolve(['--config', path])).toThrow('unknown field "seed"');
  });
});
