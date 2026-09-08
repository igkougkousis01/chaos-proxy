import { execFile } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * The last thing standing between the publish workflow and the registry.
 *
 * `scripts/verify-publishable.mjs` decides whether a publish may proceed, from
 * two things it cannot be told and has to find out: whether the manifest names
 * the package we mean, and whether the registry already has this exact
 * version. The second question is the one worth testing hard, because the
 * failure mode is asymmetric — reading "the registry is unreachable" as "the
 * version is free" publishes blind during an outage, and npm versions are
 * immutable, so there is no undo.
 *
 * Every case here is offline. `npm view` is reached through `PATH`, so a stub
 * ahead of the real npm turns "what the registry said" into a fixture, and the
 * three answers npm actually gives — recorded from the live registry — can be
 * replayed alongside the failures that are hard to provoke on purpose.
 */

const execFileAsync = promisify(execFile);

const repoRoot = new URL('../../', import.meta.url);
const script = fileURLToPath(new URL('scripts/verify-publishable.mjs', repoRoot));
const manifest = JSON.parse(readFileSync(new URL('package.json', repoRoot), 'utf8')) as {
  name: string;
  version: string;
};

const stubs: string[] = [];

afterAll(() => {
  for (const dir of stubs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * A directory holding an `npm` that prints `stdout` and exits `code`.
 *
 * Put on the front of `PATH`, it is what the script's `spawn('npm', …)`
 * resolves to. Nothing else about the run changes, so the exit code under test
 * is the script's own reasoning about that output.
 */
function stubNpm(code: number, stdout: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'chaos-proxy-npm-stub-'));
  stubs.push(dir);

  const shim = join(dir, 'npm');
  writeFileSync(shim, `#!/bin/sh\ncat <<'STUB_OUT'\n${stdout}\nSTUB_OUT\nexit ${code}\n`);
  chmodSync(shim, 0o755);

  return dir;
}

/** Runs the guard with a given `npm` in front, and reports its exit code. */
async function runGuard(
  options: { npmDir?: string; args?: string[] } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const args = options.args ?? ['--expect-name', manifest.name];
  const path =
    options.npmDir === undefined
      ? (process.env.PATH ?? '')
      : `${options.npmDir}${delimiter}${process.env.PATH ?? ''}`;

  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [script, ...args], {
      env: { PATH: path, HOME: process.env.HOME ?? tmpdir() },
    });

    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? -1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' };
  }
}

/**
 * What npm really printed for each case, taken from the live registry against
 * `@igkougkousis/chaos-proxy` on 2026-09-08. Recorded rather than invented:
 * the whole guard turns on the shape of `--json` output, and a fixture written
 * from memory would test the script against a registry that does not exist.
 */
const NPM_VIEW = {
  /** `npm view @igkougkousis/chaos-proxy@1.0.2 version --json` — the version exists. */
  published: { code: 0, stdout: '"1.0.2"' },

  /** The same for `@1.0.3`: the package exists, that version does not. */
  versionMissing: {
    code: 1,
    stdout: JSON.stringify({
      error: {
        code: 'E404',
        summary: 'No match found for version 1.0.3',
        detail: "'@igkougkousis/chaos-proxy@1.0.3' is not in this registry.",
      },
    }),
  },

  /** And for a package that has never been published at all. */
  packageMissing: {
    code: 1,
    stdout: JSON.stringify({
      error: {
        code: 'E404',
        summary: 'Not Found - GET https://registry.npmjs.org/@scope%2fnothing - Not found',
        detail: "'@scope/nothing@1.0.0' is not in this registry.",
      },
    }),
  },
} as const;

describe('publish guard: package identity', () => {
  it('proceeds when the manifest names the package that was expected', async () => {
    const npmDir = stubNpm(NPM_VIEW.versionMissing.code, NPM_VIEW.versionMissing.stdout);
    const result = await runGuard({ npmDir });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain(manifest.name);
  });

  it('refuses a manifest whose name is not the one expected', async () => {
    // The drift this exists to catch: `npm publish` takes the name from the
    // manifest and never asks, so a mistyped scope publishes successfully
    // under a name nobody installs. `1.0.1` was exactly that, caught only by a
    // rejection; this catches it before the publish rather than during it.
    const npmDir = stubNpm(NPM_VIEW.versionMissing.code, NPM_VIEW.versionMissing.stdout);
    const result = await runGuard({
      npmDir,
      args: ['--expect-name', '@igkougkousis01/chaos-proxy'],
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('@igkougkousis01/chaos-proxy');
  });

  it('checks the name before it asks the registry anything', async () => {
    // With no stub and a name that cannot match, a guard that consulted the
    // registry first would still have to reach it. Refusing on the manifest
    // alone means a rename is caught even when the network is not there.
    const result = await runGuard({
      npmDir: stubNpm(1, 'this stub fails if it is ever reached'),
      args: ['--expect-name', '@definitely/not-this-package'],
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Refusing to publish');
  });

  it('refuses to run at all without an expected name', async () => {
    // Defaulting to the manifest would make the check tautological: the
    // manifest would be compared with itself and always agree.
    const result = await runGuard({ args: [] });

    expect(result.code).toBe(2);
    expect(result.stderr).toContain('--expect-name');
  });

  it('rejects an argument it does not understand rather than ignoring it', async () => {
    const result = await runGuard({ args: ['--expect-name', manifest.name, '--force'] });

    expect(result.code).toBe(2);
    expect(result.stderr).toContain('--force');
  });
});

describe('publish guard: already-published versions', () => {
  it('refuses when the registry already has this exact version', async () => {
    const npmDir = stubNpm(NPM_VIEW.published.code, NPM_VIEW.published.stdout);
    const result = await runGuard({ npmDir });

    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/already published/i);
    expect(result.stderr).toMatch(/immutable/i);
  });

  it('proceeds when the package exists but this version does not', async () => {
    const npmDir = stubNpm(NPM_VIEW.versionMissing.code, NPM_VIEW.versionMissing.stdout);
    const result = await runGuard({ npmDir });

    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/not on the registry/i);
  });

  it('proceeds when the package has never been published', async () => {
    // The bootstrap case. It no longer applies to this package, and the guard
    // should not start depending on the package existing.
    const npmDir = stubNpm(NPM_VIEW.packageMissing.code, NPM_VIEW.packageMissing.stdout);
    const result = await runGuard({ npmDir });

    expect(result.code).toBe(0);
  });

  it('fails loudly rather than exiting quietly on a duplicate', async () => {
    // A publish job that silently does nothing is indistinguishable from one
    // that worked, and the difference only surfaces when someone goes looking
    // for a version that was never published.
    const npmDir = stubNpm(NPM_VIEW.published.code, NPM_VIEW.published.stdout);
    const result = await runGuard({ npmDir });

    expect(result.code).not.toBe(0);
  });
});

describe('publish guard: registry failures', () => {
  // The distinction the whole script is built around. `npm view` exits
  // non-zero for "no such version" and for "could not reach the registry", and
  // only the first of those means the version is free.

  it('does not read a network failure as an available version', async () => {
    const npmDir = stubNpm(
      1,
      'npm error code EAI_AGAIN\nnpm error network request to https://registry.npmjs.org failed',
    );
    const result = await runGuard({ npmDir });

    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/could not establish/i);
  });

  it('does not read a registry error code as an available version', async () => {
    for (const code of ['E500', 'E403', 'ETIMEDOUT', 'ERR_SOCKET_TIMEOUT']) {
      const npmDir = stubNpm(1, JSON.stringify({ error: { code, summary: 'not a 404' } }));
      const result = await runGuard({ npmDir });

      expect(result.code, `${code} was treated as a missing version`).toBe(2);
      expect(result.stderr).toContain(code);
    }
  });

  it('does not read a success it cannot interpret as an available version', async () => {
    // Exit zero with nothing to show. npm does not do this for an exact
    // version, which is the reason it is refused rather than assumed: an
    // unrecognised success is still an unanswered question.
    const npmDir = stubNpm(0, '');
    const result = await runGuard({ npmDir });

    expect(result.code).toBe(2);
  });

  it('separates a deliberate refusal from an unanswered question', async () => {
    // Two different exit codes, so the workflow log says which happened
    // without anyone having to read the message: 1 is "we decided not to", 2
    // is "we could not tell".
    const duplicate = await runGuard({
      npmDir: stubNpm(NPM_VIEW.published.code, NPM_VIEW.published.stdout),
    });
    const unreachable = await runGuard({ npmDir: stubNpm(1, 'npm error code ENOTFOUND') });

    expect(duplicate.code).toBe(1);
    expect(unreachable.code).toBe(2);
    expect(duplicate.code).not.toBe(unreachable.code);
  });

  it('never exits 0 for any failure it was not built to recognise', async () => {
    // The property, rather than the four cases above that happen to hold it:
    // whatever npm does, the only route to a zero exit is an explicit E404.
    const hostile = [
      { code: 1, stdout: '' },
      { code: 1, stdout: 'not json at all' },
      { code: 1, stdout: '{"error":{}}' },
      { code: 1, stdout: '{"error":{"code":"e404"}}' },
      { code: 1, stdout: '{}' },
      { code: 127, stdout: '' },
      { code: 0, stdout: 'not json at all' },
      { code: 0, stdout: '{}' },
    ];

    for (const { code, stdout } of hostile) {
      const result = await runGuard({ npmDir: stubNpm(code, stdout) });
      expect(result.code, `exit ${code} with ${JSON.stringify(stdout)} was allowed`).not.toBe(0);
    }
  });

  it('reaches a real conclusion only from the registry, never from a default', async () => {
    // A stub that prints nothing and exits zero is the closest thing to "npm
    // was not there". It must not look like permission to publish.
    const result = await runGuard({ npmDir: stubNpm(0, '   ') });
    expect(result.code).not.toBe(0);
  });
});

describe('publish guard: wiring', () => {
  it('is reachable as the npm script the workflow calls', () => {
    const scripts = (
      JSON.parse(readFileSync(new URL('package.json', repoRoot), 'utf8')) as {
        scripts: Record<string, string>;
      }
    ).scripts;

    expect(scripts['release:verify-publishable']).toBe('node scripts/verify-publishable.mjs');
  });

  it('reads the coordinate from the manifest rather than from an argument', async () => {
    // The version is never passed in. `verify-release-tag.mjs` already ties the
    // tag to the manifest, and a second place to state a version is a second
    // place for it to be wrong.
    const npmDir = stubNpm(NPM_VIEW.published.code, NPM_VIEW.published.stdout);
    const result = await runGuard({ npmDir });

    expect(result.stderr).toContain(`${manifest.name}@${manifest.version}`);
  });

  it('lives beside the other release scripts', () => {
    expect(dirname(script).endsWith('scripts')).toBe(true);
  });
});
