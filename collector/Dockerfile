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
FROM oven/bun:1.3.13-alpine@sha256:4de475389889577f346c636f956b42a5c31501b654664e9ae5726f94d7bb5349

WORKDIR /app

# Manifests first, so a source-only change does not re-resolve dependencies.
# `bun.lock*` is a wildcard on purpose: the lockfile is optional here and its
# absence must not fail the build.
COPY package.json bun.lock* tsconfig.base.json ./
COPY collector/package.json ./collector/
COPY packages ./packages
RUN bun install --production

# Service source. Bun runs the .ts entrypoint natively.
COPY collector/tsconfig.json ./collector/
COPY collector/src ./collector/src

# Fixed internal bind port (EXPOSE documents it; the host publish lives in
# compose or the operator's orchestrator).
EXPOSE 7910

# Pre-create and chown the database mountpoint to the non-root `bun` uid BEFORE
# dropping privileges, so a fresh named volume mounted at /data inherits
# writable ownership.
RUN mkdir -p /data && chown bun:bun /data

USER bun

CMD ["bun", "collector/src/cli/server.ts"]
