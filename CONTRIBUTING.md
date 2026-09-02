# Contributing

Thanks for your interest. This applies to every repository in the
[mythicalOS](https://github.com/mythicalOS) organisation unless that repository publishes its
own `CONTRIBUTING.md`.

## Before you write code

**Open an issue first** for anything beyond an obvious fix. These projects are early and
opinionated; a change that looks small can cut against a design decision that isn't written
down yet. An issue costs you five minutes and can save you a rejected pull request.

Typo fixes, broken links, and clearly-wrong documentation need no issue — just send the pull
request.

## Developer Certificate of Origin (DCO)

Every commit must be signed off. By signing off you certify the
[Developer Certificate of Origin 1.1](https://developercertificate.org/) — in short, that you
wrote the contribution or otherwise have the right to submit it under the project's licence.

Sign off with `-s`:

```sh
git commit -s -m "fix: correct the token fallback order"
```

That appends a trailer to your commit message:

```
Signed-off-by: Your Name <your.email@example.com>
```

Use your real name and an address you can be reached at. Anonymous and pseudonymous sign-offs
cannot be accepted.

To sign off commits you already made:

```sh
git rebase --signoff main       # or: git commit --amend -s   (for the last commit only)
```

We do **not** require a Contributor Licence Agreement. Your contribution stays yours; you
licence it to the project under the repository's licence.

## Licence

Public repositories in this organisation are **Apache-2.0** unless their `LICENSE` file says
otherwise. Contributions are accepted under the same licence as the repository you are
contributing to. Do not paste code from a source under an incompatible licence.

Where the open-source product ends and the paid tier begins is stated in that repository's
README. It is worth reading before you invest time
in a large contribution: we take no copyright assignment and no relicensing right over your work,
and we do not move capabilities out of an open repository into the paid tier.

## Pull requests

- **One concern per pull request.** A refactor bundled with a bug fix is two pull requests.
- **Explain the why.** The diff shows what changed; the description should say what problem it
  solves and what alternatives you rejected.
- **Add a test** for any behaviour change. A bug fix should come with a test that fails before
  it and passes after.
- **Keep the existing style.** Match the surrounding code's naming, comment density, and
  idiom rather than importing conventions from elsewhere.
- **Green CI.** Pull requests with failing checks will not be reviewed.
- Maintainers squash-merge. You do not need to rewrite your history into one commit, but each
  commit must be signed off.

## Reporting bugs

Use the issue templates. A report we cannot reproduce cannot be fixed, so include versions,
platform, exact steps, and what you expected instead.

## Security

**Do not report vulnerabilities through issues or pull requests.** Follow
[SECURITY.md](SECURITY.md).

## Conduct

Participation is governed by the [Code of Conduct](CODE_OF_CONDUCT.md).
