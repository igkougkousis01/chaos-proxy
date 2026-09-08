# Release checklist

For maintainers. How a release is cut, from a merged version bump to a GitHub Release with a
tarball attached. `1.0.0` is the first.

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
4. **Tag it**: `git tag v1.0.0 && git push origin v1.0.0`. The tag must match the manifest exactly;
   `scripts/verify-release-tag.mjs` fails the release workflow if it does not.
5. **The release workflow runs** on that tag: it verifies the tag against the manifest, runs the
   full quality gate, runs the package smoke test, packs the tarball, and creates the GitHub
   Release with `chaos-proxy-1.0.0.tgz` attached.
6. **Publish to npm — currently blocked.** This is not automated and no npm token exists in this
   repository. It is also not currently possible: the name `chaos-proxy` on npm belongs to another
   maintainer and their own `1.0.0` is already published, so the name has to be settled before
   anything can ship. See [npm publishing](npm-publishing.md) for the conflict, the one manual
   bootstrap publish npm requires before OIDC can take over, and the trusted-publisher setup.

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
- [ ] Tag matches the manifest version exactly (`v1.0.0` for `1.0.0`)

## After the release

- [ ] GitHub Release exists, with the `.tgz` attached
- [ ] The attached tarball installs in a clean project
- [ ] A fresh `## [Unreleased]` section opened in `CHANGELOG.md`
