# syntax=docker/dockerfile:1

# Production runtime for the heartbeat collector.
#
# BUILD CONTEXT IS THE REPOSITORY ROOT, not this directory:
#
#     docker build -f collector/Dockerfile -t telemetry-collector .
#
# The collector depends on the published client package for the one canonical
# validator (see src/validator.ts), and that package is a workspace sibling, so
# the build must be able to see both. A context of `collector/` alone would
# resolve the validator from the registry instead of from the tree being built,
# which is exactly the drift this repository exists to prevent.
#
# Non-root `bun` user; configuration supplied at runtime via environment, never
# baked. The service binds a fixed 0.0.0.0:7910 inside the container; outward
# exposure and TLS belong to the operator's reverse proxy — see README.md,
# including the no-address-logs expectation and the trusted-proxy setting,
# which MUST match the real deployment.
# Pinned by INDEX digest, so the tag cannot be repointed under us and the same bytes resolve on
# amd64 and arm64 (both architectures are in this index).
# Checked 2026-09-09: Bun 1.4.2 is the current upstream release (bun-v1.4.2, 2026-09-05) and the
# tag Bun's own images track; Bun ships a single moving line with no LTS branch, so "current" is
# the only supported version.
# Re-check the lifecycle before changing this pin; never write a version from memory.
FROM oven/bun:1.4.2-alpine@sha256:d888c0ae6c86d7866ff10c5aafdd9077b36aee6455b33dd270fb93c0dd5cef6f

WORKDIR /app

# Manifests first, so a source-only change does not re-resolve dependencies.
# `bun.lock*` is a wildcard on purpose: the lockfile is optional here and its
# absence must not fail the build.
COPY package.json bun.lock* tsconfig.base.json ./
COPY collector/package.json ./collector/
# Every workspace named in the root manifest must have its manifest present, or
# the install resolves a workspace graph that does not match the one the lockfile
# was written from. Older Bun refuses outright ("Workspace not found"); newer Bun
# skips the member with a note and carries on. Neither behaviour is something to
# build on, so the manifest is copied — it is a few hundred bytes and it makes
# the install answer to the lockfile rather than to the installer's tolerance.
# Only the manifest: none of that service's source belongs in this image.
COPY collector-worker/package.json ./collector-worker/
COPY packages ./packages
RUN bun install --production

# Service source. Bun runs the .ts entrypoint natively.
COPY collector/tsconfig.json ./collector/
COPY collector/src ./collector/src

# The committed OpenAPI document. `src/server.ts` imports it statically and
# serves it verbatim at GET /openapi.json, so it is service source, not
# documentation: without it the entrypoint cannot resolve its own module graph
# and the container exits at boot with a module-not-found before it ever binds.
COPY api/openapi.json ./api/openapi.json

# Fixed internal bind port (EXPOSE documents it; the host publish lives in
# compose or the operator's orchestrator).
EXPOSE 7910

# Pre-create and chown the database mountpoint to the non-root `bun` uid BEFORE
# dropping privileges, so a fresh named volume mounted at /data inherits
# writable ownership.
RUN mkdir -p /data && chown bun:bun /data

USER bun

CMD ["bun", "collector/src/cli/server.ts"]
