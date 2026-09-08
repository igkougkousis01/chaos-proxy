# Release checklist

For maintainers. How a release is cut, from a merged version bump to a GitHub Release with a
tarball attached and the package on npm.

`1.0.0`, `1.0.1` and `1.0.2` are cut. `1.0.2` is the first version on the registry: it was
published by hand, because npm cannot grant a trusted publisher to a package that does not exist
yet. That bootstrap has run and is not repeated — the record of it is in
[npm publishing](npm-publishing.md). From `1.0.3` onwards, publication is a step in the pipeline
rather than a step in this document.

## Why the version is not bumped in a hardening PR

Release hardening and release versioning are separate steps on purpose. A PR that makes the
package correct and a commit that declares "this is version X" answer different questions, and
mixing them means the version has to be re-decided every time the hardening changes. So the
manifest stays at its current version through hardening work, and the bump is its own small,
reviewable change immediately before the tag.

## The sequence

1. **Merge the hardening work** into `main`, with the version untouched.
2. **Bump the version** in a dedicated PR: `npm version <x.y.z> --no-git-tag-version`, which
   updates `package.json` and `package-lock.json` together and creates neither a commit nor a tag.
   Move the `## [Unreleased]` entries in `CHANGELOG.md` under a `## [x.y.z]` heading with the
   release date, leaving `## [Unreleased]` above it, empty. Nothing else belongs in that PR.
3. **Wait for CI to pass** on `main` after it merges.
4. **Tag it**: `git tag v1.0.2 && git push origin v1.0.2`. The tag must match the manifest exactly;
   `scripts/verify-release-tag.mjs` fails the release workflow if it does not.
5. **The release workflow runs** on that tag: it verifies the tag against the manifest, runs the
   full quality gate, runs the package smoke test, packs the tarball, and creates the GitHub
   Release with the packed `.tgz` attached. The workflow globs whatever `npm pack` wrote rather
   than naming it, which matters now that the package is scoped: `@igkougkousis/chaos-proxy`
   packs as `igkougkousis-chaos-proxy-1.0.2.tgz`, with the scope flattened. Because the workflow
   globs, correcting the scope in `1.0.2` needed no change to it at all — which is the point of
   never writing that filename down. Attach npm's own artifact under npm's own name; do not
   rename it.
6. **The publish workflow runs**, triggered by that GitHub Release being published.
   `.github/workflows/publish.yml` checks out the exact release tag — not `main` — verifies the tag
   against the manifest again, refuses if that version is already on the registry, re-runs the
   quality gate and the package smoke test, and publishes with `npm publish --access public` over
   OIDC. No npm token is used or stored. Nothing to do by hand: watch the run, and check the
   package page afterwards. See [npm publishing](npm-publishing.md) for the full reasoning.

## Rehearsing it

The release workflow can be run from the Actions tab without cutting a release. A manual run does
everything a tag run does — quality gate, package smoke test, `npm pack` — and uploads the tarball
as a workflow artifact, but creates no GitHub Release and publishes nothing. Use it to check the
workflow itself, or to get a packed artifact from a commit that is not a release.

It takes no version input on purpose: the tag and the manifest are the only two places a version is
stated, and a third would be one more thing to keep in step. A manual run is never a release, no
matter which branch or tag it is started from — only a pushed `v*` tag creates one.

## Before tagging

- [ ] Working tree clean (`git status --short` prints nothing)
- [ ] `npm ci` from a clean clone
- [ ] `npm run check` passes
- [ ] `npm run package:smoke` passes
- [ ] `npm audit` reviewed — findings understood, not silenced
- [ ] `npm outdated` reviewed — upgrades are their own PRs, not part of a release
- [ ] README is current, and claims nothing that is not true yet
- [ ] CHANGELOG has an entry for every user-visible change, under the version being released
- [ ] Version bumped in `package.json`, with `package-lock.json` agreeing
- [ ] `npm pack --dry-run` contents inspected — only `dist/`, `examples/`, `README.md`, `LICENSE`
      and `package.json`
- [ ] The packed tarball installs and runs in a clean project outside the repository — this is
      what `npm run package:smoke` proves
- [ ] CI green on the commit being tagged
- [ ] Tag matches the manifest version exactly (`v1.0.2` for `1.0.2`)
- [ ] `package.json` and `package-lock.json` agree on the package _name_ as well as the version —
      `npm pkg set name` does not touch the lockfile, so a rename can half-apply. It did exactly
      that during the `1.0.2` scope fix: `npm pkg set name` left the lockfile on the old scope, and
      `npm install --package-lock-only` is what brings it back into agreement

## After the release

- [ ] GitHub Release exists, with the `.tgz` attached
- [ ] The attached tarball installs in a clean project
- [ ] The publish workflow ran and succeeded, in the `npm` environment
- [ ] `npm view @igkougkousis/chaos-proxy version` returns the version just released
- [ ] `npm view @igkougkousis/chaos-proxy dist-tags` has `latest` on it
- [ ] A clean project outside the repository installs it and imports `createProxyServer`
- [ ] `npm install -g @igkougkousis/chaos-proxy` puts a `chaos-proxy` command on `PATH`, and
      `chaos-proxy --version` prints the released version
- [ ] The package page shows the release as built from `igkougkousis01/chaos-proxy` by
      `publish.yml` — the provenance npm attaches automatically to an OIDC publish
- [ ] A fresh `## [Unreleased]` section opened in `CHANGELOG.md`

## npm publication: what is automated, and what is not

The one-time bootstrap that put `@igkougkousis/chaos-proxy@1.0.2` on the registry has run. It is
recorded in [npm publishing](npm-publishing.md) and is not repeated: npm versions are immutable,
and there is no second first publish.

What is automated, from `1.0.3` onwards, is everything. `.github/workflows/publish.yml` fires on
the GitHub Release from step 5, checks out that exact tag, re-verifies tag against manifest,
refuses a version the registry already has, re-runs the full gate and the package smoke test, and
publishes over OIDC. There is no npm token in this repository and none is needed.

What is **not** automated, and cannot be, is the trust configuration that makes it work. Both are
one-time, both are done in a browser, and both are outstanding until someone does them:

- [ ] The GitHub Environment `npm` exists (repository Settings → Environments), optionally with a
      required reviewer so publication pauses for approval
- [ ] The npm trusted publisher is configured on the package: owner `igkougkousis01`, repository
      `chaos-proxy`, workflow `publish.yml`, environment `npm` — every value the GitHub identity,
      never the `@igkougkousis` npm scope

Until both are done, the publish workflow runs, passes every check, and is rejected at
`npm publish`. That is the intended failure: visible, and at the last possible moment, rather than
a quiet fallback to some other credential.

Renaming `publish.yml` breaks publication until the trusted publisher is updated to match. The
filename is part of the trust relationship, not an implementation detail.
