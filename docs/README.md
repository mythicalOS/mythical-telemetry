<!-- Governed by the maintainer's documentation policy; keep this file's rules intact when editing. -->

# docs/

Public documentation for this project: what it is, how to install and configure it, how to use it,
and how it is put together as shipped. If you are a contributor or an agent working in this
repository, read this page before adding or editing anything under `docs/`.

## What belongs here

- **README / index** — this file: what the directory holds and where to start.
- **Install and configuration** — requirements, install steps, configuration and environment
  reference, upgrade, uninstall.
- **Usage guides** — task-shaped how-tos for the surface that actually ships.
- **Architecture as shipped** — components, data flow, boundaries and ports of the current tree.
- **API and field reference** — endpoints, schemas, wire formats, CLI options, emitted fields.
- **Troubleshooting** — symptoms, causes, diagnostics, and honestly stated limitations.
- **Changelog and release notes** — what changed in released versions.
- **Contribution-facing docs** — development setup, running the tests, code layout, release steps.

Community-health files (`CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, `SUPPORT.md`,
`LICENSE`, `NOTICE`) live at the repository root, not here.

## What must never appear here

Treat everything committed here as public. This documentation is written for public release, and
once the repository is public, file contents **and commit messages** stay retrievable permanently —
deleting something later does not retract it.

- **Secrets**: keys, tokens, credentials, connection strings. Including expired or example-looking
  ones.
- **Internal identifiers**: private hostnames or IP addresses, chat workspace or channel IDs,
  session identifiers, internal-only URLs, local filesystem paths that name a person or machine.
- **Personal data**: real names, email addresses, or any author identity other than the configured
  repository identity. Write "the maintainer".
- **Internal planning and decision records**: plans, requirement documents, task briefs, status
  reports, retrospectives, review verdicts, risk assessments, roadmaps of unshipped work, or
  milestone and phase codenames.
- **References to maintainer-internal repositories or tooling**: anything not part of this
  repository and not published is not named here, and is not linked or alluded to.

Sibling projects that are public, or approved for public release, may be named.

**When you cannot tell.** Some of the above is mechanical, and some is not: a name or path can look
ordinary and still be internal. Two rules close that gap. First, if this repository runs a content
check in CI, it is a **floor, not a ceiling** — passing it is not evidence that a doubtful string is
publishable. Second, when you are unsure whether something may be published, **leave it out and ask
the maintainer in the pull request** rather than guessing. Omitting a publishable detail costs a
review round; publishing an unpublishable one cannot be undone.

## Document what is shipped, in the tense it deserves

Every claim these docs make about what the software does for a user must be backed by what is in
this repository. Describe shipped behaviour in the present tense; describe unshipped or undeployed
things not at all. Do not document an endpoint, flag, or field that does not exist yet. Do not
strengthen a hedge: if a check verifies shape and not correctness, say shape. Never invent,
approximate, or infer a measured result — a number in these docs comes from a run that happened.

Maintainer-internal planning and coordination happen outside this repository. Nothing here needs to
reference them, and nothing here should.

## Checklist before adding a doc

1. Is it one of the genres listed above? If not, it does not belong in this repository.
2. Does every claim in it hold true of the code in this tree, right now?
3. Any secrets, internal hostnames or IDs, personal names or email addresses, machine-local paths?
4. Any internal planning, review, or decision content — or a pointer to maintainer-internal tooling?
5. Does your **commit message** pass checks 3 and 4 as well? Messages are as public as files.
6. Sign off your commit (`git commit -s`) and stage explicit paths rather than everything.

---

## What is here

- **[`FIELDS.md`](FIELDS.md)** — the heartbeat field contract. Every field a product may send, with
  its producer, value class and temporal class; the delta-normalisation rules a cumulative counter
  passes through before it reaches the wire; what a collector must do with an instance's first
  heartbeat; and the review a new field requires.

The repository's own overview — what the client and the two collectors are, how identity is derived,
and where heartbeats go — is in the [top-level README](../README.md).
