import { execFile } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
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
 * smoke test, a release workflow that does not publish, and a publish workflow
 * that publishes only what a GitHub Release actually released.
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

/**
 * The one workflow allowed to publish, named once.
 *
 * It is not an arbitrary filename. The npm trusted publisher grants publish
 * rights to this repository *and this file*, so renaming it silently revokes
 * publication until npm is reconfigured to match. Every assertion about
 * publishing goes through this constant so that a rename fails here — loudly,
 * in a test — rather than at the end of the next release.
 */
const PUBLISH_WORKFLOW = 'publish.yml';

const manifest = readJson('package.json');

describe('package manifest', () => {
  it('keeps the published identity', () => {
    // Scoped, and not by preference: the unscoped `chaos-proxy` on the registry
    // belongs to another maintainer, and their `1.0.0` is already published and
    // immutable. docs/npm-publishing.md has the detail.
    expect(manifest.name).toBe('@igkougkousis/chaos-proxy');
    expect(manifest.license).toBe('MIT');
    expect(manifest.type).toBe('module');
  });

  it('scopes the package under the npm account, not the GitHub account', () => {
    // The `1.0.1` bug, asserted so it cannot come back. npm scopes belong to
    // npm accounts: `npm whoami` prints `igkougkousis`, and that is the only
    // scope this account can publish into. `igkougkousis01` is the GitHub
    // username, it is a valid-looking scope, and a package named after it fails
    // only at `npm publish` — long after every doc and test has been written
    // agreeing with it. The two strings differ by two characters, which is
    // exactly the kind of difference a reviewer's eye slides over.
    expect(manifest.name).toBe('@igkougkousis/chaos-proxy');
    expect(manifest.name).not.toBe('@igkougkousis01/chaos-proxy');
    expect(manifest.name as string).not.toMatch(/^@igkougkousis01\//);

    const scope = (manifest.name as string).split('/')[0];
    expect(scope).toBe('@igkougkousis');
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

  it('names the command after the tool, not after the scoped package', () => {
    // The most confusable fact about this package, so it is asserted rather
    // than left to a comment. `bin` names are not namespaced: the registry
    // coordinate is `@igkougkousis/chaos-proxy` and the command a consumer
    // types is `chaos-proxy`. Renaming the binary to match the package would
    // invalidate every documented invocation, and would still be a valid
    // manifest — nothing but this would notice.
    const binNames = Object.keys(manifest.bin as Record<string, string>);

    expect(binNames).toEqual(['chaos-proxy']);
    expect(binNames).not.toContain(manifest.name);
    expect(manifest.name).not.toBe(binNames[0]);
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
      'release:verify-publishable',
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

  it('is the version this branch prepares', () => {
    // Pinned deliberately. The scope correction and the version bump are one
    // change: publishing `1.0.2` is the only way the corrected name reaches the
    // registry, since `1.0.1` is already tagged and stays as it is.
    expect(version).toBe('1.0.2');
  });

  it('is stated identically in the lockfile', () => {
    // `npm ci` installs from the lockfile, and a lockfile that disagrees with
    // the manifest is a version the release workflow would verify but never
    // install. The name is checked alongside it because `npm pkg set name`
    // does not touch the lockfile: the rename can half-apply, and a lockfile
    // still naming the old scope is exactly what that looks like. It is not
    // hypothetical — renaming to `@igkougkousis/chaos-proxy` left the lockfile
    // on `@igkougkousis01` until `npm install --package-lock-only` ran.
    const lockfile = readJson('package-lock.json');
    const root = (lockfile.packages as Record<string, Record<string, unknown>>)[''];

    expect(lockfile.version).toBe(version);
    expect(root?.version).toBe(version);
    expect(lockfile.name).toBe(manifest.name);
    expect(root?.name).toBe(manifest.name);
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

describe('publish workflow', () => {
  // The only workflow that can publish, and the one place a mistake reaches
  // the registry rather than a build log. npm versions are immutable, so
  // almost everything asserted here is a property with no undo behind it.
  //
  // Parsed rather than matched against text wherever the fact is structural —
  // a trigger, a permission, a job condition — so that reformatting the file
  // does not fail the build and so that a fact cannot be satisfied by the word
  // appearing in a comment. The two text assertions that remain are about the
  // exact shell command, which is what actually runs.

  const publish = readWorkflow(PUBLISH_WORKFLOW);
  const source = readText(`.github/workflows/${PUBLISH_WORKFLOW}`);

  /** The single job, whatever it is keyed as. */
  function publishJob(): Record<string, unknown> {
    const jobs = publish.jobs as Record<string, Record<string, unknown>>;
    const names = Object.keys(jobs);

    // One job, deliberately: a second one would be a second place permissions
    // and conditions are stated, and only one of them would be reviewed.
    expect(names, 'the publish workflow should have exactly one job').toHaveLength(1);

    return jobs[names[0] as string] as Record<string, unknown>;
  }

  function steps(): {
    name?: string;
    uses?: string;
    run?: string;
    with?: Record<string, unknown>;
  }[] {
    return publishJob().steps as {
      name?: string;
      uses?: string;
      run?: string;
      with?: Record<string, unknown>;
    }[];
  }

  /** Every `run:` script, in order, as one string per step. */
  function runs(): string[] {
    return steps().map((step) => step.run ?? '');
  }

  /** Where in the step order something first happens, or -1. */
  function indexOfRun(needle: string): number {
    return runs().findIndex((run) => run.includes(needle));
  }

  it('exists', () => {
    expect(() => readText(`.github/workflows/${PUBLISH_WORKFLOW}`)).not.toThrow();
  });

  it('runs only when a GitHub Release is published', () => {
    // `on` is parsed as the boolean `true` by YAML 1.1 rules in some parsers,
    // hence the lookup, which mirrors the release workflow's.
    const triggers = (publish.on ?? publish[true as unknown as keyof typeof publish]) as Record<
      string,
      unknown
    >;

    expect(Object.keys(triggers)).toEqual(['release']);
    expect(triggers.release).toEqual({ types: ['published'] });
  });

  it('cannot be triggered by a push, a schedule, or a person', () => {
    // The property behind the assertion above, stated so that *adding* a
    // trigger fails rather than only changing one. A `workflow_dispatch` is
    // the tempting one — it is how someone would try to retry a failed publish
    // — and it is exactly the route by which a branch head gets published.
    const triggers = (publish.on ?? publish[true as unknown as keyof typeof publish]) as Record<
      string,
      unknown
    >;

    for (const forbidden of ['push', 'pull_request', 'workflow_dispatch', 'schedule']) {
      expect(triggers, `publish.yml can be triggered by ${forbidden}`).not.toHaveProperty(
        forbidden,
      );
    }
  });

  it('checks out the exact tag the release names', () => {
    const checkout = steps().find((step) => (step.uses ?? '').startsWith('actions/checkout'));

    expect(checkout, 'the publish workflow never checks anything out').toBeDefined();
    expect(checkout?.with?.ref).toBe('${{ github.event.release.tag_name }}');
  });

  it('never publishes from a branch head', () => {
    // The failure this exists to prevent, stated as what the checkout must not
    // be rather than as what it is. `main` moves on after a release, and
    // `github.sha` for a release event is the commit the tag pointed at when
    // the event fired — close enough to look right and not the thing the
    // release is named after.
    const checkout = steps().find((step) => (step.uses ?? '').startsWith('actions/checkout'));
    const ref = String(checkout?.with?.ref ?? '');

    expect(ref).toContain('github.event.release.tag_name');
    expect(ref).not.toContain('github.sha');
    expect(ref).not.toContain('github.ref');
    expect(ref).not.toMatch(/\bmain\b/);
    expect(ref).not.toContain('default_branch');
  });

  it('asks for the OIDC token, and nothing else beyond reading the repository', () => {
    expect(publish.permissions).toEqual({ contents: 'read' });
    expect(publishJob().permissions).toEqual({ contents: 'read', 'id-token': 'write' });
  });

  it('holds no permission it does not need', () => {
    // Stated as a denylist as well, because `id-token: write` being present is
    // not the same claim as nothing else being. Trusted publishing is not
    // GitHub Packages: `packages: write` would grant a registry this workflow
    // does not publish to, and `contents: write` would let a publish job
    // rewrite the tag it is publishing.
    const granted = publishJob().permissions as Record<string, string>;

    for (const forbidden of [
      'packages',
      'actions',
      'issues',
      'pull-requests',
      'deployments',
      'attestations',
      'checks',
      'statuses',
    ]) {
      expect(granted, `publish.yml grants ${forbidden}`).not.toHaveProperty(forbidden);
    }

    expect(granted.contents).toBe('read');
  });

  it('runs in the `npm` GitHub Environment', () => {
    // Part of the trust relationship rather than decoration: the trusted
    // publisher on npm's side names this environment, and a publish from a job
    // without it is rejected. It is also where a required reviewer can be
    // attached.
    expect(publishJob().environment).toBe('npm');
  });

  it('runs on a GitHub-hosted runner, which trusted publishing requires', () => {
    // A self-hosted runner cannot produce an OIDC token npm will accept.
    expect(publishJob()['runs-on']).toBe('ubuntu-latest');
  });

  it('refuses drafts and pre-releases', () => {
    // Not a red run to explain away — the job does not start. A draft has no
    // published release to correspond to, and this project publishes only to
    // `latest`, so a pre-release reaching it would hand every plain
    // `npm install` a version never meant for it.
    const condition = String(publishJob().if ?? '');

    expect(condition).toContain('github.event.release.draft == false');
    expect(condition).toContain('github.event.release.prerelease == false');
  });

  it('reuses the tag verifier rather than checking the version again itself', () => {
    // One answer to "which version is this". A second implementation is a
    // second thing to keep in step with the manifest.
    expect(indexOfRun('release:verify-tag')).toBeGreaterThanOrEqual(0);
  });

  it('guards against republishing a version the registry already has', () => {
    expect(indexOfRun('release:verify-publishable')).toBeGreaterThanOrEqual(0);
  });

  it('asserts the package identity it is about to publish', () => {
    // `npm publish` takes the name from the manifest and never asks, so a
    // mistyped scope publishes successfully under a name nobody installs. This
    // is the one place the intended coordinate is written down, so a rename
    // has to be deliberate in two files rather than one.
    const guard = runs().find((run) => run.includes('release:verify-publishable')) ?? '';

    expect(guard).toContain('--expect-name');
    expect(guard).toContain(manifest.name as string);
  });

  it('runs the same gates a contributor runs', () => {
    // CI ran these already on this commit. They run again because this is the
    // last point at which anything can be stopped, and a gate skipped because
    // it passed somewhere else stops applying the first time "somewhere else"
    // is wrong.
    expect(indexOfRun('npm ci')).toBeGreaterThanOrEqual(0);
    expect(indexOfRun('npm run check')).toBeGreaterThanOrEqual(0);
    expect(indexOfRun('npm run package:smoke')).toBeGreaterThanOrEqual(0);
  });

  it('does every check before it publishes anything', () => {
    // The ordering property, rather than six assertions that each check a step
    // exists somewhere. Publishing is the last thing that happens, and each of
    // these is a reason not to reach it.
    const publishAt = runs().findIndex((run) => /npm publish(?! --dry-run)/.test(run));

    expect(publishAt, 'the publish workflow never publishes').toBeGreaterThanOrEqual(0);

    for (const gate of [
      'npm ci',
      'release:verify-tag',
      'release:verify-publishable',
      'npm run check',
      'npm run package:smoke',
      'npm publish --dry-run',
    ]) {
      const at = indexOfRun(gate);

      expect(at, `${gate} does not run`).toBeGreaterThanOrEqual(0);
      expect(at, `${gate} runs after the publish`).toBeLessThan(publishAt);
    }
  });

  it('inspects the publish before performing it', () => {
    expect(source).toMatch(/npm publish --dry-run --access public/);
  });

  it('publishes with the exact command, and adds nothing to it', () => {
    // `--provenance` is deliberately absent: npm attaches a provenance
    // attestation automatically for a public package published over OIDC from
    // a public repository, and the flag is neither required nor a way to get
    // more of it. It is also never disabled.
    //
    // Asserted against the scripts rather than the file, so that a comment may
    // explain the absence without being mistaken for the flag itself.
    expect(source).toMatch(/^\s*run: npm publish --access public$/m);

    for (const run of runs()) {
      expect(run, 'a step passes a provenance flag').not.toMatch(/--(no-)?provenance/);
    }
  });

  it('publishes to `latest`, with no dist-tag of its own', () => {
    // This project has no pre-release channel. Inventing one at publication
    // time would be surprising, and `--tag` is how it would happen.
    expect(source).not.toMatch(/--tag\s/);
  });

  it('never tries to work around an immutable version', () => {
    // The three things someone reaches for when a publish is refused, none of
    // which npm allows and all of which would make the guard pointless.
    expect(source).not.toContain('--force');
    expect(source).not.toMatch(/npm\s+unpublish/);
    expect(source).not.toMatch(/npm\s+dist-tag/);
  });

  it('cannot race another run for the same release', () => {
    const concurrency = publish.concurrency as { group: string; 'cancel-in-progress': boolean };

    expect(concurrency.group).toContain('github.event.release.tag_name');
    expect(concurrency['cancel-in-progress']).toBe(false);
  });

  it('is bounded in time', () => {
    const timeout = publishJob()['timeout-minutes'];

    expect(typeof timeout).toBe('number');
    expect(timeout as number).toBeGreaterThan(0);
  });

  it('publishes on a Node and npm new enough for trusted publishing', () => {
    // Node >= 22.14 and npm >= 11.5.1. The Node 22 line bundles npm 10.x, so
    // the publish job is the one place that does not use the version the rest
    // of CI does — which says nothing about what consumers need.
    const setup = steps().find((step) => (step.uses ?? '').startsWith('actions/setup-node'));

    expect(setup?.with?.['node-version']).toBe('24');
    expect(source).toContain('11.5.1');
  });

  it('does not widen the runtime the package claims', () => {
    // The publish job's Node version is about publishing. `engines` is a
    // promise to consumers, and a publishing requirement is not a reason to
    // change it.
    expect((manifest.engines as { node: string }).node).toBe('>=22.12');
  });

  it('caches no dependencies for a release build', () => {
    // npm's own guidance for trusted publishing. A release should install what
    // the lockfile says from the registry, not what a cache restored.
    const setup = steps().find((step) => (step.uses ?? '').startsWith('actions/setup-node'));

    expect(setup?.with?.cache ?? null).toBeNull();
  });

  it('leaves no git credential lying around for a lifecycle script', () => {
    // Nothing after the checkout talks to git, and `npm ci` runs dependency
    // lifecycle scripts in the same working directory.
    const checkout = steps().find((step) => (step.uses ?? '').startsWith('actions/checkout'));

    expect(checkout?.with?.['persist-credentials']).toBe(false);
  });

  it('passes the release tag through the environment, never into a shell', () => {
    // A tag is a string somebody chose, and `${{ }}` inside a `run:` block is
    // pasted in before the shell sees a quote. Every step that uses the tag in
    // a script takes it from `env:` instead.
    for (const step of steps()) {
      if (step.run === undefined) {
        continue;
      }

      expect(
        step.run,
        `${step.name ?? 'a step'} interpolates an expression into its shell`,
      ).not.toContain('${{');
    }
  });

  it('quotes every shell variable it expands', () => {
    // Unquoted expansion is how a tag containing a space becomes two
    // arguments. `set -euo pipefail` on every multi-line script is the other
    // half: a failing command in the middle of one should stop it.
    const shellSteps = runs().filter((run) => run.includes('$'));

    for (const run of shellSteps) {
      const bare = run.match(/\$[A-Za-z_][A-Za-z0-9_]*/g) ?? [];

      for (const variable of bare) {
        // `"$VAR"` and `"${VAR}"` are both fine; a bare `$VAR` is not.
        expect(run, `${variable} is expanded unquoted`).toMatch(
          new RegExp(`"[^"\n]*\\${variable}`),
        );
      }
    }

    for (const run of runs()) {
      if (run.includes('\n') && run.trim() !== '') {
        expect(run, 'a multi-line script does not fail fast').toContain('set -euo pipefail');
      }
    }
  });

  it('creates nothing: no tag, no release, no commit, no version bump', () => {
    // Its whole job is to publish a version that already exists. Anything that
    // writes back to the repository is either a recursion or a second source
    // of truth for the version.
    expect(source).not.toMatch(/gh release create/);
    expect(source).not.toMatch(/git (tag|push|commit)/);
    expect(source).not.toMatch(/npm version/);
  });
});

describe('npm publication', () => {
  // The registry name `chaos-proxy` belongs to another maintainer, and their
  // own `1.0.0` is already published and immutable, so this package publishes
  // under the scope instead. `@igkougkousis/chaos-proxy@1.0.2` was published by
  // hand, because npm grants a trusted publisher only to a package that
  // already exists; everything after it publishes from CI over OIDC. These
  // assertions are all offline: nothing here contacts the registry or needs
  // credentials.

  function workflowSources(): { name: string; source: string }[] {
    const dir = new URL('.github/workflows/', repoRoot);

    return readdirSync(dir)
      .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
      .map((name) => ({ name, source: readText(`.github/workflows/${name}`) }));
  }

  it('publishes from exactly one workflow, and it is the one named in the trust settings', () => {
    // This assertion used to be "no workflow publishes", which was right while
    // publishing was a manual step. It is now the narrower and more useful
    // claim: `publish.yml` is authorised and every other workflow — including
    // ones nobody has written yet — is not. The npm trusted publisher grants
    // publish rights to this filename specifically, so the set of files
    // allowed to contain the command is exactly the set npm will accept it
    // from.
    const publishers = workflowSources().filter(({ source }) => /npm\s+publish/.test(source));

    expect(publishers.map(({ name }) => name)).toEqual([PUBLISH_WORKFLOW]);
  });

  it('lets no other workflow publish, whatever it is called', () => {
    // Stated per-file as well as as a set, so a failure names the offender
    // rather than printing two arrays for a reader to diff.
    for (const { name, source } of workflowSources()) {
      if (name === PUBLISH_WORKFLOW) {
        continue;
      }

      expect(source, `${name} runs npm publish`).not.toMatch(/npm\s+publish/);
    }
  });

  it('publishes with the exact command the scoped package needs', () => {
    // `--access public` on the command line even though `publishConfig` sets
    // it: npm defaults a *scoped* package to restricted, and that failure does
    // not look like one — the publish succeeds, privately.
    const source = readText(`.github/workflows/${PUBLISH_WORKFLOW}`);

    expect(source).toMatch(/npm publish --access public/);
  });

  it('has no workflow that references a long-lived npm token', () => {
    // Trusted publishing exists so that no such credential has to exist. A
    // token appearing in a workflow means that decision was quietly reversed.
    // This one really is every workflow, `publish.yml` included: it is the file
    // most likely to acquire a token, because a token is what would make a
    // failing OIDC publish start working.
    for (const { name, source } of workflowSources()) {
      expect(source, `${name} references an npm token`).not.toMatch(
        /NPM_TOKEN|NODE_AUTH_TOKEN|registry\.npmjs\.org\/:_authToken/,
      );
    }
  });

  it('declares public access, which the scoped name requires', () => {
    // Unscoped, public is npm's default and this would be redundant. Scoped, it
    // is load-bearing: npm defaults a scoped package to *restricted*, so
    // dropping this line does not fail the publish — it succeeds, privately,
    // and the package is silently unavailable to everyone it was published for.
    expect((manifest.name as string).startsWith('@')).toBe(true);
    expect(manifest.publishConfig).toEqual({ access: 'public' });
  });

  it('documents the name conflict rather than leaving it to be rediscovered', () => {
    const doc = readText('docs/npm-publishing.md');

    expect(doc).toContain('gkoos');
    expect(doc).toMatch(/immutable/i);
  });

  it('documents the npm scope as distinct from the GitHub username', () => {
    // The two identities differ by two characters and are used in the same
    // sentences throughout these docs. Recording *why* the scope is
    // `@igkougkousis` while every URL says `igkougkousis01` is what stops the
    // next person from "fixing" one to match the other.
    const doc = readText('docs/npm-publishing.md');

    expect(doc).toContain('@igkougkousis/chaos-proxy');
    expect(doc).toMatch(/npm (username|account)/i);
    expect(doc).toContain('igkougkousis01');
    expect(doc).toMatch(/whoami/);
  });

  it('names the version the bootstrap publish created', () => {
    // Still asserted after the fact. Which version first reached the registry
    // is the one piece of npm history that cannot be recovered from this
    // repository — tags say what was released, not what was published — and it
    // is what someone reading the docs in a year will want.
    const doc = readText('docs/npm-publishing.md');
    const checklist = readText('docs/release-checklist.md');
    const version = manifest.version as string;

    expect(doc).toContain(`${manifest.name as string}@${version}`);
    expect(checklist).toContain(`${manifest.name as string}@${version}`);
    expect(checklist).toContain(`v${version}`);
  });

  it('uses an explicit --access public everywhere a publish is written down', () => {
    // `publishConfig` sets it too, but a scoped package that defaults to
    // `restricted` publishes successfully and privately, so both docs and the
    // workflow state it on the command line.
    for (const path of [
      'docs/npm-publishing.md',
      'docs/release-checklist.md',
      `.github/workflows/${PUBLISH_WORKFLOW}`,
    ]) {
      expect(readText(path), `${path} omits --access public`).toMatch(
        /npm publish --access public/,
      );
    }
  });

  it('documents that the first publish could not come from CI', () => {
    // npm configures a trusted publisher in a package's settings, so a package
    // that does not exist yet cannot have one. The first version had to be
    // published by hand — kept here because the constraint explains the shape
    // of everything else, and a reader who does not know it will read the
    // bootstrap as an oversight.
    const doc = readText('docs/npm-publishing.md');

    expect(doc).toMatch(/must already exist on the npm registry/i);
    expect(doc).toMatch(/manual/i);
  });

  it('documents the two settings automated publication depends on', () => {
    // Neither can be created from this repository, and until both exist the
    // publish workflow runs and is rejected at the last step. A reader who
    // finds only the workflow would have no way to know that.
    for (const path of ['docs/npm-publishing.md', 'docs/release-checklist.md']) {
      const doc = readText(path);

      expect(doc, `${path} does not name the GitHub Environment`).toMatch(/GitHub Environment/);
      expect(doc, `${path} does not name the trusted publisher owner`).toContain('igkougkousis01');
      expect(doc, `${path} does not name the workflow file`).toContain(PUBLISH_WORKFLOW);
      expect(doc, `${path} does not mention the trusted publisher`).toMatch(/trusted publisher/i);
    }
  });

  it('keeps the npm scope and the GitHub owner apart in the trust settings', () => {
    // The single easiest thing in this project to get backwards: the trusted
    // publisher is entirely the GitHub identity, and the npm scope appears
    // nowhere in it. A configuration built from `@igkougkousis` would be
    // accepted as text and would never grant anything.
    const doc = readText('docs/npm-publishing.md');

    expect(doc).toMatch(/Organization or user \| `igkougkousis01`/);
    expect(doc).toMatch(/Workflow filename\s+\| `publish\.yml`/);
  });

  it('sends the release checklist to the publishing doc instead of saying "just publish"', () => {
    const checklist = readText('docs/release-checklist.md');
    expect(checklist).toContain('npm-publishing.md');
  });
});

describe('scoped tarball handling', () => {
  // Renaming the package changed the name of the file `npm pack` writes:
  // `@igkougkousis/chaos-proxy` packs as `igkougkousis-chaos-proxy-1.0.2.tgz`,
  // with the scope flattened rather than preserved — and it changed again when
  // the scope was corrected in `1.0.2`, which is the second time in two
  // versions that a hardcoded filename would have been wrong. Anything that built that filename out of the package name
  // would now build the wrong one, and would do it silently — the release
  // would simply attach nothing, or the smoke test would install a path that
  // does not exist. So nothing is allowed to construct it.

  const releaseSource = readText('.github/workflows/release.yml');
  const smokeSource = readText('scripts/package-smoke.mjs');

  it('names no tarball by hand in the release workflow', () => {
    // Every `.tgz` the workflow mentions has to be a glob. A literal filename
    // here is the bug: `chaos-proxy-1.0.1.tgz` and
    // `igkougkousis01-chaos-proxy-1.0.1.tgz` are both names this package used to
    // pack under and no longer does.
    const mentions = releaseSource.match(/\S*\.tgz/g) ?? [];

    expect(mentions.length, 'the release workflow no longer mentions a tarball').toBeGreaterThan(0);

    for (const mention of mentions) {
      expect(mention, `${mention} is a hand-written tarball name`).toMatch(/\*\.tgz$/);
    }

    expect(releaseSource).not.toContain('chaos-proxy-');
    expect(releaseSource).not.toContain('igkougkousis');
  });

  it('attaches exactly one tarball, and fails rather than attaching none', () => {
    const release = readWorkflow('release.yml');
    const jobs = release.jobs as Record<string, Record<string, unknown>>;
    const steps = jobs.release?.steps as {
      name: string;
      run?: string;
      with?: Record<string, unknown>;
    }[];

    const upload = steps.find((step) => step.name === 'Upload the packed package');
    expect(upload?.with?.path).toBe('release-artifact/*.tgz');

    // Without this the upload step is a no-op when the pack step produces
    // nothing, and the first sign of trouble is an empty release.
    expect(upload?.with?.['if-no-files-found']).toBe('error');

    // `npm pack` writes into an empty directory created for it, so the glob
    // resolves to the one file npm just wrote and cannot pick up a stale one.
    const pack = steps.find((step) => step.name === 'Pack the release artifact');
    expect(pack?.run ?? '').toContain('mkdir -p release-artifact');
    expect(pack?.run ?? '').toContain('npm pack --pack-destination release-artifact');
  });

  it('asks npm for the packed filename rather than reconstructing it', () => {
    // `npm pack --json` reports the name it wrote. Rebuilding it from the
    // manifest means encoding npm's scope-flattening rule in a second place,
    // where it can be wrong without anything saying so.
    expect(smokeSource).toContain("'pack', '--json'");
    expect(smokeSource).toContain('packResult.filename');
    expect(smokeSource).not.toMatch(/\$\{name\}-\$\{version\}\.tgz/);
  });

  it('keeps the package name and the binary name apart in the smoke test', () => {
    // The smoke test installs the tarball and then has to find the command.
    // Looking it up under the package name worked only while the two were the
    // same string, and would now read `bin['@igkougkousis/chaos-proxy']`,
    // which is undefined.
    expect(smokeSource).toContain("const BIN_NAME = 'chaos-proxy'");
    expect(smokeSource).toContain('installedManifest.bin[BIN_NAME]');
    expect(smokeSource).not.toContain('installedManifest.bin[name]');
  });

  it('imports the consumer probe under the manifest name, never a written-down scope', () => {
    // The smoke test's isolated consumer imports `${name}`, read from the
    // manifest it just packed, so it followed the scope correction without
    // being edited. A literal specifier here would be a second place the
    // package name is stated — and the one place that would keep passing while
    // naming a package that cannot be published.
    expect(smokeSource).toContain("`import { createProxyServer } from '${name}';`");
    expect(smokeSource).not.toContain("from '@igkougkousis01/chaos-proxy'");
    expect(smokeSource).not.toMatch(/from '@igkougkousis\/chaos-proxy'/);
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
      'docs/npm-publishing.md',
    ]) {
      expect(() => readText(file), `missing: ${file}`).not.toThrow();
    }
  });

  it('never advertises an install of the unscoped name, which is someone else', () => {
    // `chaos-proxy` on the registry is a different project by another
    // maintainer. A copy-pasteable line without the scope sends a stranger to
    // their package, and it looks exactly like the right command.
    const readme = readText('README.md');

    expect(readme).not.toMatch(/^\s*npm install (-g |--global )?chaos-proxy\s*$/m);
    expect(readme).not.toMatch(/^\s*npx chaos-proxy\b/m);
  });

  it('says the package is on the registry, because it now is', () => {
    // The inverse of what this asserted until `1.0.2` was published, and
    // flipped deliberately rather than by drift: for three versions the README
    // had to keep saying the package was not available, because it was not.
    // Now the failure mode is the opposite one — a README that still tells a
    // reader to clone when `npm install` works — so that is what is asserted.
    const readme = readText('README.md');

    expect(readme).not.toMatch(/not (yet )?(on npm|published|available)/i);
    expect(readme).toContain('@igkougkousis/chaos-proxy');
  });

  it('says it in the install section itself, not only in passing elsewhere', () => {
    // The assertion above is satisfied by the absence of a sentence anywhere in
    // a 40kB README. The claim that matters is the one directly above the
    // `npm install` line a reader is about to copy, so that is what is
    // asserted: a `### From npm` section that gives the command without
    // disclaiming it.
    const readme = readText('README.md');
    const section = /^### From npm$([\s\S]*?)(?=^### |^## )/m.exec(readme)?.[1] ?? '';

    expect(section, 'README has no `### From npm` section').not.toBe('');
    expect(section).not.toMatch(/not available yet|once it is published|will be published/i);
    expect(section).toContain('npm install -g @igkougkousis/chaos-proxy');
  });

  it('gives the three ways in one place: global, npx, and as a dependency', () => {
    // A CLI that is also a library. Someone arriving for one of those should
    // not have to read the other's section to find their command, and the
    // scoped specifier is the part that is easy to get wrong in all three.
    const readme = readText('README.md');

    expect(readme).toContain('npm install -g @igkougkousis/chaos-proxy');
    expect(readme).toContain('npx @igkougkousis/chaos-proxy');
    expect(readme).toMatch(/^npm install @igkougkousis\/chaos-proxy$/m);
    expect(readme).toContain("import { createProxyServer } from '@igkougkousis/chaos-proxy';");
  });

  it('keeps the command unscoped even though the package is not', () => {
    // The distinction a reader trips over: `npm install -g` puts a plain
    // `chaos-proxy` on the PATH, because `bin` names are not namespaced. Every
    // documented invocation in the rest of the README depends on that being
    // said once, near the install line.
    const readme = readText('README.md');
    const section = /^### From npm$([\s\S]*?)(?=^### |^## )/m.exec(readme)?.[1] ?? '';

    expect(section).toMatch(/^chaos-proxy --target/m);
    expect(section).toMatch(/CLI executable\s+\|\s+`chaos-proxy`/);
  });

  it('advertises the npm package under the scope that can actually be published', () => {
    // Every install line, the identity table and both import examples. The old
    // scope surviving anywhere would hand a reader a specifier that resolves to
    // nothing, and would do it in the one document strangers read first.
    const readme = readText('README.md');

    expect(readme).not.toContain('@igkougkousis01/chaos-proxy');
    expect(readme).toContain('npm install -g @igkougkousis/chaos-proxy');
    expect(readme).toContain("import { createProxyServer } from '@igkougkousis/chaos-proxy';");
  });

  it('keeps the GitHub identity out of the rename', () => {
    // The correction is to the npm scope alone. The repository did not move,
    // and rewriting these URLs to match the package would break every link.
    const readme = readText('README.md');

    expect(readme).toContain('https://github.com/igkougkousis01/chaos-proxy');
    expect(manifest.repository).toEqual({
      type: 'git',
      url: 'git+https://github.com/igkougkousis01/chaos-proxy.git',
    });
  });
});
