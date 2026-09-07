import { describe, expect, it } from 'vitest';

import { CliError, HELP_TEXT, inFlagTerms, parseCliArgs } from '../../src/cli/options.js';

const TARGET = 'http://localhost:3000';

/**
 * The guidance line a command line produces, or `undefined` when it has none.
 *
 * Every user-facing error is a problem and at most one action, so a test about
 * the wording has to be able to read both halves.
 */
function hintFor(argv: readonly string[]): string | undefined {
  try {
    parseCliArgs(argv);
  } catch (error) {
    if (error instanceof CliError) {
      return error.hint;
    }

    throw error;
  }

  throw new Error(`expected ${JSON.stringify(argv)} to be rejected`);
}

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
      printConfig: false,
    });
  });

  it('accepts the --option=value form', () => {
    expect(parseRun([`--target=${TARGET}`]).target).toBe(TARGET);
  });

  it('reports --quiet only when it was given', () => {
    expect(parseRun(['--target', TARGET]).quiet).toBe(false);
    expect(parseRun(['--target', TARGET, '--quiet']).quiet).toBe(true);
  });

  it('reports --print-config only when it was given', () => {
    expect(parseRun(['--target', TARGET]).printConfig).toBe(false);
    expect(parseRun(['--target', TARGET, '--print-config']).printConfig).toBe(true);
  });

  it('does not offer a short alias for --print-config', () => {
    expect(() => parseCliArgs(['--target', TARGET, '-p'])).toThrow(CliError);
  });

  // Help and version are answered before anything else is looked at, so the
  // combination is unambiguous rather than something to guess at.
  it.each([['--help'], ['--version']])('prefers %s over --print-config', (flag) => {
    expect(parseCliArgs([flag, '--print-config']).kind).toBe(flag.slice(2));
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

  // An empty `--target` is a value the user typed and got wrong, so it is
  // rejected here. A missing one is not: `./chaos.yml` may still supply it, and
  // only the resolver knows whether that file exists.
  it('rejects an empty --target', () => {
    expect(() => parseCliArgs(['--target='])).toThrow(CliError);
    expect(() => parseCliArgs(['--target='])).toThrow(/--target/);
  });

  it.each([[[]], [['--latency', '500']]])(
    'leaves %j with no target for the resolver to settle',
    (argv) => {
      expect(() => parseCliArgs(argv)).not.toThrow();
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
  // unambiguous form rather than guessing — in one line of the CLI's own,
  // rather than in the three the parser offers.
  it('asks for the --latency=<value> form when a negative value is given on its own', () => {
    const argv = ['--target', TARGET, '--latency', '-1'];

    expect(() => parseCliArgs(argv)).toThrow('Missing value for --latency.');
    expect(hintFor(argv)).toBe('A value starting with "-" must be written as --latency=<value>.');
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
    expect(HELP_TEXT).toContain('Deterministic chaos decisions');
  });
});

describe('HELP_TEXT connection resets', () => {
  it('documents --reset-rate and what it does', () => {
    expect(HELP_TEXT).toContain('--reset-rate <0-1>');
    expect(HELP_TEXT).toContain('Probability of abruptly resetting the connection');
  });

  // Where the reset decision sits in the chaos order is documented in the
  // README. Help lists the options; it is not the manual.
  it('lists it among the chaos options rather than explaining the order', () => {
    expect(HELP_TEXT).toContain('Chaos options:');
    expect(HELP_TEXT).not.toContain('latency delay, then connection reset');
  });
});

describe('HELP_TEXT shape', () => {
  it('opens with the tool and what it does', () => {
    const lines = HELP_TEXT.split('\n');

    expect(lines[0]).toBe('Chaos Proxy');
    expect(HELP_TEXT).toContain('Inject latency, HTTP errors, timeouts and connection resets');
  });

  it.each([
    'chaos-proxy --target <url> [options]',
    'chaos-proxy --config <path> [options]',
    'chaos-proxy [options]',
  ])('offers the %j invocation', (usage) => {
    expect(HELP_TEXT).toContain(usage);
  });

  it('says that ./chaos.yml is picked up on its own, where a beginner will see it', () => {
    expect(HELP_TEXT).toContain('auto-loads ./chaos.yml when present');
    expect(HELP_TEXT).toContain('A ./chaos.yml in the\ncurrent directory is loaded automatically');
  });

  it.each([
    '--target <url>',
    '--port <1-65535>',
    '--config <path>',
    '--preset <name>',
    '--seed <value>',
    '--print-config',
    '--quiet',
    '--latency <ms>',
    '--error-rate <0-1>',
    '--error-status <400-599>',
    '--timeout-rate <0-1>',
    '--timeout <ms>',
    '--reset-rate <0-1>',
    '-h, --help',
    '-v, --version',
  ])('documents %s', (option) => {
    expect(HELP_TEXT).toContain(option);
  });

  it('groups the options by what a reader is choosing between', () => {
    expect(HELP_TEXT).toContain('Core options:');
    expect(HELP_TEXT).toContain('Chaos options:');
    expect(HELP_TEXT).toContain('Presets:');
    expect(HELP_TEXT).toContain('Other:');
  });

  it.each(['slow-api', 'flaky-api', 'timeout-heavy', 'backend-down'])(
    'lists the %s preset',
    (name) => {
      expect(HELP_TEXT).toContain(name);
    },
  );

  it('shows short examples that can be typed as they stand', () => {
    expect(HELP_TEXT).toContain('Examples:');
    expect(HELP_TEXT).toContain('chaos-proxy --target http://localhost:3000\n');
    expect(HELP_TEXT).toContain('chaos-proxy --target http://localhost:3000 --preset flaky-api');
    expect(HELP_TEXT).toContain('--error-rate 0.2 --seed test-run');
    expect(HELP_TEXT).toContain('chaos-proxy --print-config');
    // A continuation is a shell detail, and pasted into the wrong one it breaks.
    expect(HELP_TEXT).not.toContain('\\\n');
  });

  // Help someone scrolls is help someone stops reading. The numbers are room to
  // work in, not a target: they only fail a help text that has become a manual.
  it('stays short enough to read in one screenful or two', () => {
    const lines = HELP_TEXT.split('\n');

    expect(lines.length).toBeLessThanOrEqual(60);
    expect(Math.max(...lines.map((line) => line.length))).toBeLessThanOrEqual(80);
  });

  // Alignment is done with spaces, so it survives a pipe, a log file and a
  // terminal that knows nothing about escape sequences.
  it('needs no colour to be readable', () => {
    // eslint-disable-next-line no-control-regex
    expect(HELP_TEXT).not.toMatch(/\u001B\[/);
  });
});

describe('numeric flag errors', () => {
  it.each([
    [['--port', '0'], 'Invalid --port "0".', 'Expected an integer between 1 and 65535.'],
    [['--port', 'abc'], 'Invalid --port "abc".', 'Expected an integer between 1 and 65535.'],
    [['--latency', 'abc'], 'Invalid --latency "abc".', 'Expected a number.'],
    [['--error-rate', 'abc'], 'Invalid --error-rate "abc".', 'Expected a number.'],
    [['--timeout', 'soon'], 'Invalid --timeout "soon".', 'Expected a number.'],
    [['--reset-rate', 'often'], 'Invalid --reset-rate "often".', 'Expected a number.'],
  ])('reports %j as a problem and one expectation', (args, problem, hint) => {
    const argv = ['--target', TARGET, ...args];

    expect(() => parseCliArgs(argv)).toThrow(problem);
    expect(hintFor(argv)).toBe(hint);
  });

  // Text that is not a number and a number out of range are the same mistake to
  // the reader, so they are answered with the same sentence.
  it('tells a --port of any shape what a port is', () => {
    for (const port of ['0', '65536', '4000.5', 'abc', '']) {
      expect(hintFor(['--target', TARGET, '--port', port])).toBe(
        'Expected an integer between 1 and 65535.',
      );
    }
  });
});

describe('parse errors', () => {
  it.each([
    [['--erro-rate', '0.5'], 'Unknown option --erro-rate.'],
    [['--erro-rate=0.5'], 'Unknown option --erro-rate.'],
    [['-x'], 'Unknown option -x.'],
    [['--target'], 'Missing value for --target.'],
  ])("reports %j in the CLI's own voice", (argv, message) => {
    expect(() => parseCliArgs(argv)).toThrow(CliError);
    expect(() => parseCliArgs(argv)).toThrow(message);
  });

  it('points an unknown option at the help', () => {
    expect(hintFor(['--erro-rate', '0.5'])).toBe('Run `chaos-proxy --help` for usage.');
  });

  it('names a positional argument and says the CLI takes none', () => {
    expect(() => parseCliArgs([TARGET])).toThrow('Unexpected argument "http://localhost:3000".');
    expect(hintFor([TARGET])).toContain('takes options only');
  });

  // Node words these for a library's caller: quoted flags, no full stops, and
  // three lines of advice about dashes. None of that should reach a terminal.
  it.each([['--erro-rate', '0.5'], ['--target'], ['--latency', '-1'], [TARGET]])(
    'leaves no parser wording in %j',
    (...argv) => {
      let thrown: unknown;

      try {
        parseCliArgs(argv);
      } catch (error) {
        thrown = error;
      }

      const message = thrown instanceof Error ? thrown.message : String(thrown);

      expect(message).not.toContain('\n');
      expect(message).not.toContain("'");
      expect(message.endsWith('.')).toBe(true);
      expect(message).not.toContain('    at ');
    },
  );
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
    expect(() => parseCliArgs(argv)).toThrow('Unknown preset "terrible-network".');
    expect(hintFor(argv)).toBe(
      'Available presets: slow-api, flaky-api, timeout-heavy, backend-down.',
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

  it('says that a typed flag still beats a preset', () => {
    expect(HELP_TEXT).toContain(
      'A preset is a starting point, so an explicit chaos flag still wins',
    );
  });
});
