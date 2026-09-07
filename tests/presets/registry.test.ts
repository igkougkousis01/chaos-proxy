import { describe, expect, it } from 'vitest';

import {
  PRESETS,
  PRESET_HELP,
  PRESET_LIST,
  PRESET_NAMES,
  isPresetName,
  presetChaos,
} from '../../src/presets/index.js';
import { resolveChaosOptions } from '../../src/proxy/server.js';
import type { ChaosOptions } from '../../src/proxy/server.js';

/**
 * The registry is the whole of what a preset is, so these tests pin the values
 * themselves rather than only the machinery around them: a preset whose numbers
 * drift is a preset that quietly stops meaning what it is documented to mean.
 */

/** The chaos each preset is defined to contribute, and nothing besides. */
const EXPECTED: Readonly<Record<string, ChaosOptions>> = {
  'slow-api': { latencyMs: 1000 },
  'flaky-api': { errorRate: 0.25, errorStatus: 503 },
  'timeout-heavy': { timeoutRate: 0.3, timeoutMs: 3000 },
  'backend-down': { errorRate: 1, errorStatus: 503 },
};

describe('the preset registry', () => {
  it('holds exactly the four built-in presets', () => {
    expect(PRESET_NAMES).toEqual(['slow-api', 'flaky-api', 'timeout-heavy', 'backend-down']);
    expect(Object.keys(PRESETS)).toEqual([...PRESET_NAMES]);
  });

  it.each(Object.entries(EXPECTED))('defines %s as exactly its documented chaos', (name, chaos) => {
    expect(presetChaos(name as (typeof PRESET_NAMES)[number])).toEqual(chaos);
  });

  // A preset that reset unrelated settings would stop being a starting point
  // and become a mode; only the fields its scenario is about may be present.
  it.each(Object.entries(EXPECTED))(
    'leaves every field %s does not define absent',
    (name, chaos) => {
      expect(Object.keys(presetChaos(name as (typeof PRESET_NAMES)[number])).sort()).toEqual(
        Object.keys(chaos).sort(),
      );
    },
  );

  it('gives every preset a one-line summary for the help output', () => {
    for (const name of PRESET_NAMES) {
      expect(PRESETS[name].summary).not.toBe('');
      expect(PRESETS[name].summary).not.toContain('\n');
    }
  });

  it('contributes nothing at all when no preset was asked for', () => {
    expect(presetChaos(undefined)).toEqual({});
  });
});

describe('preset validity', () => {
  // The proxy core is the single authority on what a rate, duration or status
  // may be, so a built-in preset is held to exactly the rules a typed flag or a
  // config file value is. This is what stops an invalid preset ever shipping.
  it.each([...PRESET_NAMES])('passes %s through the proxy core validator', (name) => {
    expect(() => resolveChaosOptions(presetChaos(name))).not.toThrow();
  });

  it('resolves flaky-api to the effective chaos the proxy would apply', () => {
    expect(resolveChaosOptions(presetChaos('flaky-api'))).toEqual({
      latencyMs: 0,
      errorRate: 0.25,
      errorStatus: 503,
      timeoutRate: 0,
      timeoutMs: 30_000,
    });
  });
});

describe('preset immutability', () => {
  it('hands out a copy, so layering flags over one cannot edit the registry', () => {
    const chaos = presetChaos('flaky-api') as { errorRate: number };
    chaos.errorRate = 0.9;

    expect(presetChaos('flaky-api')).toEqual({ errorRate: 0.25, errorStatus: 503 });
  });

  it('freezes the definitions themselves', () => {
    expect(Object.isFrozen(PRESETS)).toBe(true);

    for (const name of PRESET_NAMES) {
      expect(Object.isFrozen(PRESETS[name])).toBe(true);
      expect(Object.isFrozen(PRESETS[name].chaos)).toBe(true);
    }
  });
});

describe('isPresetName', () => {
  it.each([...PRESET_NAMES])('recognises %s', (name) => {
    expect(isPresetName(name)).toBe(true);
  });

  it.each(['terrible-network', '', 'SLOW-API', 'slow', 'toString'])('rejects %j', (value) => {
    expect(isPresetName(value)).toBe(false);
  });
});

describe('how presets are listed to the user', () => {
  it('names every preset in the help block, in registry order', () => {
    const lines = PRESET_HELP.split('\n');

    expect(lines).toHaveLength(PRESET_NAMES.length);
    lines.forEach((line, index) => {
      expect(line.trim().startsWith(PRESET_NAMES[index] ?? '')).toBe(true);
    });
  });

  it('describes each preset with its own summary', () => {
    for (const name of PRESET_NAMES) {
      expect(PRESET_HELP).toContain(PRESETS[name].summary);
    }
  });

  it('offers every name in the list a wrong guess is corrected with', () => {
    expect(PRESET_LIST).toBe('slow-api, flaky-api, timeout-heavy, backend-down');
  });
});
