import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';

/**
 * Release invariants: the handful of facts about the package and its workflows
 * that a consumer depends on and that nothing else would notice breaking.
 *
 * The real proof that the package works is `scripts/package-smoke.mjs`, which
 * installs the tarball and drives it. This file covers what that script cannot:
 * the promises the manifest and the workflows make before anything is packed —
 * a narrow public API, an accurate `files` list, a CI job that actually runs the
 * smoke test, and a release workflow that does not publish.
 *
 * It is deliberately not a snapshot of either file. Only the facts worth
 * failing a build over are asserted, so ordinary edits to a workflow or a
 * description do not have to be re-approved here.
 */

const execFileAsync = promisify(execFile);

const repoRoot = new URL('../../', import.meta.url);

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(new URL(path, repoRoot), 'utf8')) as Record<string, unknown>;
}

function readText(path: string): string {
  return readFileSync(new URL(path, repoRoot), 'utf8');
}

function readWorkflow(name: string): Record<string, unknown> {
  return parseYaml(readText(`.github/workflows/${name}`)) as Record<string, unknown>;
}

const manifest = readJson('package.json');

describe('package manifest', () => {
  it('keeps the published identity', () => {
    expect(manifest.name).toBe('chaos-proxy');
    expect(manifest.license).toBe('MIT');
    expect(manifest.type).toBe('module');
  });

  it('points every URL at the real repository', () => {
    expect(manifest.repository).toEqual({
      type: 'git',
      url: 'git+https://github.com/igkougkousis01/chaos-proxy.git',
    });
    expect(manifest.bugs).toEqual({
      url: 'https://github.com/igkougkousis01/chaos-proxy/issues',
    });
    expect(manifest.homepage).toBe('https://github.com/igkougkousis01/chaos-proxy#readme');
  });

  it('installs one binary, from the build output', () => {
    expect(manifest.bin).toEqual({ 'chaos-proxy': './dist/cli.js' });
  });

  it('exports the public API and nothing else', () => {
    // The CLI, the config layer, the presets, the seeded generator and the log
    // formatter are all in `dist/`. None of them are importable, and a wildcard
    // here would make every one of them public by accident.
    expect(manifest.exports).toEqual({
      '.': {
        types: './dist/index.d.ts',
        import: './dist/index.js',
      },
    });
  });

  it('ships the build output, the examples, and no maps', () => {
    // `package.json`, `README.md` and `LICENSE` are added by npm regardless.
    // The maps name files in `src/`, which does not ship, so they would point
    // at nothing.
    expect(manifest.files).toEqual(['dist', '!dist/**/*.map', 'examples']);
  });

  it('claims only the Node versions CI tests', () => {
    const engines = manifest.engines as { node: string };
    expect(engines.node).toBe('>=22.12');
  });

  it('has the scripts the contributing guide and CI both call', () => {
    const scripts = manifest.scripts as Record<string, string | undefined>;

    for (const name of [
      'build',
      'typecheck',
      'lint',
      'format:check',
      'test',
      'check',
      'package:smoke',
      'release:verify-tag',
    ]) {
      expect(scripts[name], `missing script: ${name}`).toBeTypeOf('string');
    }
  });

  it('runs the whole gate from `npm run check`', () => {
    const scripts = manifest.scripts as Record<string, string>;
    const check = scripts.check ?? '';

    for (const step of ['typecheck', 'lint', 'format:check', 'test', 'build']) {
      expect(check, `\`npm run check\` does not run ${step}`).toContain(step);
    }
  });

  it('rebuilds before packing, so a stale dist cannot ship', () => {
    const scripts = manifest.scripts as Record<string, string | undefined>;
    expect(scripts.prepack).toBe('npm run build');
  });

  it('keeps the runtime dependency surface to one package', () => {
    expect(Object.keys(manifest.dependencies as object)).toEqual(['yaml']);
  });
});

describe('licence', () => {
  it('is the MIT text the manifest claims', () => {
    const licence = readText('LICENSE');
    expect(licence).toContain('MIT License');
    expect(licence).toContain('Copyright (c) 2026 Ioannis Gkougkousis');
    expect(licence).toContain('WITHOUT WARRANTY OF ANY KIND');
  });
});

describe('release version', () => {
  const version = manifest.version as string;

  it('is stated identically in the lockfile', () => {
    // `npm ci` installs from the lockfile, and a lockfile that disagrees with
    // the manifest is a version the release workflow would verify but never
    // install.
    const lockfile = readJson('package-lock.json');
    const root = (lockfile.packages as Record<string, Record<string, unknown>>)[''];

    expect(lockfile.version).toBe(version);
    expect(root?.version).toBe(version);
  });

  it('has a dated changelog entry, with `Unreleased` still open above it', () => {
    const changelog = readText('CHANGELOG.md');

    expect(changelog).toMatch(
      new RegExp(`^## \\[${version.replace(/\./g, '\\.')}\\] - \\d{4}-\\d{2}-\\d{2}$`, 'm'),
    );
    expect(changelog).toMatch(/^## \[Unreleased\]$/m);
  });
});

describe('release tag verifier', () => {
  const script = fileURLToPath(new URL('scripts/verify-release-tag.mjs', repoRoot));
  const version = manifest.version as string;

  it('accepts the tag that matches the manifest', async () => {
    const { stdout } = await execFileAsync(process.execPath, [script, `v${version}`]);
    expect(stdout).toContain(version);
  });

  it('rejects a tag the manifest does not agree with', async () => {
    // The failure this exists to prevent: cutting `v1.0.0` while the manifest
    // still says something else, producing a release named after a version that
    // was never built.
    await expect(execFileAsync(process.execPath, [script, 'v99.0.0'])).rejects.toMatchObject({
      code: 1,
    });
  });

  it('rejects a tag without the conventional `v`', async () => {
    await expect(execFileAsync(process.execPath, [script, version])).rejects.toMatchObject({
      code: 1,
    });
  });

  it('reads the tag from GITHUB_REF_NAME when the workflow passes no argument', async () => {
    const { stdout } = await execFileAsync(process.execPath, [script], {
      env: { PATH: process.env.PATH ?? '', GITHUB_REF_NAME: `v${version}` },
    });

    expect(stdout).toContain(version);
  });

  it('rejects a branch name, which is what a manual run would supply', async () => {
    // This is why the release workflow gates verification on `ref_type ==
    // 'tag'`: a manually dispatched run has `GITHUB_REF_NAME` of `main`, and
    // running the verifier on it would fail a build that was never a release.
    await expect(
      execFileAsync(process.execPath, [script], {
        env: { PATH: process.env.PATH ?? '', GITHUB_REF_NAME: 'main' },
      }),
    ).rejects.toMatchObject({ code: 1 });
  });

  it('refuses to guess when given no tag at all', async () => {
    await expect(
      execFileAsync(process.execPath, [script], { env: { PATH: process.env.PATH ?? '' } }),
    ).rejects.toMatchObject({ code: 2 });
  });
});

describe('CI workflow', () => {
  const ci = readWorkflow('ci.yml');
  const jobs = ci.jobs as Record<string, Record<string, unknown>>;

  it('is read-only', () => {
    expect(ci.permissions).toEqual({ contents: 'read' });
  });

  it('tests every Node version `engines` claims', () => {
    const strategy = jobs.quality?.strategy as { matrix: { node: string[] } };
    const engines = (manifest.engines as { node: string }).node;

    // `>=22.12`: the oldest supported line, and the current one.
    expect(engines).toContain('22');
    expect(strategy.matrix.node).toContain('22');
    expect(strategy.matrix.node).toContain('24');
  });

  it('verifies the packed package, on the platforms the README claims', () => {
    const smoke = jobs['package-smoke'];
    expect(smoke, 'CI has no package-smoke job').toBeDefined();

    const steps = smoke?.steps as { run?: string }[];
    const runs = steps.map((step) => step.run ?? '').join('\n');
    expect(runs).toContain('npm run package:smoke');

    const strategy = smoke?.strategy as { matrix: { os: string[] } };
    expect(strategy.matrix.os).toEqual(['ubuntu-latest', 'macos-latest']);
  });

  it('installs from the lockfile', () => {
    const steps = jobs.quality?.steps as { run?: string }[];
    expect(steps.map((step) => step.run ?? '').join('\n')).toContain('npm ci');
  });
});

describe('release workflow', () => {
  const release = readWorkflow('release.yml');
  const source = readText('.github/workflows/release.yml');

  /** One step of the release job, by name, so assertions read as intent. */
  function releaseStep(name: string): { if?: string; run?: string } {
    const jobs = release.jobs as Record<string, Record<string, unknown>>;
    const steps = jobs.release?.steps as { name: string; if?: string; run?: string }[];
    const step = steps.find((candidate) => candidate.name === name);

    if (step === undefined) {
      throw new Error(`the release workflow has no step named ${JSON.stringify(name)}`);
    }

    return step;
  }

  it('runs only on a deliberate tag or a manual dispatch', () => {
    // `on` is parsed as the boolean `true` by YAML 1.1 rules, hence the lookup.
    const triggers = (release.on ?? release[true as unknown as keyof typeof release]) as Record<
      string,
      unknown
    >;

    expect(Object.keys(triggers).sort()).toEqual(['push', 'workflow_dispatch']);
    expect(triggers.push).toEqual({ tags: ['v*'] });
  });

  it('grants write access to the release job alone', () => {
    expect(release.permissions).toEqual({ contents: 'read' });

    const jobs = release.jobs as Record<string, Record<string, unknown>>;
    expect(jobs.release?.permissions).toEqual({ contents: 'write' });
  });

  it('checks the tag against the manifest before it builds anything', () => {
    const jobs = release.jobs as Record<string, Record<string, unknown>>;
    const steps = jobs.release?.steps as { run?: string }[];
    const runs = steps.map((step) => step.run ?? '');

    const verifyAt = runs.findIndex((run) => run.includes('release:verify-tag'));
    const packAt = runs.findIndex((run) => run.includes('npm pack'));

    expect(verifyAt, 'the release workflow never verifies the tag').toBeGreaterThanOrEqual(0);
    expect(packAt).toBeGreaterThan(verifyAt);
  });

  it('runs the same gates a contributor runs', () => {
    const jobs = release.jobs as Record<string, Record<string, unknown>>;
    const steps = jobs.release?.steps as { run?: string }[];
    const runs = steps.map((step) => step.run ?? '').join('\n');

    expect(runs).toContain('npm run check');
    expect(runs).toContain('npm run package:smoke');
  });

  it('is a dry run when dispatched manually, and takes no version input', () => {
    // Option A: a manual run validates and packs, and creates nothing. It
    // deliberately has no version/tag input, because an input would be a second
    // place a version could be stated alongside the tag and the manifest —
    // which is the exact drift the verifier exists to prevent.
    const triggers = (release.on ?? release[true as unknown as keyof typeof release]) as Record<
      string,
      unknown
    >;

    expect(triggers.workflow_dispatch ?? null).toBeNull();
  });

  it('creates a release only for a pushed tag, never for a manual run', () => {
    // `github.ref_type == 'tag'` alone would not be enough: the Actions "Run
    // workflow" dropdown lists tags as well as branches, so a manual run
    // started from `v1.0.0` would satisfy it and publish a release nobody
    // asked for.
    const condition = releaseStep('Create the GitHub Release').if ?? '';

    expect(condition).toContain("github.event_name == 'push'");
    expect(condition).toContain("github.ref_type == 'tag'");
  });

  it('cannot create a release without having verified the tag', () => {
    // The safety property, stated as a property rather than as two strings that
    // happen to match: every condition guarding verification also guards
    // release creation, so the set of runs that release is a subset of the set
    // that verified. Loosening either one alone breaks this.
    const verifyCondition = releaseStep('Verify tag matches package version').if ?? '';
    const releaseCondition = releaseStep('Create the GitHub Release').if ?? '';

    expect(verifyCondition).not.toBe('');
    expect(releaseCondition).toContain(verifyCondition);
  });

  it('tells a manual run that it did not release anything', () => {
    const notice = releaseStep('Report the dry run');

    expect(notice.if).toBe("github.event_name != 'push'");
    expect(notice.run ?? '').toContain('No GitHub Release was created');
  });

  it('does not publish to npm, and needs no token to run', () => {
    // Publishing is a deliberate manual step while the registry name is
    // unowned. A workflow that quietly acquired it would publish from a tag
    // nobody had checked.
    expect(source).not.toMatch(/npm\s+publish/);
    expect(source).not.toMatch(/NPM_TOKEN|NODE_AUTH_TOKEN|npmjs\.org/);
  });
});

describe('repository hygiene', () => {
  it('ignores packed tarballs, so a manual `npm pack` cannot be committed', () => {
    expect(readText('.gitignore')).toContain('*.tgz');
  });

  it('keeps the community files the README points at', () => {
    for (const file of [
      'CHANGELOG.md',
      'CONTRIBUTING.md',
      'SECURITY.md',
      'SUPPORT.md',
      'docs/release-checklist.md',
    ]) {
      expect(() => readText(file), `missing: ${file}`).not.toThrow();
    }
  });

  it('does not advertise an npm install that would not work yet', () => {
    // The package is not published. A copy-pasteable `npm install -g` line
    // would send a stranger to whatever else is on the registry under that
    // name.
    const readme = readText('README.md');
    expect(readme).not.toMatch(/^\s*npm install (-g |--global )?chaos-proxy\s*$/m);
  });
});
