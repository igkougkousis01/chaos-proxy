# Release checklist

For maintainers. How a release is cut, from a merged version bump to a GitHub Release with a
tarball attached. `1.0.0` was the first; `1.0.1` is the next, and is also the one that bootstraps
npm publication — see [the one-time npm bootstrap](#the-one-time-npm-bootstrap-for-101) below.

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
4. **Tag it**: `git tag v1.0.1 && git push origin v1.0.1`. The tag must match the manifest exactly;
   `scripts/verify-release-tag.mjs` fails the release workflow if it does not.
5. **The release workflow runs** on that tag: it verifies the tag against the manifest, runs the
   full quality gate, runs the package smoke test, packs the tarball, and creates the GitHub
   Release with the packed `.tgz` attached. The workflow globs whatever `npm pack` wrote rather
   than naming it, which matters now that the package is scoped: `@igkougkousis01/chaos-proxy`
   packs as `igkougkousis01-chaos-proxy-1.0.1.tgz`, with the scope flattened. Attach npm's own
   artifact under npm's own name; do not rename it.
6. **Publish to npm.** Not automated, and deliberately so for the first version — npm cannot grant
   a trusted publisher to a package that does not exist yet. For `1.0.1` that is the one-time
   bootstrap below. Afterwards it becomes a CI job over OIDC, with no token. See
   [npm publishing](npm-publishing.md) for the full reasoning.

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
- [ ] README is current, and claims nothing that is not true yet (npm availability especially)
- [ ] CHANGELOG has an entry for every user-visible change, under the version being released
- [ ] Version bumped in `package.json`, with `package-lock.json` agreeing
- [ ] `npm pack --dry-run` contents inspected — only `dist/`, `examples/`, `README.md`, `LICENSE`
      and `package.json`
- [ ] The packed tarball installs and runs in a clean project outside the repository — this is
      what `npm run package:smoke` proves
- [ ] CI green on the commit being tagged
- [ ] Tag matches the manifest version exactly (`v1.0.1` for `1.0.1`)
- [ ] `package.json` and `package-lock.json` agree on the package _name_ as well as the version —
      `npm pkg set name` does not touch the lockfile, so a rename can half-apply

## After the release

- [ ] GitHub Release exists, with the `.tgz` attached
- [ ] The attached tarball installs in a clean project
- [ ] A fresh `## [Unreleased]` section opened in `CHANGELOG.md`

## The one-time npm bootstrap, for `1.0.1`

This runs once, ever, and only after the GitHub Release above exists. It is separate from the
checklist above because none of it is part of cutting a release: it is what makes the package exist
on the registry so that every later release can publish itself.

The full reasoning — why the name is scoped, why the first publish cannot come from CI, and what
the trusted publisher needs — is in [npm publishing](npm-publishing.md). The order:

- [ ] `npm logout && npm login`, then `npm whoami` returns the account owning the
      `@igkougkousis01` scope
- [ ] Clean checkout of the tag, not of `main`: `git checkout v1.0.1` in a fresh clone or worktree
- [ ] `npm ci`
- [ ] `npm publish --dry-run` — confirm `@igkougkousis01/chaos-proxy@1.0.1`, access `public`, and
      the file list
- [ ] `npm publish` — 2FA prompts, and stays enabled
- [ ] `npm view @igkougkousis01/chaos-proxy version` returns `1.0.1`
- [ ] `npm view @igkougkousis01/chaos-proxy dist-tags` has `latest` on `1.0.1`
- [ ] A clean project outside the repository installs it and imports `createProxyServer`
- [ ] `npm install -g @igkougkousis01/chaos-proxy@1.0.1` puts a `chaos-proxy` command on `PATH`,
      and `chaos-proxy --version` prints `1.0.1`
- [ ] Configure the npm trusted publisher on the now-existing package
- [ ] README updated to say the package is on npm — it currently says it is not, and that is the
      last thing to change, not the first
- [ ] `.github/workflows/publish.yml` added in a follow-up PR, over OIDC, with no token

After that, publication is part of the release rather than an appendix to it, and this section can
go.
