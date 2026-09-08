# npm publishing

For maintainers. What has to be true before `chaos-proxy` can be installed from the registry, and
what the automation around that will look like once it can be.

This document exists because the answer to "can we publish?" turned out to be no, for a reason that
no amount of repository-side work can fix. Writing that down is more useful than a workflow that
would never have run.

## Status: blocked on the package name

`chaos-proxy` on npm is not ours.

|                    |                                                              |
| ------------------ | ------------------------------------------------------------ |
| Owner              | `gkoos` (Gabor Koos)                                         |
| Repository         | `https://github.com/gkoos/chaos-proxy` — a different project |
| Versions published | 11, from `0.0.1` to `1.0.0`                                  |
| `1.0.0` published  | 2025-09-25                                                   |
| Current `latest`   | `1.0.0`, deprecated in favour of `@fetchkit/chaos-proxy`     |

Two separate things follow from that, and the second is the one that matters:

1. We are not a maintainer, so `npm publish` under that name returns `403`.
2. **`chaos-proxy@1.0.0` already exists and belongs to someone else.** npm versions are immutable and
   are never reissued, so even if the name were transferred tomorrow, `1.0.0` — the version this
   project has tagged and released — could not be published under it. There is no version of this
   problem that ends with our `1.0.0` at that coordinate.

The name being deprecated upstream does not free it. Deprecation is a warning attached to a version;
it does not release the name, and it does not make the version numbers available again.

So publication is blocked on a decision that only the maintainer can make, and it is a naming
decision, not a permissions one.

### What the maintainer has to decide

Pick a name. The obvious candidate is the user scope, which is unregistered and therefore free:

```
@igkougkousis01/chaos-proxy
```

A scoped package sidesteps the conflict completely: the scope is owned by the account, `1.0.0` in it
is unused, and the binary can still be called `chaos-proxy` — `bin` names are not namespaced, so
`npx @igkougkousis01/chaos-proxy` and a globally installed `chaos-proxy` command both still work.

Nothing in this repository has been renamed. `package.json` still says `chaos-proxy`, because
changing the published identity of a project is the maintainer's call and because the rename has a
consequence worth being deliberate about: a scoped package **must** be published with
`--access public`, or npm defaults it to private. The manifest already carries
`publishConfig.access: "public"`, which covers that for either name.

## The bootstrap problem

Once the name is settled, the first publication cannot be automated. This is a hard npm limitation,
not a preference:

> The package you're configuring must already exist on the npm registry.
> — [`npm trust` documentation](https://docs.npmjs.com/cli/v11/commands/npm-trust/)

A trusted publisher is configured in a _package's_ settings, and a package that has never been
published has no settings to configure. Unlike PyPI, npm has no pending-publisher concept. So the
order is fixed and cannot be rearranged:

```
1. maintainer publishes the first version manually, from a laptop
2. maintainer configures the trusted publisher on the now-existing package
3. every later version publishes from CI over OIDC, with no token
```

Step 1 is the one manual publish this project should ever need.

## Requirements

|      | Required     | This machine                           |
| ---- | ------------ | -------------------------------------- |
| npm  | `>= 11.5.1`  | `10.9.4` — too old, has no `npm trust` |
| Node | `>= 22.14.0` | `22.21.1` — fine                       |

These are release-tooling requirements and have nothing to do with what consumers need. The package
keeps `engines.node: ">=22.12"`; a publish job would pin newer tooling for itself alone.

## Setup, when the name is resolved

Ordered, and every step is the maintainer's to run. None of it can be done from this repository.

### 1. Bootstrap the first version manually

From a clean checkout of the release tag — not `main`, see below:

```bash
git clone https://github.com/igkougkousis01/chaos-proxy /tmp/publish-checkout
cd /tmp/publish-checkout && git checkout v1.0.0
npm ci
npm publish --dry-run   # inspect first
npm publish
```

`prepack` rebuilds `dist/` as part of packing, so a stale build cannot ship. Requires `npm whoami` to
return the right account, and npm will prompt for 2FA — which should stay enabled.

### 2. Configure the trusted publisher

Either on npmjs.com, under the package's Settings → Trusted Publisher, or with npm `>= 11.5.1`:

```bash
npm trust github --repo igkougkousis01/chaos-proxy --file publish.yml
```

The fields npm asks for:

| Field                | Value                                   |
| -------------------- | --------------------------------------- |
| Organization or user | `igkougkousis01`                        |
| Repository           | `chaos-proxy`                           |
| Workflow filename    | `publish.yml`                           |
| Environment          | `npm`, if the environment below is used |

The workflow filename is part of the trust relationship, so it has to be decided before this step
and cannot drift afterwards without updating the publisher.

### 3. Create the `npm` GitHub Environment

In the repository's Settings → Environments. Worth doing: it gives the publish job a deployment
record, an optional required reviewer, and a policy boundary that a bare workflow does not have. If
the trusted publisher names an environment, the workflow must use the same one or OIDC will be
rejected.

## The workflow, once it can exist

Not shipped. `.github/workflows/publish.yml` is deliberately absent, because a workflow that names a
package we cannot publish is worse than no workflow: it looks like infrastructure, it passes review,
and the first thing it does when someone finally enables it is fail on a `403` from a name that was
never ours. It should be written against the name that is actually chosen.

The design it should follow:

```yaml
on:
  release:
    types: [published] # follows a successful GitHub Release, never a branch push

permissions:
  contents: read
  id-token: write # the OIDC token; nothing else

jobs:
  publish:
    runs-on: ubuntu-latest # trusted publishing requires a hosted runner
    environment: npm
    steps:
      # check out the release tag, never the branch head
      # setup-node, then ensure npm >= 11.5.1
      # npm ci
      # npm run release:verify-tag -- "$TAG"
      # npm run check && npm run package:smoke
      # npm publish --dry-run
      # guard: fail if this version is already on the registry
      # npm publish
```

Points that are decisions rather than boilerplate:

- **`release: published`, not `push: tags`.** npm publication should follow a GitHub Release that
  already succeeded, rather than racing the release workflow on the same tag.
- **`release.yml` is not touched.** GitHub Release creation and npm publication stay in separate
  workflows so that a fault in one cannot take out the other. `release.yml` needs `contents: write`
  and no OIDC; a publish job needs `id-token: write` and no write access. Neither should hold the
  other's permissions.
- **Reuse `scripts/verify-release-tag.mjs`.** There should not be a second answer to "which version
  is this".
- **An already-published guard.** npm versions are immutable, so a re-run must not attempt a
  republish. Fail loudly rather than exiting quietly — a publish job that silently does nothing is
  indistinguishable from one that worked.
- **No `NPM_TOKEN` or `NODE_AUTH_TOKEN`, ever.** That is the entire point of trusted publishing: no
  long-lived credential exists to leak. Provenance attestations are generated automatically for a
  public package published over OIDC from a public repository, so there is nothing to configure and
  nothing to switch off.

## Publish from the tag, not from `main`

`v1.0.0` is already tagged and released. Anything merged after it — including this document — is not
part of that release, so the npm artifact for `1.0.0` must be built from `v1.0.0` and not from
whatever `main` has become.

This has been verified rather than assumed. Packing from a clean worktree of `v1.0.0` produces:

```
sha256  402f096d80e7152092ca6c2537241d6adbb909bf805ff820cfabf1df0a4bd1d4
```

which is byte-for-byte the digest GitHub records for `chaos-proxy-1.0.0.tgz` on the `v1.0.0`
release. The tag is publishable as it stands: 32 files, 56.4 kB packed, 180.0 kB unpacked, correct
`bin`, `exports`, `files` and repository metadata. The tag must not be moved, retagged or amended to
make publication work.

## After a real publication

Only once the package actually exists. Confirm the registry agrees with the release:

```bash
npm view <name> version
npm view <name> dist
npm view <name> repository
```

Then, in a clean directory outside the repository, prove a stranger's install works:

```bash
cd "$(mktemp -d)" && npm init -y && npm install <name>@1.0.0
npx chaos-proxy --version
npx chaos-proxy --help
node -e "import('chaos-proxy').then(m => console.log(Object.keys(m)))"
```

and drive one request through the proxy. `npm run package:smoke` does all of this against a locally
packed tarball already; this repeats it against what the registry actually served.

Only then update the README. It currently says the package is not on npm, which is true and should
stay until it is not.

## Dist-tag

The first public release takes `latest`, which is npm's default. No `next` or `beta` tags — this
project has no pre-release channel and inventing one at publication time would be surprising.
