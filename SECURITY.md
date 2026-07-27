# Security Policy

This policy applies to every repository in the [mythicalOS](https://github.com/mythicalOS)
organisation unless that repository publishes its own `SECURITY.md`.

## Reporting a vulnerability

**Use GitHub private vulnerability reporting.** On the affected repository, open the
**Security** tab and choose **Report a vulnerability**. This opens a private advisory
visible only to you and the maintainers.

If private reporting is not enabled on the repository you are looking at, report it on
[this repository](https://github.com/mythicalOS/mythical-telemetry/security/advisories/new)
instead and say which repository is affected.

**Please do not** open a public issue, discussion, or pull request for a suspected
vulnerability, and please do not disclose it publicly before a fix is available.

## What to include

- The affected repository, version or commit, and platform.
- What an attacker can do — the impact, not just the defect.
- Minimal reproduction steps, or a proof of concept.
- Any suggested remediation, if you have one.

## What to expect

These projects are maintained by a very small team. Handling is best-effort, not contractual:

| Stage | Target |
|---|---|
| Acknowledgement of your report | within 5 business days |
| Initial assessment and severity | within 10 business days |
| Fix or documented mitigation | depends on severity and scope |

We will keep you updated as the report progresses and credit you in the advisory unless you
ask us not to. There is **no bug bounty** — we cannot offer payment.

## Scope

**In scope:** source code in this organisation's repositories, published `@mythicalos/*` npm
packages, and published container images.

**Out of scope:** findings that require a compromised host or a malicious operator who already
has administrative access; vulnerabilities in third-party dependencies (report those upstream,
though we do want to hear if we ship an affected version); and anything that depends on a
configuration the documentation explicitly warns against.

## Supported versions

Only the latest release of each package or image receives security fixes. Pre-1.0 projects
carry no backport guarantee.

## Disclosure

We coordinate disclosure with the reporter. Once a fix ships, we publish a GitHub Security
Advisory on the affected repository.
