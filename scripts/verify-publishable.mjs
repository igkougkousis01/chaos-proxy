#!/usr/bin/env node
/**
 * Refuses a publish that would be the wrong package, or a republish of a
 * version the registry already has.
 *
 * `scripts/verify-release-tag.mjs` answers "does this tag agree with the
 * manifest". This answers the two questions that only the registry can settle,
 * and that the publish workflow has to ask immediately before `npm publish`:
 *
 *   1. Is the package about to be published the one we mean? The manifest name
 *      is the source of truth and is passed to npm, so drift there is silent:
 *      a mistyped scope publishes successfully, under a name nobody installs.
 *      `--expect-name` is the one place the intended coordinate is written
 *      down, so a rename has to be deliberate in two files rather than one.
 *   2. Is this exact version already published? npm versions are immutable, so
 *      a re-run of the publish workflow must not attempt a republish. It is
 *      not enough to let `npm publish` fail: a job that fails at the last step
 *      for a reason nobody explains reads like a broken pipeline rather than
 *      like the guard working.
 *
 * The distinction that matters, and the reason this is a script rather than a
 * line of shell: `npm view` exits non-zero both for "that version does not
 * exist" and for "the registry could not be reached". Treating every failure
 * as "not published" would publish through an outage, which is the one
 * situation where publishing blind is least recoverable. So the registry's own
 * error code decides:
 *
 *   exit 0 + a version           -> published already        -> refuse (1)
 *   exit non-zero + E404         -> not published            -> proceed (0)
 *   anything else                -> the registry did not say -> refuse (2)
 *
 * `--json` is what makes that readable: npm reports the failure as
 * `{"error":{"code":"E404",…}}` on stdout rather than as prose on stderr, so
 * the classification is a field lookup rather than a match against a message
 * that is free to be reworded.
 *
 * Nothing here authenticates. `npm view` is a public read, so this runs the
 * same locally as in CI, and it neither needs nor accepts a token. (On a
 * private registry an unauthenticated read returns E404 for a package that
 * does exist, which would be a false "not published" — irrelevant here, where
 * the package is public on the public registry, and noted so that it is not
 * rediscovered as a bug.)
 *
 * Usage: node scripts/verify-publishable.mjs --expect-name @scope/name
 */

import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const manifestPath = fileURLToPath(new URL('../package.json', import.meta.url));

/** Refused deliberately: this is not the package, or the version is taken. */
const EXIT_REFUSED = 1;

/** Could not be established either way. Also refused, and for a louder reason. */
const EXIT_UNDECIDED = 2;

function usage(message) {
  console.error(`verify-publishable: ${message}`);
  console.error('Usage: node scripts/verify-publishable.mjs --expect-name @scope/name');
  process.exit(EXIT_UNDECIDED);
}

/** `--expect-name X` and `--expect-name=X`, and nothing else. */
function parseArgs(argv) {
  let expectName;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--expect-name') {
      expectName = argv[index + 1];
      index += 1;
    } else if (arg.startsWith('--expect-name=')) {
      expectName = arg.slice('--expect-name='.length);
    } else {
      usage(`unrecognised argument ${JSON.stringify(arg)}`);
    }
  }

  return expectName;
}

/**
 * Runs a command to completion and captures its output.
 *
 * npm is a shell script on POSIX and a `.cmd` on Windows, so it is spawned
 * through the platform's own resolution rather than assumed to be an
 * executable of a fixed name — the same reasoning as in
 * `scripts/package-smoke.mjs`.
 */
function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      shell: process.platform === 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));

    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

/**
 * npm's JSON, if it produced any.
 *
 * Tolerant about leading noise — a lifecycle script or a warning can reach
 * stdout ahead of the payload — but not about producing an answer when there
 * is none. `undefined` here means "npm did not tell us", which is a refusal
 * rather than a default.
 */
function parseJson(stdout) {
  const trimmed = stdout.trim();

  if (trimmed === '') {
    return undefined;
  }

  const candidates = [trimmed];
  const firstBrace = trimmed.indexOf('{');

  if (firstBrace > 0) {
    candidates.push(trimmed.slice(firstBrace));
  }

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // Try the next slice; exhausting them is the `undefined` below.
    }
  }

  return undefined;
}

const expectName = parseArgs(process.argv.slice(2));

if (expectName === undefined || expectName === '') {
  usage('--expect-name is required, so that the package identity is asserted rather than assumed.');
}

const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const { name, version } = manifest;

if (name !== expectName) {
  console.error(`verify-publishable: package.json names ${name}, but ${expectName} was expected.`);
  console.error('Refusing to publish: one of the two is wrong, and guessing which is not safe.');
  process.exit(EXIT_REFUSED);
}

const coordinate = `${name}@${version}`;
const result = await run('npm', ['view', coordinate, 'version', '--json']);
const payload = parseJson(result.stdout);

if (result.code === 0) {
  // A version came back, so the coordinate is taken. npm versions are
  // immutable and are never reissued, so there is no route forward from here
  // that is not a new version number.
  if (typeof payload === 'string' && payload !== '') {
    console.error(`verify-publishable: ${coordinate} is already published.`);
    console.error('npm versions are immutable. Bump the version rather than republishing.');
    process.exit(EXIT_REFUSED);
  }

  // Exit zero and nothing to show. Not a case npm produces for an exact
  // version, which is why it is not quietly read as "available": an
  // unrecognised success is still an unanswered question.
  console.error(`verify-publishable: npm view ${coordinate} succeeded but reported no version.`);
  console.error(`stdout: ${JSON.stringify(result.stdout)}`);
  console.error('Refusing to publish on an answer that cannot be interpreted.');
  process.exit(EXIT_UNDECIDED);
}

// Non-zero. Only the registry saying "no such version" means the coordinate is
// free; every other failure — auth, rate limit, DNS, a 5xx, an npm that
// crashed — is the registry not having answered, and publishing through one of
// those is exactly the mistake this script exists to prevent.
if (payload?.error?.code === 'E404') {
  console.log(`verify-publishable: ${coordinate} is not on the registry, and the name matches.`);
  process.exit(0);
}

console.error(`verify-publishable: could not establish whether ${coordinate} is published.`);
console.error(
  `npm view exited ${result.code} with error code ${payload?.error?.code ?? '(none)'}.`,
);
console.error(result.stderr.trim() || result.stdout.trim() || '(no output)');
console.error(
  'Refusing to publish: a registry that did not answer is not a registry that said no.',
);
process.exit(EXIT_UNDECIDED);
