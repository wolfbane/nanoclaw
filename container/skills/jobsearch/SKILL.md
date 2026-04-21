---
name: jobsearch
description: Matthew's job-search tooling via the `jobsearch26` CLI. Invoke when the user asks about job search, job applications, job leads, recruiters, interviews, resume/CV status, or `jobsearch26`. Note the charter is paused as of 2026-04-21 (Marc was hired) — historical queries only.
---

# Job search — `jobsearch26` CLI

**Status: charter paused 2026-04-21** (Marc was hired). Mount retained at `/workspace/extra/jobsearch26` for historical queries only — not a priority.

## Preflight — check the mount

```bash
test -d /workspace/extra/jobsearch26 && echo "jobsearch26: yes" || echo "jobsearch26: NO"
```

If absent, the group you're in doesn't have jobsearch access — say so and stop.

## Always check the project's own docs first

The `jobsearch26` project has its own `CLAUDE.md` and `README.md` — read them before running commands:

```bash
cat /workspace/extra/jobsearch26/CLAUDE.md
cat /workspace/extra/jobsearch26/README.md
```

## Invocation

```bash
uv run --project /workspace/extra/jobsearch26 jobsearch26 <command>
```

Use `--help` on the CLI for the current command set (the project evolves — don't trust hard-coded examples here).
