import { describe, expect, it } from 'vitest';

import { ConfigError, isValidPort, parseConfig } from '../../src/config/schema.js';

/**
 * These tests drive `parseConfig` with already-parsed documents rather than
 * YAML text, so they describe what the schema accepts without also depending on
 * how a file is read. Reading and YAML parsing are covered in `load.test.ts`.
 */

const TARGET = 'http://localhost:3000';

describe('parseConfig', () => {
  it('accepts a minimal config of nothing but a target', () => {
    expect(parseConfig({ target: TARGET })).toEqual({
      target: TARGET,
      port: undefined,
      defaults: {},
      rules: [],
    });
  });

  it('accepts a full config', () => {
    const config = parseConfig({
      target: TARGET,
      port: 4000,
      defaults: {
        latencyMs: 100,
        errorRate: 0.1,
        errorStatus: 500,
        timeoutRate: 0.05,
        timeoutMs: 3000,
        resetRate: 0.01,
      },
      rules: [
        { match: '/api/payments/*', latencyMs: 500, errorRate: 0.5, errorStatus: 503 },
        { match: '/api/search', timeoutRate: 1, timeoutMs: 2000 },
        { match: '/api/upload/*', resetRate: 1 },
      ],
    });

    expect(config).toEqual({
      target: TARGET,
      port: 4000,
      defaults: {
        latencyMs: 100,
        errorRate: 0.1,
        errorStatus: 500,
        timeoutRate: 0.05,
        timeoutMs: 3000,
        resetRate: 0.01,
      },
      rules: [
        { match: '/api/payments/*', chaos: { latencyMs: 500, errorRate: 0.5, errorStatus: 503 } },
        { match: '/api/search', chaos: { timeoutRate: 1, timeoutMs: 2000 } },
        { match: '/api/upload/*', chaos: { resetRate: 1 } },
      ],
    });
  });

  it('accepts a config with no target, leaving --target to supply one', () => {
    expect(parseConfig({ rules: [{ match: '/api/*', errorRate: 1 }] }).target).toBeUndefined();
  });

  it('keeps rules in the order they were written', () => {
    const config = parseConfig({
      target: TARGET,
      rules: [{ match: '/a' }, { match: '/b' }, { match: '/c' }],
    });

    expect(config.rules.map((rule) => rule.match)).toEqual(['/a', '/b', '/c']);
  });

  it.each([[null], ['target: x'], [42], [[]], [true]])(
    'rejects a document of %j that is not a mapping',
    (document) => {
      expect(() => parseConfig(document)).toThrow(ConfigError);
      expect(() => parseConfig(document)).toThrow(/must contain a YAML mapping/);
    },
  );

  it('rejects an unknown top-level field', () => {
    expect(() => parseConfig({ target: TARGET, foo: 1 })).toThrow(
      'Invalid config: unknown field "foo". Known fields: target, port, defaults, rules.',
    );
  });

  // A misspelled field that is quietly ignored looks exactly like chaos that
  // does not work, which is a far worse way to find out.
  it('rejects a near-miss spelling rather than ignoring it', () => {
    expect(() => parseConfig({ target: TARGET, rule: [] })).toThrow(/unknown field "rule"/);
  });

  it('rejects a "logging" section, offering the fields that do exist', () => {
    expect(() => parseConfig({ target: TARGET, logging: { level: 'debug' } })).toThrow(
      'Invalid config: unknown field "logging". Known fields: target, port, defaults, rules.',
    );
  });

  /**
   * Every message says where the problem is before it says what it is, so the
   * line to look at can be found without re-reading the whole file.
   */
  it.each([
    [{ target: TARGET, defaults: { errorRate: 5 } }, 'defaults.errorRate'],
    [{ target: TARGET, defaults: { resetRate: 5 } }, 'defaults.resetRate'],
    [{ target: TARGET, defaults: { latency: 1 } }, 'defaults contains unknown field'],
    [
      { target: TARGET, rules: [{ match: '/a' }, { match: '/b', timeoutRate: 5 }] },
      'rules[1].timeoutRate',
    ],
    [
      { target: TARGET, rules: [{ match: '/a' }, { match: '/b' }, { match: 'c' }] },
      'rules[2].match',
    ],
    [{ target: TARGET, rules: [{ match: '/a', foo: 1 }] }, 'rules[0] contains unknown field'],
    [{ target: TARGET, port: 0 }, 'port'],
  ])('says where the problem is in %j', (document, path) => {
    expect(() => parseConfig(document)).toThrow(ConfigError);
    expect(() => parseConfig(document)).toThrow(path);
  });

  describe('target', () => {
    it.each([[42], [null], [{}], [['a']]])('rejects a target of %j', (target) => {
      expect(() => parseConfig({ target })).toThrow(
        'Invalid config: target must be a string, for example "http://localhost:3000".',
      );
    });

    it('rejects an empty target', () => {
      expect(() => parseConfig({ target: '' })).toThrow(/target must not be empty/);
    });

    // The proxy core is the authority on what a usable target is, so the schema
    // deliberately lets this through rather than keeping a second copy.
    it('leaves a target that is not a URL to the proxy core', () => {
      expect(parseConfig({ target: 'localhost:3000' }).target).toBe('localhost:3000');
    });
  });

  describe('port', () => {
    it.each([1, 4000, 65_535])('accepts a port of %p', (port) => {
      expect(parseConfig({ target: TARGET, port }).port).toBe(port);
    });

    it.each([0, -1, 65_536, 4000.5, '4000', null])('rejects a port of %j', (port) => {
      expect(() => parseConfig({ target: TARGET, port })).toThrow(
        'Invalid config: port must be an integer between 1 and 65535.',
      );
    });

    it('uses the same range as --port', () => {
      expect(isValidPort(0)).toBe(false);
      expect(isValidPort(1)).toBe(true);
      expect(isValidPort(65_535)).toBe(true);
      expect(isValidPort(65_536)).toBe(false);
      expect(isValidPort(4000.5)).toBe(false);
    });
  });

  describe('defaults', () => {
    it('treats an absent defaults block as no defaults', () => {
      expect(parseConfig({ target: TARGET }).defaults).toEqual({});
    });

    it('accepts a partial defaults block, leaving the rest to the core', () => {
      expect(parseConfig({ target: TARGET, defaults: { latencyMs: 100 } }).defaults).toEqual({
        latencyMs: 100,
      });
    });

    it.each([[null], [[]], ['latencyMs: 100'], [5]])(
      'rejects a defaults block of %j',
      (defaults) => {
        expect(() => parseConfig({ target: TARGET, defaults })).toThrow(
          'Invalid config: defaults must be a mapping of chaos settings, such as "latencyMs: 250".',
        );
      },
    );

    it('rejects an unknown field inside defaults', () => {
      expect(() => parseConfig({ target: TARGET, defaults: { latency: 100 } })).toThrow(
        'Invalid config: defaults contains unknown field "latency". Known fields: latencyMs, errorRate, errorStatus, timeoutRate, timeoutMs, resetRate.',
      );
    });

    it.each([['100'], [null], [true], [{}]])('rejects a latencyMs of %j', (latencyMs) => {
      expect(() => parseConfig({ target: TARGET, defaults: { latencyMs } })).toThrow(
        'Invalid config: defaults.latencyMs must be a number.',
      );
    });

    // Range checking is delegated to the proxy core, so the config file can
    // never accept a value the programmatic API rejects.
    it.each([
      [{ errorRate: 5 }, /defaults\.errorRate 5: expected a number between 0 and 1/],
      [{ errorRate: -0.1 }, /defaults\.errorRate/],
      [{ timeoutRate: 1.5 }, /defaults\.timeoutRate/],
      [{ errorStatus: 200 }, /defaults\.errorStatus 200: expected an integer HTTP error status/],
      [{ errorStatus: 500.5 }, /defaults\.errorStatus/],
      [{ latencyMs: -1 }, /defaults\.latencyMs -1: expected a finite number of milliseconds/],
      [{ timeoutMs: -1 }, /defaults\.timeoutMs/],
      [{ latencyMs: Number.NaN }, /defaults\.latencyMs/],
      [{ timeoutMs: Number.POSITIVE_INFINITY }, /defaults\.timeoutMs/],
      [{ resetRate: 5 }, /defaults\.resetRate 5: expected a number between 0 and 1/],
      [{ resetRate: -0.1 }, /defaults\.resetRate/],
      [{ resetRate: Number.NaN }, /defaults\.resetRate/],
      [{ resetRate: Number.POSITIVE_INFINITY }, /defaults\.resetRate/],
    ])('rejects defaults of %j', (defaults, expected) => {
      expect(() => parseConfig({ target: TARGET, defaults })).toThrow(ConfigError);
      expect(() => parseConfig({ target: TARGET, defaults })).toThrow(expected);
    });
  });

  describe('rules', () => {
    it('treats an absent rules list as no rules', () => {
      expect(parseConfig({ target: TARGET }).rules).toEqual([]);
    });

    it('accepts an empty rules list', () => {
      expect(parseConfig({ target: TARGET, rules: [] }).rules).toEqual([]);
    });

    it('accepts a rule that only matches, adding no chaos of its own', () => {
      expect(parseConfig({ target: TARGET, rules: [{ match: '/api/health' }] }).rules).toEqual([
        { match: '/api/health', chaos: {} },
      ]);
    });

    it.each([[null], [{}], ['/api/*'], [5]])('rejects a rules value of %j', (rules) => {
      expect(() => parseConfig({ target: TARGET, rules })).toThrow(
        'Invalid config: rules must be a list of rules, each of them a mapping with a "match".',
      );
    });

    it.each([[null], ['/api/*'], [5], [[]]])('rejects a rule entry of %j', (rule) => {
      expect(() => parseConfig({ target: TARGET, rules: [rule] })).toThrow(
        'Invalid config: rules[0] must be a mapping with a "match" field.',
      );
    });

    it('rejects a rule with no match', () => {
      expect(() => parseConfig({ target: TARGET, rules: [{ errorRate: 1 }] })).toThrow(
        'Invalid config: rules[0] is missing the required "match" field.',
      );
    });

    it.each([[42], [null], [['/a']]])('rejects a match of %j', (match) => {
      expect(() => parseConfig({ target: TARGET, rules: [{ match }] })).toThrow(
        'Invalid config: rules[0].match must be a string.',
      );
    });

    it('rejects an unknown field inside a rule', () => {
      expect(() =>
        parseConfig({ target: TARGET, rules: [{ match: '/a' }, { match: '/b', method: 'GET' }] }),
      ).toThrow(
        'Invalid config: rules[1] contains unknown field "method". Known fields: match, latencyMs, errorRate, errorStatus, timeoutRate, timeoutMs, resetRate.',
      );
    });

    it.each([
      ['api/users', /must start with "\/"/],
      ['', /must start with "\/"/],
      ['/api/*/details', /trailing "\/\*" wildcard/],
      ['/api/**', /trailing "\/\*" wildcard/],
      ['/api/*x', /trailing "\/\*" wildcard/],
      ['/api*', /trailing "\/\*" wildcard/],
      ['/api/search?q=test', /without a query string or fragment/],
      ['/api/search#top', /without a query string or fragment/],
    ])('rejects a match pattern of %j', (match, expected) => {
      expect(() => parseConfig({ target: TARGET, rules: [{ match }] })).toThrow(ConfigError);
      expect(() => parseConfig({ target: TARGET, rules: [{ match }] })).toThrow(expected);
    });

    it.each(['/', '/*', '/api/search', '/api/payments/*', '/a-b_c.d/*'])(
      'accepts a match pattern of %j',
      (match) => {
        expect(() => parseConfig({ target: TARGET, rules: [{ match }] })).not.toThrow();
      },
    );

    it('names the offending rule by index', () => {
      expect(() =>
        parseConfig({
          target: TARGET,
          rules: [{ match: '/ok' }, { match: '/api/payments/*', errorRate: 5 }],
        }),
      ).toThrow(
        'Invalid config: rules[1].errorRate 5: expected a number between 0 and 1 inclusive.',
      );
    });

    it.each([
      [{ errorStatus: 200 }, /rules\[0\]\.errorStatus/],
      [{ timeoutRate: -1 }, /rules\[0\]\.timeoutRate/],
      [{ latencyMs: Number.NaN }, /rules\[0\]\.latencyMs/],
      [{ resetRate: 1.5 }, /rules\[0\]\.resetRate/],
      [{ resetRate: Number.NEGATIVE_INFINITY }, /rules\[0\]\.resetRate/],
    ])('rejects invalid chaos %j inside a rule', (chaos, expected) => {
      expect(() => parseConfig({ target: TARGET, rules: [{ match: '/a', ...chaos }] })).toThrow(
        expected,
      );
    });

    it('accepts a resetRate on a rule of its own', () => {
      expect(parseConfig({ target: TARGET, rules: [{ match: '/reset/*', resetRate: 1 }] })).toEqual(
        {
          target: TARGET,
          port: undefined,
          defaults: {},
          rules: [{ match: '/reset/*', chaos: { resetRate: 1 } }],
        },
      );
    });

    it('rejects a resetRate of the wrong type inside a rule', () => {
      expect(() =>
        parseConfig({ target: TARGET, rules: [{ match: '/a', resetRate: '1' }] }),
      ).toThrow('Invalid config: rules[0].resetRate must be a number.');
    });

    it('rejects a chaos value of the wrong type inside a rule', () => {
      expect(() =>
        parseConfig({ target: TARGET, rules: [{ match: '/a', errorRate: 'high' }] }),
      ).toThrow('Invalid config: rules[0].errorRate must be a number.');
    });
  });
});
