import { describe, expect, it } from 'vitest';

import { CliError, DEFAULT_PORT, inFlagTerms, parseCliArgs } from '../../src/cli/options.js';

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
  it('needs only a target, and defaults the port', () => {
    const command = parseRun(['--target', TARGET]);

    expect(command.port).toBe(DEFAULT_PORT);
    expect(command.proxy).toEqual({ target: TARGET });
  });

  it('accepts the --option=value form', () => {
    expect(parseRun([`--target=${TARGET}`]).proxy.target).toBe(TARGET);
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
    ]);

    expect(command.port).toBe(4100);
    expect(command.proxy).toEqual({
      target: TARGET,
      latencyMs: 500,
      errorRate: 0.2,
      errorStatus: 503,
      timeoutRate: 0.1,
      timeoutMs: 3000,
    });
  });

  it('leaves options that were not given off entirely, so the core defaults apply', () => {
    const command = parseRun(['--target', TARGET, '--error-rate', '0.5']);

    expect(command.proxy).toEqual({ target: TARGET, errorRate: 0.5 });
    expect('errorStatus' in command.proxy).toBe(false);
    expect('latencyMs' in command.proxy).toBe(false);
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
    expect(parseRun(['--target', 'localhost:3000']).proxy.target).toBe('localhost:3000');
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

  it('never edits a value quoted inside the message', () => {
    const message = 'Invalid errorStatus 200: seen at "http://api.timeout.example.com".';

    expect(inFlagTerms(message)).toBe(
      'Invalid --error-status 200: seen at "http://api.timeout.example.com".',
    );
  });
});
