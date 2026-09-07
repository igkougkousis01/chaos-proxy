import { describe, expect, it } from 'vitest';

import { CliError, HELP_TEXT, inFlagTerms, parseCliArgs } from '../../src/cli/options.js';

const TARGET = 'http://localhost:3000';

/** Parses a command line that is expected to ask for the proxy to start. */
function parseRun(argv: readonly string[]) {
  const parsed = parseCliArgs(argv);

  if (parsed.kind !== 'run') {
    throw new Error(`expected a run command, got ${parsed.kind}`);
  }

  return parsed.command;
}

describe('parseCliArgs', () => {
  it('reports only what was typed, leaving the rest for the config file', () => {
    const command = parseRun(['--target', TARGET]);

    expect(command).toEqual({
      target: TARGET,
      configPath: undefined,
      port: undefined,
      chaos: {},
      seed: undefined,
      quiet: false,
    });
  });

  it('accepts the --option=value form', () => {
    expect(parseRun([`--target=${TARGET}`]).target).toBe(TARGET);
  });

  it('reports --quiet only when it was given', () => {
    expect(parseRun(['--target', TARGET]).quiet).toBe(false);
    expect(parseRun(['--target', TARGET, '--quiet']).quiet).toBe(true);
  });

  it('reports the path given to --config', () => {
    expect(parseRun(['--config', './chaos.yml']).configPath).toBe('./chaos.yml');
  });

  it('does not require --target when a config file may supply one', () => {
    expect(parseRun(['--config', 'chaos.yml']).target).toBeUndefined();
  });

  it('maps every chaos flag onto its proxy option', () => {
    const command = parseRun([
      '--target',
      TARGET,
      '--port',
      '4100',
      '--latency',
      '500',
      '--error-rate',
      '0.2',
      '--error-status',
      '503',
      '--timeout-rate',
      '0.1',
      '--timeout',
      '3000',
      '--reset-rate',
      '0.05',
    ]);

    expect(command.port).toBe(4100);
    expect(command.target).toBe(TARGET);
    expect(command.chaos).toEqual({
      latencyMs: 500,
      errorRate: 0.2,
      errorStatus: 503,
      timeoutRate: 0.1,
      timeoutMs: 3000,
      resetRate: 0.05,
    });
  });

  it('reads --reset-rate on its own, leaving every other chaos option absent', () => {
    const command = parseRun(['--target', TARGET, '--reset-rate', '0.25']);

    expect(command.chaos).toEqual({ resetRate: 0.25 });
  });

  it('keeps an explicit --reset-rate 0, which is a value rather than an omission', () => {
    const command = parseRun(['--target', TARGET, '--reset-rate', '0']);

    // The difference matters: absent lets a config file decide, `0` overrides
    // it and switches resets off everywhere.
    expect(command.chaos).toEqual({ resetRate: 0 });
    expect('resetRate' in command.chaos).toBe(true);
  });

  it('does not offer a short alias for --reset-rate', () => {
    expect(() => parseCliArgs(['--target', TARGET, '-r', '0.5'])).toThrow(CliError);
  });

  it('leaves flags that were not given off entirely, so config or core defaults apply', () => {
    const command = parseRun(['--target', TARGET, '--error-rate', '0.5']);

    expect(command.chaos).toEqual({ errorRate: 0.5 });
    expect('errorStatus' in command.chaos).toBe(false);
    expect('latencyMs' in command.chaos).toBe(false);
  });

  it.each([['--help'], ['-h']])('reports %s, even without a target', (flag) => {
    expect(parseCliArgs([flag])).toEqual({ kind: 'help' });
  });

  it.each([['--version'], ['-v']])('reports %s, even without a target', (flag) => {
    expect(parseCliArgs([flag])).toEqual({ kind: 'version' });
  });

  it('prefers help over version', () => {
    expect(parseCliArgs(['--version', '--help'])).toEqual({ kind: 'help' });
  });

  it.each([[[]], [['--latency', '500']], [['--target=']]])(
    'rejects %j because no target was given',
    (argv) => {
      expect(() => parseCliArgs(argv)).toThrow(CliError);
      expect(() => parseCliArgs(argv)).toThrow(/--target/);
    },
  );

  // The config file cannot supply a target the user explicitly blanked out.
  it('rejects an empty --target even alongside --config', () => {
    expect(() => parseCliArgs(['--config', 'chaos.yml', '--target='])).toThrow(/--target/);
  });

  it('rejects an empty --config', () => {
    expect(() => parseCliArgs(['--config='])).toThrow(/--config/);
  });

  it('rejects an unknown option', () => {
    expect(() => parseCliArgs(['--target', TARGET, '--chaos'])).toThrow(/--chaos/);
  });

  it('rejects a positional argument', () => {
    expect(() => parseCliArgs([TARGET])).toThrow(CliError);
  });

  it('rejects an option that is missing its value', () => {
    expect(() => parseCliArgs(['--target'])).toThrow(CliError);
  });

  it.each(['0', '-1', '65536', '4000.5', 'abc', '', ' ', 'Infinity'])(
    'rejects a --port of %j',
    (port) => {
      expect(() => parseCliArgs(['--target', TARGET, '--port', port])).toThrow(CliError);
      expect(() => parseCliArgs(['--target', TARGET, '--port', port])).toThrow(/--port/);
    },
  );

  it.each([
    ['1', 1],
    ['4000', 4000],
    ['65535', 65_535],
  ])('accepts a --port of %j', (port, expected) => {
    expect(parseRun(['--target', TARGET, '--port', port]).port).toBe(expected);
  });

  it.each([
    ['--latency', 'abc'],
    ['--error-rate', ''],
    ['--error-status', 'five hundred'],
    ['--timeout-rate', 'abc'],
    ['--timeout', 'soon'],
    ['--reset-rate', 'often'],
    ['--reset-rate', ''],
  ])('rejects a %s of %j as not a number', (flag, value) => {
    expect(() => parseCliArgs(['--target', TARGET, flag, value])).toThrow(CliError);
    expect(() => parseCliArgs(['--target', TARGET, flag, value])).toThrow(flag);
  });

  // Ranges belong to createProxyServer, so parsing deliberately lets these
  // through rather than keeping a second copy of the same rules.
  it.each([
    ['--error-rate', '5'],
    ['--latency=-1', ''],
    ['--error-status', '200'],
    ['--reset-rate', '5'],
  ])('leaves an out-of-range %s%j to the proxy core', (flag, value) => {
    const argv = value === '' ? ['--target', TARGET, flag] : ['--target', TARGET, flag, value];

    expect(() => parseCliArgs(argv)).not.toThrow();
  });

  // A separate `-1` would be read as another flag, so the parser asks for the
  // unambiguous form rather than guessing.
  it('asks for --latency=-1 when a negative value is given as its own argument', () => {
    expect(() => parseCliArgs(['--target', TARGET, '--latency', '-1'])).toThrow(/--latency=-XYZ/);
  });

  it('leaves a target that is not a URL to the proxy core', () => {
    expect(parseRun(['--target', 'localhost:3000']).target).toBe('localhost:3000');
  });

  it.each(['checkout-test', '12345', 'abc', 'Checkout Test', '  padded  '])(
    'takes --seed %j verbatim',
    (seed) => {
      expect(parseRun(['--target', TARGET, '--seed', seed]).seed).toBe(seed);
    },
  );

  it('reports no seed when --seed was not given', () => {
    expect(parseRun(['--target', TARGET]).seed).toBeUndefined();
  });

  it.each([['--seed='], ['--seed', '']])('rejects an empty seed given as %j', (...argv) => {
    const line = ['--target', TARGET, ...argv];

    expect(() => parseCliArgs(line)).toThrow(CliError);
    expect(() => parseCliArgs(line)).toThrow(/--seed/);
  });

  it('is not a chaos option, so it never reaches the chaos block', () => {
    expect(parseRun(['--target', TARGET, '--seed', 'checkout-test']).chaos).toEqual({});
  });

  it('documents --seed in the help text', () => {
    expect(HELP_TEXT).toContain('--seed <value>');
    expect(HELP_TEXT).toContain('Use deterministic chaos decisions for reproducible');
  });
});

describe('HELP_TEXT connection resets', () => {
  it('documents --reset-rate and what it does', () => {
    expect(HELP_TEXT).toContain('--reset-rate <0-1>');
    expect(HELP_TEXT).toContain('Probability of abruptly resetting the client');
  });

  it('states where the reset decision sits in the chaos order', () => {
    expect(HELP_TEXT).toContain('latency delay, then connection reset, then timeout, then error');
  });
});

describe('inFlagTerms', () => {
  it.each([
    ['Invalid errorRate 5: expected a number.', 'Invalid --error-rate 5: expected a number.'],
    ['Invalid latencyMs -1: expected a number.', 'Invalid --latency -1: expected a number.'],
    ['Invalid timeoutMs -1: expected a number.', 'Invalid --timeout -1: expected a number.'],
  ])('rewrites %j in terms of the flag that carried it', (message, expected) => {
    expect(inFlagTerms(message)).toBe(expected);
  });

  it('leaves a message it does not recognise alone', () => {
    const message = 'Unsupported proxy target protocol "ftp:" in "ftp://example.com".';

    expect(inFlagTerms(message)).toBe(message);
  });

  it('reports a resetRate complaint as --reset-rate', () => {
    expect(inFlagTerms('Invalid resetRate 5: expected a number between 0 and 1 inclusive.')).toBe(
      'Invalid --reset-rate 5: expected a number between 0 and 1 inclusive.',
    );
  });

  it('never edits a value quoted inside the message', () => {
    const message = 'Invalid errorStatus 200: seen at "http://api.timeout.example.com".';

    expect(inFlagTerms(message)).toBe(
      'Invalid --error-status 200: seen at "http://api.timeout.example.com".',
    );
  });
});

describe('parseCliArgs --preset', () => {
  it('reports no preset when none was asked for', () => {
    expect(parseRun(['--target', TARGET]).preset).toBeUndefined();
  });

  it.each(['slow-api', 'flaky-api', 'timeout-heavy', 'backend-down'])('accepts %s', (name) => {
    expect(parseRun(['--target', TARGET, '--preset', name]).preset).toBe(name);
  });

  it('accepts the --preset=value form', () => {
    expect(parseRun(['--target', TARGET, '--preset=flaky-api']).preset).toBe('flaky-api');
  });

  // The preset is carried as a name, not as the chaos it stands for: what it
  // means is settled in `resolve.ts`, where everything else is.
  it('leaves the chaos block untouched, so precedence is decided in one place', () => {
    const command = parseRun(['--target', TARGET, '--preset', 'flaky-api']);

    expect(command.chaos).toEqual({});
  });

  it('keeps an explicit flag alongside the preset name', () => {
    const command = parseRun(['--target', TARGET, '--preset', 'flaky-api', '--error-rate', '0.5']);

    expect(command.preset).toBe('flaky-api');
    expect(command.chaos).toEqual({ errorRate: 0.5 });
  });

  it('rejects an unknown preset and offers the ones that exist', () => {
    const argv = ['--target', TARGET, '--preset', 'terrible-network'];

    expect(() => parseCliArgs(argv)).toThrow(CliError);
    expect(() => parseCliArgs(argv)).toThrow(
      'Unknown preset "terrible-network". Available presets: slow-api, flaky-api, timeout-heavy, backend-down.',
    );
  });

  it.each(['', 'SLOW-API', 'slow', 'flaky'])('rejects %j', (name) => {
    expect(() => parseCliArgs(['--target', TARGET, '--preset', name])).toThrow(/preset/);
  });
});

describe('HELP_TEXT presets', () => {
  it('documents the option', () => {
    expect(HELP_TEXT).toContain('--preset <name>');
  });

  it.each(['slow-api', 'flaky-api', 'timeout-heavy', 'backend-down'])(
    'lists %s with what it does',
    (name) => {
      expect(HELP_TEXT).toContain(name);
    },
  );

  it('states where a preset sits in the precedence order', () => {
    expect(HELP_TEXT).toContain(
      'explicit chaos flags  >  --preset  >  config file  >  built-in defaults',
    );
  });
});
