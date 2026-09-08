# npm publishing

For maintainers. Which name this package publishes under, why that is not the obvious one, and the
one manual step npm requires before publication can be automated.

## The name

```
@igkougkousis/chaos-proxy
```

Scoped, and settled. The unscoped package name `chaos-proxy` is already owned by another npm user,
so this project publishes under a scope instead.

**The scope is the maintainer's npm username, `igkougkousis`, which is not the GitHub username.**
That is the correction `1.0.2` exists to make. npm scopes belong to npm accounts; an account can
only publish into the scope matching its own name (or an org it belongs to), and no amount of
matching the GitHub identity changes that. `1.0.1` named the package `@igkougkousis01/chaos-proxy`
after the GitHub username, which is a scope this account does not own and cannot publish into.

`npm whoami` is the authority on which scope is available, and it prints:

```
igkougkousis
```

So there are two identities in play, they differ by two characters, and confusing them is the
whole of the bug being fixed here:

| Identity          | Value            | Where it applies                                        |
| ----------------- | ---------------- | ------------------------------------------------------- |
| npm account/scope | `igkougkousis`   | The package name, and only the package name             |
| GitHub user/repo  | `igkougkousis01` | Clone URLs, issue links, the trusted-publisher settings |

What matters beyond that, and is equally easy to get wrong, is that only the _package_ is scoped:

| Thing             | Name                                            |
| ----------------- | ----------------------------------------------- |
| npm package       | `@igkougkousis/chaos-proxy`                     |
| CLI executable    | `chaos-proxy`                                   |
| GitHub repository | `igkougkousis01/chaos-proxy`                    |
| Import specifier  | `import { … } from '@igkougkousis/chaos-proxy'` |

`bin` names are not namespaced, so a globally installed package still puts a plain `chaos-proxy` on
the `PATH`, and every documented invocation is unchanged. Renaming the binary to match the package
would be a breaking change made for no reason.

### The conflict, for the record

`chaos-proxy` on npm belongs to `gkoos` (Gabor Koos), whose package of that name is a different
project at `https://github.com/gkoos/chaos-proxy`. Eleven versions are published, `0.0.1` through
`1.0.0`, with `1.0.0` dating from 2025-09-25 and now deprecated in favour of
`@fetchkit/chaos-proxy`.

Two things follow, and the second is the one that decided the version number:

1. We are not a maintainer of it, so `npm publish` under that name returns `403`.
2. **`chaos-proxy@1.0.0` already exists and is not ours.** npm versions are immutable and are never
   reissued, so even if the name were transferred tomorrow, `1.0.0` — the version this project has
   already tagged and released — could not be published at that coordinate.

Deprecation upstream does not free the name. It is a warning attached to a version; it releases
nothing and makes no version number available again.

A scoped package sidesteps all of it: the scope belongs to the account, and nothing is published in
it yet.

## Why `1.0.2` and not a re-cut `1.0.1`

`v1.0.0` and `v1.0.1` are both already tagged here and already released on GitHub, with verified
artifacts attached. They stay exactly as they are. Retagging a released version to correct a
registry name would trade a true release history for a tidier-looking one, and `git show
v1.0.1:package.json` should keep saying `@igkougkousis01/chaos-proxy` — that is what this project
believed at the time, and it is a fact about the release rather than a mistake to be erased.

Nothing was published under the wrong name, so there is no registry state to undo. The publish
attempt for `@igkougkousis01/chaos-proxy@1.0.1` failed, which is exactly what an unowned scope
does, and a failed publish creates no package: `npm view @igkougkousis01/chaos-proxy` returns
`E404`. Only the repository was ever wrong.

So the first npm publication is `@igkougkousis/chaos-proxy@1.0.2`, and `1.0.2` exists for that
reason alone. It fixes no bug and changes no behaviour — the only difference from `1.0.1` is the
scope the package is published under, and the docs and packaging checks that follow from it.

## The bootstrap problem

The first publication cannot be automated. This is a hard npm limitation, not a preference:

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

## Requirements for the bootstrap

|      | Required for                | Notes                                 |
| ---- | --------------------------- | ------------------------------------- |
| Node | `>= 22.14.0`                | Release tooling only                  |
| npm  | `>= 11.5.1` for `npm trust` | The publish itself works on older npm |

These are release-tooling requirements and say nothing about what consumers need. The package keeps
`engines.node: ">=22.12"`, which is not changed to suit a publishing step.

The npm CLI on the machine last used for this was `10.9.4`, which has no `npm trust` subcommand. The
bootstrap publish in step 1 does not need it; step 2 does, so either upgrade the npm CLI for that
step or configure the trusted publisher on npmjs.com instead, which needs no particular CLI version.

## Authentication

Before publishing, get to a known-good login rather than assuming the machine already has one:

```bash
npm logout
npm login
npm whoami
```

`npm whoami` must print `igkougkousis`, the account that owns the `@igkougkousis` scope. This is
the check that `1.0.1` was missing: run it _before_ the publish rather than discovering the scope
mismatch from a rejection. If it prints anything else, the publish below will fail, and no amount
of retrying will change that — fix the login first. Keep 2FA enabled — npm will prompt for it at
publish time, and that prompt is the point.

No token is created, stored, or copied into repository settings for any of this. The entire reason
for moving to a trusted publisher afterwards is that no long-lived credential has to exist.

## 1. Bootstrap the first version manually

From a clean checkout of the release tag, never from `main` or a branch head. Anything merged after
the tag is not part of the release, and the artifact must be built from what was tagged:

```bash
git clone https://github.com/igkougkousis01/chaos-proxy /tmp/publish-checkout
cd /tmp/publish-checkout && git checkout v1.0.2
npm ci
npm whoami                          # igkougkousis, before anything else
npm publish --dry-run --access public   # inspect first
npm publish --access public
```

`--access public` is passed explicitly rather than left to `publishConfig`. The manifest sets it
too, and either alone is sufficient — but this is the one publish where a silent default to
`restricted` would be least recoverable, and stating it on the command line means the intent is
visible in the shell history of the one command that mattered.

`prepack` rebuilds `dist/` as part of packing, so a stale build cannot ship.

Three things to check in the `--dry-run` output before running the real thing:

- the package is `@igkougkousis/chaos-proxy@1.0.2` — with one `igkougkousis`, not the GitHub
  `igkougkousis01`, which is the entire subject of this version;
- access is `public` — `publishConfig` in the manifest sets that, and without it npm would default
  a scoped package to restricted and publish it privately without complaining;
- the tarball is `igkougkousis-chaos-proxy-1.0.2.tgz`. npm flattens the scope into the filename
  rather than preserving it, which is worth knowing before it surprises a script. Nothing in this
  repository constructs that name — `npm pack --json` is asked for it — and nothing should start.

## 2. Configure the trusted publisher

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

The repository is the GitHub one, so every value in that table is `igkougkousis01` — the trusted
publisher describes where the code is, not what the package is called. The package name is the only
place `@igkougkousis` appears. The workflow filename is part of the trust relationship, so it has
to be decided before this step and cannot drift afterwards without updating the publisher.

## 3. Create the `npm` GitHub Environment

In the repository's Settings → Environments. Worth doing: it gives the publish job a deployment
record, an optional required reviewer, and a policy boundary that a bare workflow does not have. If
the trusted publisher names an environment, the workflow must use the same one or OIDC will be
rejected.

## 4. Add the publish workflow

`.github/workflows/publish.yml` is deliberately absent until the three steps above are done. A
workflow that publishes cannot succeed before the package exists and the trusted publisher is
configured, and one that sits in the repository looking like working infrastructure until the first
time anyone relies on it is worse than none.

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
  is this". It compares the tag to the manifest version and is indifferent to the package name, so
  the rename did not affect it.
- **An already-published guard.** npm versions are immutable, so a re-run must not attempt a
  republish. Fail loudly rather than exiting quietly — a publish job that silently does nothing is
  indistinguishable from one that worked.
- **No `NPM_TOKEN` or `NODE_AUTH_TOKEN`, ever.** That is the entire point of trusted publishing: no
  long-lived credential exists to leak. Provenance attestations are generated automatically for a
  public package published over OIDC from a public repository, so there is nothing to configure and
  nothing to switch off.

## After a real publication

Only once the package actually exists. Confirm the registry agrees with the release:

```bash
npm view @igkougkousis/chaos-proxy version
npm view @igkougkousis/chaos-proxy dist-tags
npm view @igkougkousis/chaos-proxy repository
```

Then, in a clean directory outside the repository, prove a stranger's install works:

```bash
cd "$(mktemp -d)" && npm init -y
npm install @igkougkousis/chaos-proxy@1.0.2
node -e "import('@igkougkousis/chaos-proxy').then(m => console.log(Object.keys(m)))"
```

and the global CLI install, which is where the package/binary distinction shows up in practice:

```bash
npm install -g @igkougkousis/chaos-proxy@1.0.2
chaos-proxy --version   # 1.0.2
chaos-proxy --help
```

Then drive one request through the proxy. `npm run package:smoke` does all of this against a locally
packed tarball already; this repeats it against what the registry actually served.

Only then update the README. It currently says the package is not on npm, which is true and should
stay until it is not.

## Dist-tag

The first public release takes `latest`, which is npm's default. No `next` or `beta` tags — this
project has no pre-release channel and inventing one at publication time would be surprising.
