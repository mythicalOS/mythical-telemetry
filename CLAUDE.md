# CLAUDE.md

Read `AGENTS.md` first — it is the harness-neutral source of truth and does not override your
active role contract. The import below loads it for Claude Code.

@AGENTS.md

Claude-specific notes:

- `collector-worker/` deploys are outward-facing (a live public ingest endpoint): confirm with
  the user first unless already authorized in this session.
