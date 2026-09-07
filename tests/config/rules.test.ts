import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';

import { loadConfigFile } from '../../src/config/load.js';
import {
  baseChaos,
  createChaosResolver,
  describeMatchPattern,
  effectiveRules,
  matchesPattern,
} from '../../src/config/rules.js';
import { parseConfig } from '../../src/config/schema.js';
import type { ChaosConfig } from '../../src/config/schema.js';
import type { ChaosOptions } from '../../src/index.js';

/** Just enough of a request for the resolver, which only reads the URL. */
function requestFor(url: string): IncomingMessage {
  return { url } as IncomingMessage;
}

/** The chaos the config would apply to a request for `url`. */
function chaosFor(config: ChaosConfig, url: string, overrides: ChaosOptions = {}): ChaosOptions {
  const resolve = createChaosResolver(
    effectiveRules(config, overrides),
    baseChaos(config, overrides),
  );

  return resolve(requestFor(url));
}

describe('describeMatchPattern', () => {
  it.each(['/', '/*', '/api/search', '/api/payments/*', '/api/v2/users'])(
    'accepts %j',
    (pattern) => {
      expect(describeMatchPattern(pattern)).toBeUndefined();
    },
  );

  it.each(['api/users', '', 'http://example.com/api'])('rejects %j as not a path', (pattern) => {
    expect(describeMatchPattern(pattern)).toMatch(/must start with "\/"/);
  });

  it.each(['/api/*/details', '/api/**', '/*/x', '/api*'])(
    'rejects %j as an unsupported wildcard',
    (pattern) => {
      expect(describeMatchPattern(pattern)).toMatch(/trailing "\/\*" wildcard/);
    },
  );

  it.each(['/api/search?q=test', '/api/search#top'])('rejects %j as not a bare path', (pattern) => {
    expect(describeMatchPattern(pattern)).toMatch(/without a query string or fragment/);
  });
});

describe('matchesPattern', () => {
  describe('an exact pattern', () => {
    it('matches only that exact path', () => {
      expect(matchesPattern('/api/search', '/api/search')).toBe(true);
    });

    it.each(['/api/search/advanced', '/api/searching', '/api/searc', '/api/Search', '/'])(
      'does not match %j',
      (pathname) => {
        expect(matchesPattern('/api/search', pathname)).toBe(false);
      },
    );
  });

  describe('a trailing wildcard pattern', () => {
    it.each(['/api/payments/', '/api/payments/123', '/api/payments/refunds/456'])(
      'matches %j',
      (pathname) => {
        expect(matchesPattern('/api/payments/*', pathname)).toBe(true);
      },
    );

    // The wildcard stands for a path segment below the prefix, so the bare
    // parent is a different path and is left to a rule of its own.
    it.each(['/api/payments', '/api/paymentsx/1', '/api/', '/'])(
      'does not match %j',
      (pathname) => {
        expect(matchesPattern('/api/payments/*', pathname)).toBe(false);
      },
    );

    it('matches everything when it is just "/*"', () => {
      expect(matchesPattern('/*', '/')).toBe(true);
      expect(matchesPattern('/*', '/anything/at/all')).toBe(true);
    });
  });
});

describe('rule selection', () => {
  it('applies the rule that matches the request path', () => {
    const config = parseConfig({
      rules: [{ match: '/api/payments/*', errorRate: 1, errorStatus: 503 }],
    });

    expect(chaosFor(config, '/api/payments/123')).toEqual({ errorRate: 1, errorStatus: 503 });
  });

  it('ignores the query string when choosing a rule', () => {
    const config = parseConfig({ rules: [{ match: '/api/search', timeoutRate: 1 }] });

    expect(chaosFor(config, '/api/search?q=test')).toEqual({ timeoutRate: 1 });
    expect(chaosFor(config, '/api/search?q=test&page=2')).toEqual({ timeoutRate: 1 });
  });

  it('does not let a longer path match a shorter exact rule', () => {
    const config = parseConfig({ rules: [{ match: '/api/search', errorRate: 1 }] });

    expect(chaosFor(config, '/api/searching')).toEqual({});
    expect(chaosFor(config, '/api/search/advanced')).toEqual({});
  });

  // Ordered rules can be read top to bottom; specificity scoring cannot.
  it('uses the first matching rule, not the most specific one', () => {
    const config = parseConfig({
      rules: [
        { match: '/api/*', errorRate: 0.1 },
        { match: '/api/payments/*', errorRate: 1 },
      ],
    });

    expect(chaosFor(config, '/api/payments/123')).toEqual({ errorRate: 0.1 });
  });

  it('reaches a later rule when the earlier ones do not match', () => {
    const config = parseConfig({
      rules: [
        { match: '/api/payments/*', errorRate: 1 },
        { match: '/api/*', errorRate: 0.1 },
      ],
    });

    expect(chaosFor(config, '/api/payments/123')).toEqual({ errorRate: 1 });
    expect(chaosFor(config, '/api/users')).toEqual({ errorRate: 0.1 });
  });

  it('never combines two matching rules', () => {
    const config = parseConfig({
      rules: [
        { match: '/api/*', latencyMs: 100 },
        { match: '/api/payments/*', errorRate: 1 },
      ],
    });

    expect(chaosFor(config, '/api/payments/1')).toEqual({ latencyMs: 100 });
  });

  it('falls back to the defaults when nothing matches', () => {
    const config = parseConfig({
      defaults: { latencyMs: 100 },
      rules: [{ match: '/api/payments/*', errorRate: 1 }],
    });

    expect(chaosFor(config, '/static/logo.png')).toEqual({ latencyMs: 100 });
  });

  it('treats a request with no URL as matching nothing', () => {
    const config = parseConfig({ defaults: { latencyMs: 100 }, rules: [{ match: '/*' }] });
    const resolve = createChaosResolver(effectiveRules(config, {}), baseChaos(config, {}));

    // `/*` still matches the "/" a URL-less request falls back to.
    expect(resolve({} as IncomingMessage)).toEqual({ latencyMs: 100 });
  });
});

describe('merging defaults with a rule', () => {
  it('overrides only the fields the rule names', () => {
    const config = parseConfig({
      defaults: { latencyMs: 100, errorRate: 0.1, errorStatus: 500 },
      rules: [{ match: '/api/payments/*', errorRate: 1, errorStatus: 503 }],
    });

    expect(chaosFor(config, '/api/payments/123')).toEqual({
      latencyMs: 100,
      errorRate: 1,
      errorStatus: 503,
    });
  });

  it('does not reset a default the rule says nothing about', () => {
    const config = parseConfig({
      defaults: { latencyMs: 100, timeoutMs: 3000 },
      rules: [{ match: '/api/search', timeoutRate: 1 }],
    });

    expect(chaosFor(config, '/api/search')).toEqual({
      latencyMs: 100,
      timeoutMs: 3000,
      timeoutRate: 1,
    });
  });

  it('lets a rule turn a default off explicitly', () => {
    const config = parseConfig({
      defaults: { errorRate: 1 },
      rules: [{ match: '/health', errorRate: 0 }],
    });

    expect(chaosFor(config, '/health')).toEqual({ errorRate: 0 });
  });

  it('leaves the defaults untouched for a request that matches a rule', () => {
    const config = parseConfig({
      defaults: { latencyMs: 100 },
      rules: [{ match: '/api/*', latencyMs: 500 }],
    });

    expect(chaosFor(config, '/api/x')).toEqual({ latencyMs: 500 });
    expect(chaosFor(config, '/other')).toEqual({ latencyMs: 100 });
    expect(config.defaults).toEqual({ latencyMs: 100 });
  });
});

describe('command-line overrides', () => {
  it('beats a config default', () => {
    const config = parseConfig({ defaults: { latencyMs: 100 } });

    expect(chaosFor(config, '/anything', { latencyMs: 500 })).toEqual({ latencyMs: 500 });
  });

  // A flag typed on the spot is the final word, including inside a rule.
  it('beats a matching rule', () => {
    const config = parseConfig({ rules: [{ match: '/api/payments/*', errorRate: 1 }] });

    expect(chaosFor(config, '/api/payments/123', { errorRate: 0 })).toEqual({ errorRate: 0 });
  });

  it('leaves rule fields it says nothing about alone', () => {
    const config = parseConfig({
      rules: [{ match: '/api/payments/*', errorRate: 1, errorStatus: 503 }],
    });

    expect(chaosFor(config, '/api/payments/123', { latencyMs: 250 })).toEqual({
      errorRate: 1,
      errorStatus: 503,
      latencyMs: 250,
    });
  });
});

describe('effectiveRules', () => {
  it('keeps the rules in file order, with their patterns', () => {
    const config = parseConfig({
      defaults: { latencyMs: 100 },
      rules: [
        { match: '/api/payments/*', errorRate: 1 },
        { match: '/api/search', timeoutRate: 1 },
      ],
    });

    expect(effectiveRules(config, {})).toEqual([
      { match: '/api/payments/*', chaos: { latencyMs: 100, errorRate: 1 } },
      { match: '/api/search', chaos: { latencyMs: 100, timeoutRate: 1 } },
    ]);
  });

  it('is empty for a config with no rules', () => {
    expect(effectiveRules(parseConfig({ target: 'http://localhost:3000' }), {})).toEqual([]);
  });
});

describe('the documented example config', () => {
  it('behaves as the README describes', () => {
    const config = loadConfigFile('examples/chaos.yml').config;

    expect(config.target).toBe('http://localhost:3000');
    expect(chaosFor(config, '/api/payments/123')).toMatchObject({
      latencyMs: 100,
      errorRate: 1,
      errorStatus: 503,
    });
    expect(chaosFor(config, '/api/search?q=test')).toMatchObject({
      latencyMs: 100,
      timeoutRate: 1,
      timeoutMs: 2000,
    });
    expect(chaosFor(config, '/api/upload/avatar.png')).toMatchObject({
      latencyMs: 100,
      resetRate: 1,
    });
    expect(chaosFor(config, '/api/users')).toEqual({ latencyMs: 100 });
  });
});
