/**
 * A deterministic replacement for `Math.random()`, derived from a seed string.
 *
 * The proxy core takes its randomness as a plain `() => number`, so nothing
 * outside this file knows how the numbers are produced. That is the whole point
 * of keeping it here: the algorithm is an implementation detail of the seeded
 * mode, not something the rest of the tool reasons about.
 */

/** FNV-1a's 32-bit offset basis. */
const FNV_OFFSET_BASIS = 0x811c9dc5;

/** FNV-1a's 32-bit prime. */
const FNV_PRIME = 0x01000193;

/** Mulberry32's step constant, added to the state on every draw. */
const MULBERRY32_INCREMENT = 0x6d2b79f5;

/** `2 ** 32`, used to scale a 32-bit integer into `[0, 1)`. */
const UINT32_RANGE = 4_294_967_296;

/**
 * Hashes a seed string to a 32-bit integer, using FNV-1a over the string's
 * UTF-16 code units, low byte first.
 *
 * FNV-1a is chosen because it is four lines long and is defined purely in terms
 * of 32-bit integer arithmetic, so it produces the same number on every
 * platform and every Node version. Hashing the code units rather than a UTF-8
 * encoding avoids depending on `TextEncoder`, and is equally deterministic:
 * a JavaScript string is a sequence of UTF-16 code units by definition.
 *
 * Nothing about the seed is normalised — case, whitespace and Unicode form are
 * all significant — so `"Checkout"` and `"checkout"` are different seeds.
 */
function hashSeed(seed: string): number {
  let hash = FNV_OFFSET_BASIS;

  for (let index = 0; index < seed.length; index += 1) {
    const unit = seed.charCodeAt(index);

    hash = Math.imul(hash ^ (unit & 0xff), FNV_PRIME);
    hash = Math.imul(hash ^ (unit >>> 8), FNV_PRIME);
  }

  return hash >>> 0;
}

/**
 * Creates a pseudo-random number generator that yields the same sequence of
 * values in `[0, 1)` every time it is created from the same `seed`.
 *
 * The generator is Mulberry32: a 32-bit state that is stepped by a constant and
 * then mixed, small enough to read in one sitting and using only `Math.imul`,
 * shifts and xor, so its output does not vary with the platform's floating
 * point or with the Node version. It is a test-reproducibility tool and nothing
 * more — it is not cryptographically secure, and must never be used where that
 * matters.
 *
 * The returned function is stateful and not shared: each call advances this
 * generator alone, so the sequence a caller sees is exactly the sequence of
 * draws it made.
 *
 * @throws {TypeError} If `seed` is empty, which would otherwise be an easy way
 * to reproduce one fixed run by accident.
 * @internal Not part of the public API. `createProxyServer` accepts any
 * `() => number`, which is all a caller needs to supply its own.
 */
export function createSeededRandom(seed: string): () => number {
  if (seed === '') {
    throw new TypeError('Invalid seed "": expected a non-empty string.');
  }

  let state = hashSeed(seed);

  return () => {
    state = (state + MULBERRY32_INCREMENT) | 0;

    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;

    return ((mixed ^ (mixed >>> 14)) >>> 0) / UINT32_RANGE;
  };
}
