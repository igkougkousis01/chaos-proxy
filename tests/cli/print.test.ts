import type { IncomingMessage } from 'node:http';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';

import { DEFAULT_PORT, parseCliArgs } from '../../src/cli/options.js';
import { formatEffectiveConfig } from '../../src/cli/print.js';
import { resolveCommand } from '../../src/cli/resolve.js';
import type { ResolvedCommand } from '../../src/cli/resolve.js';
import { resolveChaosOptions } from '../../src/proxy/server.js';
import type { ResolvedChaosOptions } from '../../src/proxy/server.js';

/**
 * What `--print-config` resolves and how it is rendered.
 *
 * The parity block at the end is the point of the whole feature: the printed
 * configuration is not allowed to be a second opinion about precedence, so it
 * is checked against what the running proxy would actually decide, computed
 * with the proxy core's own resolver rather than with merging logic written out
 * again here.
 */

const tempDirs: string[] = [];
let restoreCwd: string | undefined;

afterEach(() => {
  if (restoreCwd !== undefined) {
    process.chdir(restoreCwd);
    restoreCwd = undefined;
  }

  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();

    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

/** A scratch directory that is removed after the test that made it. */
function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'chaos-proxy-print-'));
  tempDirs.push(dir);

  return dir;
}

/** Writes a config file that is removed after the test that made it. */
function writeConfig(contents: string, name = 'chaos.yml'): string {
  const path = join(makeTempDir(), name);
  writeFileSync(path, contents, 'utf8');

  return path;
}

/**
 * Stands in `dir` for the rest of the test, restoring the old cwd after it.
 *
 * Returns the directory as the process now sees it: on macOS a temporary
 * directory reaches it through a symlink, and `process.cwd()` reports the real
 * path, so a test comparing paths has to compare that one.
 */
function standIn(dir: string): string {
  restoreCwd ??= process.cwd();
  process.chdir(dir);

  return realpathSync(dir);
}

/** Runs a whole command line through parsing and resolution. */
function resolve(argv: readonly string[]): ResolvedCommand {
  const parsed = parseCliArgs(argv);

  if (parsed.kind !== 'run') {
    throw new Error(`expected a run command, got ${parsed.kind}`);
  }

  return resolveCommand(parsed.command);
}

/** The printed configuration, parsed back into a document to assert against. */
function printed(argv: readonly string[]): Record<string, unknown> {
  return parseYaml(formatEffectiveConfig(resolve(argv).effective)) as Record<string, unknown>;
}

describe('the effective configuration', () => {
  it('settles the target, the port and the absence of everything else', () => {
    const command = resolve(['--target', 'http://localhost:3000']);

    expect(command.effective).toEqual({
      target: 'http://localhost:3000',
      port: DEFAULT_PORT,
      configPath: undefined,
      preset: undefined,
      seed: undefined,
      defaults: {
        latencyMs: 0,
        errorRate: 0,
        errorStatus: 500,
        timeoutRate: 0,
        timeoutMs: 30_000,
        resetRate: 0,
      },
      rules: [],
    });
  });

  it('fills in every built-in default, including the ones nothing configured', () => {
    const command = resolve(['--target', 'http://localhost:3000', '--error-rate', '0.5']);

    expect(command.effective.defaults).toEqual({
      latencyMs: 0,
      errorRate: 0.5,
      errorStatus: 500,
      timeoutRate: 0,
      timeoutMs: 30_000,
      resetRate: 0,
    });
  });

  it('reports the config file it used by absolute path', () => {
    const path = writeConfig('target: http://localhost:3000\n');

    expect(resolve(['--config', path]).effective.configPath).toBe(path);
  });

  it('reports the preset and the seed exactly as they were given', () => {
    const command = resolve([
      '--target',
      'http://localhost:3000',
      '--preset',
      'flaky-api',
      '--seed',
      'checkout-test',
    ]);

    expect(command.effective.preset).toBe('flaky-api');
    expect(command.effective.seed).toBe('checkout-test');
  });

  /**
   * Effective rules, not the file's own. This is the example from the feature
   * as specified: the rule sets `errorRate: 1`, the preset would make it
   * `0.25`, and the flag settles it at `0.5` — while `timeoutRate`, which
   * neither the preset nor the flag mentions, keeps the rule's own value.
   */
  it('applies preset and flags over a rule, rather than echoing the file', () => {
    const path = writeConfig(`target: http://localhost:3000

defaults:
  errorRate: 0.1

rules:
  - match: /payments/*
    errorRate: 1
    timeoutRate: 0.2
`);
    const command = resolve(['--config', path, '--preset', 'flaky-api', '--error-rate', '0.5']);

    expect(command.effective.rules).toEqual([
      {
        match: '/payments/*',
        chaos: {
          latencyMs: 0,
          errorRate: 0.5,
          errorStatus: 503,
          timeoutRate: 0.2,
          timeoutMs: 30_000,
          resetRate: 0,
        },
      },
    ]);
  });

  it('keeps rules in the order the file wrote them', () => {
    const path = writeConfig(`target: http://localhost:3000

rules:
  - match: /a
  - match: /b/*
  - match: /c
`);

    expect(resolve(['--config', path]).effective.rules.map((rule) => rule.match)).toEqual([
      '/a',
      '/b/*',
      '/c',
    ]);
  });
});

describe('formatEffectiveConfig', () => {
  it('prints YAML that parses back to the settled values', () => {
    expect(printed(['--target', 'http://localhost:3000', '--port', '4321'])).toEqual({
      target: 'http://localhost:3000',
      port: 4321,
      config: null,
      preset: null,
      seed: null,
      defaults: {
        latencyMs: 0,
        errorRate: 0,
        errorStatus: 500,
        timeoutRate: 0,
        timeoutMs: 30_000,
        resetRate: 0,
      },
      rules: [],
    });
  });

  // Consistency over compactness: a field that vanished when it was switched
  // off would leave the reader unable to tell "off" from "not implemented".
  it('reports an absent config, preset and seed as null rather than omitting them', () => {
    const document = printed(['--target', 'http://localhost:3000']);

    expect(document.config).toBeNull();
    expect(document.preset).toBeNull();
    expect(document.seed).toBeNull();
    expect(Object.keys(document)).toEqual([
      'target',
      'port',
      'config',
      'preset',
      'seed',
      'defaults',
      'rules',
    ]);
  });

  it('prints resetRate alongside every other chaos value', () => {
    const document = printed(['--target', 'http://localhost:3000', '--reset-rate', '0.25']);

    expect(document.defaults).toMatchObject({ resetRate: 0.25 });
  });

  it('names the config file and the preset when there are any', () => {
    const path = writeConfig('target: http://localhost:3000\n');
    const document = printed(['--config', path, '--preset', 'slow-api', '--seed', 'abc']);

    expect(document).toMatchObject({ config: path, preset: 'slow-api', seed: 'abc' });
  });

  it('prints each rule as a match followed by its complete chaos', () => {
    const path = writeConfig(`target: http://localhost:3000

rules:
  - match: /api/payments/*
    errorRate: 1
    errorStatus: 503
`);

    expect(printed(['--config', path]).rules).toEqual([
      {
        match: '/api/payments/*',
        latencyMs: 0,
        errorRate: 1,
        errorStatus: 503,
        timeoutRate: 0,
        timeoutMs: 30_000,
        resetRate: 0,
      },
    ]);
  });

  it('gives the same text every time it is asked', () => {
    const path = writeConfig(`target: http://localhost:3000

defaults:
  latencyMs: 250

rules:
  - match: /api/payments/*
    errorRate: 0.5
`);
    const argv = ['--config', path, '--preset', 'flaky-api', '--seed', 'checkout-test'];
    const runs = [1, 2, 3].map(() => formatEffectiveConfig(resolve(argv).effective));

    expect(new Set(runs).size).toBe(1);
  });

  it('ends without a trailing blank line', () => {
    const text = formatEffectiveConfig(resolve(['--target', 'http://localhost:3000']).effective);

    expect(text.endsWith('\n')).toBe(false);
    expect(text.split('\n')[0]).toBe('target: http://localhost:3000');
  });

  // Configuration only. Nothing about the machine, the environment or the
  // traffic belongs in output a user is likely to paste into an issue.
  it('prints nothing but configuration', () => {
    process.env.CHAOS_PROXY_PRINT_CONFIG_PROBE = 'must-not-appear';

    try {
      const text = formatEffectiveConfig(
        resolve(['--target', 'http://localhost:3000', '--seed', 'checkout-test']).effective,
      );

      expect(text).not.toContain('must-not-appear');
      expect(text).not.toContain('CHAOS_PROXY_PRINT_CONFIG_PROBE');
      expect(text).not.toMatch(/header|cookie|authorization|env/i);
    } finally {
      delete process.env.CHAOS_PROXY_PRINT_CONFIG_PROBE;
    }
  });
});

describe('config discovery through resolution', () => {
  it('uses ./chaos.yml when --config was not given', () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, 'chaos.yml'), 'target: http://localhost:1234\n', 'utf8');
    const here = standIn(dir);

    const command = resolve([]);

    expect(command.effective.configPath).toBe(join(here, 'chaos.yml'));
    expect(command.effective.target).toBe('http://localhost:1234');
  });

  it('lets an explicit --config beat the conventional file', () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, 'chaos.yml'), 'target: http://localhost:1234\n', 'utf8');
    writeFileSync(join(dir, 'other.yml'), 'target: http://localhost:9999\n', 'utf8');
    const here = standIn(dir);

    const command = resolve(['--config', 'other.yml']);

    expect(command.effective.configPath).toBe(join(here, 'other.yml'));
    expect(command.effective.target).toBe('http://localhost:9999');
  });

  it('fails on an explicit missing --config even with a chaos.yml right there', () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, 'chaos.yml'), 'target: http://localhost:1234\n', 'utf8');
    const here = standIn(dir);

    expect(() => resolve(['--config', './missing.yml'])).toThrow(
      `Config file not found: ${join(here, 'missing.yml')}`,
    );
  });

  it('runs from the command line alone when there is no conventional file', () => {
    standIn(makeTempDir());

    const command = resolve(['--target', 'http://localhost:3000']);

    expect(command.effective.configPath).toBeUndefined();
    expect(command.effective.target).toBe('http://localhost:3000');
  });

  it('still asks for a target when neither a flag nor a discovered file has one', () => {
    standIn(makeTempDir());

    expect(() => resolve([])).toThrow('Missing required target.');
  });

  it('names the discovered file when it is the one missing a target', () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, 'chaos.yml'), 'defaults:\n  latencyMs: 100\n', 'utf8');
    const here = standIn(dir);

    expect(() => resolve([])).toThrow(join(here, 'chaos.yml'));
  });

  it('lets flags layer over a discovered file exactly as over an explicit one', () => {
    const dir = makeTempDir();
    writeFileSync(
      join(dir, 'chaos.yml'),
      'target: http://localhost:1234\ndefaults:\n  latencyMs: 100\n',
      'utf8',
    );
    standIn(dir);

    expect(resolve(['--latency', '500']).effective.defaults.latencyMs).toBe(500);
  });
});

describe('runtime parity', () => {
  /**
   * The chaos the running proxy would apply to a request for `url`.
   *
   * This is the proxy core's own arithmetic, in the order `createProxyServer`
   * performs it: the static options become the static chaos, and a
   * `resolveChaos` result is layered over that for one request. Nothing about
   * precedence is re-implemented here, so agreeing with the printed
   * configuration means the two really do come from one resolution.
   */
  function runtimeChaosFor(command: ResolvedCommand, url: string): ResolvedChaosOptions {
    const staticChaos = resolveChaosOptions(command.proxy);
    const { resolveChaos } = command.proxy;

    if (resolveChaos === undefined) {
      return staticChaos;
    }

    return resolveChaosOptions(resolveChaos({ url } as IncomingMessage), staticChaos);
  }

  const CONFIG = `target: http://localhost:3000
port: 4321

defaults:
  latencyMs: 100
  errorRate: 0.1

rules:
  - match: /api/payments/*
    errorRate: 1
    errorStatus: 503

  - match: /api/search
    timeoutRate: 1
    timeoutMs: 2000

  - match: /api/upload/*
    resetRate: 0.5
`;

  it.each([
    [[]],
    [['--preset', 'flaky-api']],
    [['--error-rate', '0.5']],
    [['--preset', 'flaky-api', '--error-rate', '0.5']],
    [['--preset', 'backend-down', '--reset-rate', '0.25', '--seed', 'checkout-test']],
    [['--preset', 'slow-api', '--latency', '0', '--port', '5000']],
  ])('prints the chaos the proxy would really apply, with %j', (extra) => {
    const command = resolve(['--config', writeConfig(CONFIG), ...extra]);

    // What a request no rule matches receives.
    expect(command.effective.defaults).toEqual(runtimeChaosFor(command, '/api/users'));

    // And what each rule's own requests receive.
    for (const rule of command.effective.rules) {
      const url = rule.match.endsWith('/*') ? `${rule.match.slice(0, -1)}123` : rule.match;

      expect(runtimeChaosFor(command, url)).toEqual(rule.chaos);
    }
  });

  it('prints the port and target the proxy would really use', () => {
    const command = resolve(['--config', writeConfig(CONFIG), '--target', 'http://localhost:9999']);

    expect(command.effective.port).toBe(command.port);
    expect(command.effective.target).toBe(command.proxy.target);
  });

  it('agrees with the startup summary about the config file and rule count', () => {
    const command = resolve(['--config', writeConfig(CONFIG)]);

    expect(command.effective.configPath).toBe(command.configPath);
    expect(command.effective.rules).toHaveLength(command.ruleCount);
  });

  it('describes a run with no rules from the static options alone', () => {
    const command = resolve(['--target', 'http://localhost:3000', '--timeout-rate', '0.3']);

    expect(command.proxy.resolveChaos).toBeUndefined();
    expect(command.effective.defaults).toEqual(runtimeChaosFor(command, '/anything'));
  });
});

describe('resolution refuses a configuration that could not run', () => {
  it('rejects a target the proxy core would reject, in the flag that carried it', () => {
    expect(() => resolve(['--target', 'localhost:3000'])).toThrow(/localhost:3000/);
  });

  it.each([
    [['--error-rate', '5'], '--error-rate'],
    [['--timeout-rate', '5'], '--timeout-rate'],
    [['--error-status', '200'], '--error-status'],
    [['--reset-rate', '5'], '--reset-rate'],
    [['--latency=-1'], '--latency'],
  ])('rejects %j in terms of %s', (extra, flag) => {
    expect(() => resolve(['--target', 'http://localhost:3000', ...extra])).toThrow(flag);
  });
});
