import { describe, expect, it } from 'vitest';

import { createSeededRandom } from '../../src/random/seeded.js';

/**
 * The point of a seed is that a run can be replayed, so the generator's output
 * is behaviour rather than an implementation detail: the sequence below is
 * pinned exactly. Changing the hash or the PRNG changes what every existing
 * seed means, and these tests are what makes that a deliberate decision rather
 * than something noticed a release later.
 *
 * Nothing here is statistical. Distribution is not what the tool promises; the
 * same numbers in the same order is.
 */

/** The first values `createSeededRandom('checkout-test')` must produce. */
const CHECKOUT_TEST_SEQUENCE = [
  0.9149247540626675, 0.9164127723779529, 0.42643510457128286, 0.9252270231954753,
  0.5843561536166817, 0.9666832860093564, 0.9312812681309879, 0.014288940699771047,
  0.49997993651777506, 0.10498674027621746, 0.6727969162166119, 0.2699920767918229,
  0.37603607261553407, 0.2992875447962433, 0.4736368637531996, 0.587068100925535,
];

/** Draws `count` values from a generator seeded with `seed`. */
function draw(seed: string, count: number): number[] {
  const random = createSeededRandom(seed);

  return Array.from({ length: count }, () => random());
}

describe('createSeededRandom', () => {
  it('produces the pinned sequence for a known seed', () => {
    expect(draw('checkout-test', CHECKOUT_TEST_SEQUENCE.length)).toEqual(CHECKOUT_TEST_SEQUENCE);
  });

  it('replays the same sequence for the same seed', () => {
    expect(draw('checkout-test', 16)).toEqual(draw('checkout-test', 16));
  });

  it('advances, rather than repeating one value', () => {
    const values = draw('checkout-test', 16);

    expect(new Set(values).size).toBe(values.length);
  });

  it('gives different seeds different sequences', () => {
    expect(draw('checkout-test', 8)).not.toEqual(draw('other-seed', 8));
  });

  it('treats seeds that differ by one character as different seeds', () => {
    expect(draw('a', 8)).not.toEqual(draw('b', 8));
    expect(draw('12345', 8)).not.toEqual(draw('12346', 8));
  });

  it('does not normalise case or surrounding whitespace', () => {
    expect(draw('checkout-test', 4)).not.toEqual(draw('Checkout-Test', 4));
    expect(draw('checkout-test', 4)).not.toEqual(draw(' checkout-test ', 4));
  });

  it('accepts any non-empty string, numeric-looking or not', () => {
    for (const seed of ['12345', 'abc', 'checkout-test', '/', '☕']) {
      expect(draw(seed, 4)).toEqual(draw(seed, 4));
    }
  });

  it('only ever yields values in [0, 1)', () => {
    for (const seed of ['checkout-test', '12345', 'abc', 'other-seed']) {
      for (const value of draw(seed, 500)) {
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThan(1);
      }
    }
  });

  it('rejects an empty seed rather than silently fixing a run', () => {
    expect(() => createSeededRandom('')).toThrow(TypeError);
    expect(() => createSeededRandom('')).toThrow('non-empty string');
  });

  it('gives each generator its own state', () => {
    const first = createSeededRandom('checkout-test');
    const second = createSeededRandom('checkout-test');

    first();
    first();

    // Draws from `first` did not advance `second`.
    expect(second()).toBe(CHECKOUT_TEST_SEQUENCE[0]);
  });
});
