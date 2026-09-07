#!/usr/bin/env node
/**
 * Refuses a release whose tag and manifest version disagree.
 *
 * A tag is what people cite, and `package.json` is what actually ships, so the
 * one failure mode worth automating away is the two of them drifting apart:
 * `v1.0.0` cut while the manifest still says `0.1.0` produces a release whose
 * name is a lie and a tarball nobody asked for. The release workflow runs this
 * before it builds anything, so the mismatch stops the run rather than
 * appearing on a published artifact.
 *
 * The tag comes from the argument, or from `GITHUB_REF_NAME` when the workflow
 * did not pass one. A leading `v` is the convention and the only one accepted;
 * anything else is a mismatch rather than something to normalise, since
 * guessing at tag shapes is how the two drift apart in the first place.
 *
 * Usage: node scripts/verify-release-tag.mjs [tag]
 */

import { readFile } from 'node:fs/promises';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const manifestPath = fileURLToPath(new URL('../package.json', import.meta.url));

const tag = process.argv[2] ?? process.env.GITHUB_REF_NAME;

if (tag === undefined || tag === '') {
  console.error('verify-release-tag: no tag given, and GITHUB_REF_NAME is not set.');
  console.error('Usage: node scripts/verify-release-tag.mjs v1.2.3');
  process.exit(2);
}

const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const expected = `v${manifest.version}`;

if (tag !== expected) {
  console.error(`verify-release-tag: tag ${tag} does not match package.json version.`);
  console.error(`Expected the tag ${expected}, or a manifest version of ${tag.replace(/^v/, '')}.`);
  process.exit(1);
}

console.log(`verify-release-tag: ${tag} matches package.json version ${manifest.version}.`);
