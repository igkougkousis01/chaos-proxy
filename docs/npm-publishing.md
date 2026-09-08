# npm publishing

For maintainers. Which name this package publishes under, why that is not the obvious one, the one
manual step npm required before publication could be automated, and how every release publishes
itself now that it is done.

## Where this stands

| Fact                 | Value                                                        |
| -------------------- | ------------------------------------------------------------ |
| First npm release    | `@igkougkousis/chaos-proxy@1.0.2`                            |
| How it was published | Manual bootstrap, by hand, from a clean checkout of `v1.0.2` |
| Bootstrap status     | **Done.** It runs once, ever, and it has run                 |
| Every later release  | `.github/workflows/publish.yml`, over OIDC, with no token    |
| Current `latest`     | `1.0.2`                                                      |

The bootstrap section below is kept as the record of what was done and why, not as a step to
repeat. What is still outstanding is the npm-side and GitHub-side configuration in
[After the bootstrap](#after-the-bootstrap-configuring-the-trusted-publisher), without which the
publish workflow will run and be rejected at the last step.

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

A scoped package sidesteps all of it: the scope belongs to the account, and `1.0.2` is published in
it.

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

The first publication could not be automated. This is a hard npm limitation, not a preference:

> The package you're configuring must already exist on the npm registry.
> — [`npm trust` documentation](https://docs.npmjs.com/cli/v11/commands/npm-trust/)

A trusted publisher is configured in a _package's_ settings, and a package that has never been
published has no settings to configure. Unlike PyPI, npm has no pending-publisher concept. So the
order was fixed and could not be rearranged:

```
1. maintainer publishes the first version manually, from a laptop   (done: 1.0.2)
2. maintainer configures the trusted publisher on the now-existing package
3. every later version publishes from CI over OIDC, with no token
```

Step 1 was the one manual publish this project should ever need, and it has happened. Everything
below is either the record of it or the two steps that follow from it.

## Tooling versions

Three different minimums, easily confused, and only the first one is about consumers:

| Applies to                   | Requirement                        | Where it is enforced                               |
| ---------------------------- | ---------------------------------- | -------------------------------------------------- |
| Consumers running the CLI    | Node `>= 22.12`                    | `engines.node` in the manifest                     |
| Publishing over OIDC         | Node `>= 22.14.0`, npm `>= 11.5.1` | The publish workflow's Node 24 job                 |
| The `npm trust` CLI, locally | npm `>= 11.15.0`                   | Nowhere — it is a maintainer's laptop, run by hand |

The publishing requirements say nothing about what consumers need, and `engines.node` is not
widened to suit a publishing step. The Node 22 line bundles npm 10.x, which is why the publish
workflow runs on Node 24: it currently bundles npm 11.19, and the workflow checks rather than
assumes, topping up to `npm@^11.5.1` if a future Node 24 patch ships something older.

`npm trust` is stricter still, and it is the only piece that needs npm `>= 11.15.0`. The npm CLI on
the machine last used for this was `10.9.4`, which has no `npm trust` subcommand at all — so either
upgrade npm locally for that one command, or configure the trusted publisher on npmjs.com instead,
which needs no particular CLI version and is the route this project recommends.

## Authentication, for the manual bootstrap

This section applies to the one hand-typed publish below and to nothing else. Automated
publication authenticates over OIDC and needs no login at all.

Before publishing by hand, get to a known-good login rather than assuming the machine already has
one:

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

## 1. Bootstrap the first version manually — done

This ran once, for `1.0.2`, and is kept as the record of what was done. It is not a step to repeat:
`1.0.3` and everything after it publish from CI.

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

## After the bootstrap: configuring the trusted publisher

Two manual steps remain, both in a browser, both outstanding. `.github/workflows/publish.yml`
exists and will run on the next release — it will pass every check and be rejected at
`npm publish` until these are done, which is the right way round: a rejection is visible, and a
publish that quietly used a token would not be.

Neither can be done from this repository, and neither should be attempted from CI.

### 2. Create the `npm` GitHub Environment

Repository **Settings → Environments → New environment**, named exactly:

```
npm
```

The publish job already declares `environment: npm`. Creating it gives the publish a deployment
record, somewhere to attach a required reviewer if publication should need a human, and a policy
boundary a bare workflow does not have. It is created first because the trusted publisher below
names it, and the two have to agree.

Optional but worth considering: add yourself as a **required reviewer**. Publication then pauses
for an approval instead of happening the moment a release is published, which costs one click per
release and makes an accidental release recoverable.

### 3. Configure the npm trusted publisher

On npmjs.com: the package page → **Settings → Trusted Publisher → GitHub Actions**. The four
fields, and the exact values:

| Field                | Value            |
| -------------------- | ---------------- |
| Organization or user | `igkougkousis01` |
| Repository           | `chaos-proxy`    |
| Workflow filename    | `publish.yml`    |
| Environment          | `npm`            |

**Every value in that table is the GitHub identity, `igkougkousis01`.** The trusted publisher
describes where the code is, not what the package is called; `@igkougkousis` is the npm scope and
appears in the package name and nowhere in this configuration. The two strings differ by two
characters and this is the single easiest place in the project to get them the wrong way round.

The workflow filename is part of the trust relationship. Renaming `publish.yml` breaks publication
until the trusted publisher is updated to match, which is why the file is named in this document
and asserted in the test suite.

There is a CLI equivalent, if npm `>= 11.15.0` is installed locally:

```bash
npm trust github @igkougkousis/chaos-proxy \
  --repo igkougkousis01/chaos-proxy \
  --file publish.yml \
  --env npm \
  --allow-publish
```

It requires write access to the package and account-level 2FA. The browser route needs no
particular CLI version and is the recommended one; the command is recorded here so that nobody has
to reconstruct its flags.

## How automated publication works

`.github/workflows/publish.yml`. What it does, and why each part is the way it is:

| Step                         | What it does                                                            |
| ---------------------------- | ----------------------------------------------------------------------- |
| Trigger                      | `release: published` — never a branch push, never a manual dispatch     |
| Checkout                     | `ref: github.event.release.tag_name`, the exact released tag            |
| Node                         | 24, with npm topped up to `^11.5.1` if the bundled one is older         |
| `release:verify-tag`         | The tag and the manifest must name the same version                     |
| `release:verify-publishable` | The package name is the expected one, and this version is not published |
| `npm run check`              | Typecheck, lint, format, test, build                                    |
| `npm run package:smoke`      | Pack, install into a throwaway project, drive the result                |
| `npm publish --dry-run`      | What would be sent, before anything is immutable                        |
| `npm publish`                | `--access public`, over OIDC, no token                                  |

Points that are decisions rather than boilerplate:

- **`release: published`, not `push: tags`.** npm publication follows a GitHub Release that already
  succeeded, rather than racing the release workflow on the same tag.
- **The exact tag is checked out.** Not `main`, and not `github.sha` — for a release event that is
  the commit the tag pointed at when the event fired, which is close enough to be misleading and
  is not what the release is named after. Publishing a branch head would ship code that was never
  released.
- **`release.yml` is untouched.** GitHub Release creation and npm publication are separate
  workflows so a fault in one cannot take out the other, and so neither holds the other's
  permissions: `release.yml` needs `contents: write` and no OIDC; the publish job needs
  `id-token: write` and no write access at all.
- **`scripts/verify-release-tag.mjs` is reused.** There is one answer to "which version is this".
  It compares the tag to the manifest and is indifferent to the package name.
- **The already-published guard is its own script.** `scripts/verify-publishable.mjs` asks the
  registry, and the reason it is a script rather than a line of shell is that `npm view` exits
  non-zero both for "no such version" and for "could not reach the registry". It reads npm's own
  `--json` error code: `E404` means the version is free, a success with a version means it is
  taken and the run stops, and anything else — a 5xx, a timeout, DNS, an npm that crashed — stops
  the run too. Publishing through an outage is the one failure here that cannot be undone.
- **Drafts and pre-releases are refused.** By a job-level `if`, so they produce no run at all
  rather than a red one to explain. This project publishes only to `latest` and has no
  pre-release channel; a pre-release landing in `latest` would hand every plain `npm install` a
  version never meant for it.
- **A duplicate publish fails loudly.** Never a quiet success: a publish job that silently does
  nothing is indistinguishable from one that worked, and the difference surfaces only when
  somebody goes looking for a version that was never published.
- **Concurrency is per release tag, and never cancelled.** Two runs for the same release cannot
  overlap, and an in-flight publish is not killed by a later one.
- **No `NPM_TOKEN` or `NODE_AUTH_TOKEN`, ever.** That is the entire point of trusted publishing:
  no long-lived credential exists to leak. A test asserts that no workflow in the repository
  mentions either.
- **No `--provenance`.** npm generates a provenance attestation automatically for a public package
  published over OIDC from a public repository. Passing the flag is not required and is not a way
  to get more of it; it is also never disabled.

## Verifying a publication

After any publish, manual or automated. Done for `1.0.2`, and all of it passed. Confirm the
registry agrees with the release — substitute the version being checked:

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

For an automated publish there is one more thing to look at, which a manual one cannot produce: the
package page on npmjs.com should show the release as built from this repository's workflow, with no
token involved. npm generates that attestation automatically for a public package published over
OIDC from a public repository. What the page calls it is npm's to change, so it is not quoted here
— the thing to confirm is that it points at `igkougkousis01/chaos-proxy` and at `publish.yml`.

The README says the package is on npm. That was flipped once, deliberately, after `1.0.2` was
verified — not before.

## Dist-tag

Every release takes `latest`, which is npm's default, and `1.0.2` holds it now. No `next`, `beta`,
`alpha` or `canary` — this project has no pre-release channel, the publish workflow refuses a
GitHub pre-release outright, and inventing a channel at publication time would be surprising.

## The next release

The full sequence is in [the release checklist](release-checklist.md). In short, once the two
configuration steps above are done, `1.0.3` needs no publishing step at all: bump, tag, push, and
the GitHub Release triggers the publish workflow. The only new thing to watch the first time is
whether the trusted publisher was configured correctly, and the failure mode if it was not is a
rejected `npm publish` at the end of a run that otherwise passed.
