# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# NanoClaw

Personal Claude assistant. See [README.md](README.md) for philosophy and setup. See [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) for architecture decisions. See [docs/SECURITY.md](docs/SECURITY.md) for the trust model.

## Architecture

Single Node.js host process that owns channels, storage, scheduling, and a credential proxy. Each incoming message spawns (or pipes into) an Apple Container running the Claude Agent SDK. Per-group filesystem and memory isolation is enforced via mounts, not application-level checks.

**Message flow** (inbound → user reply):
1. Channel adapter (`src/channels/*.ts`) receives a message, calls `onMessage()`, row written to SQLite.
2. Message loop in `src/index.ts` polls the DB every 2s. Non-main groups require the trigger word (`@${ASSISTANT_NAME}`); main group bypasses it.
3. Session slash-commands (e.g. `/compact`) intercepted before agent spawn (`src/session-commands.ts`).
4. `src/container-runner.ts` spawns a container with per-group mounts and streams stdin JSON. If a container is already active for the group, the message is *piped* in via MessageStream instead of spawning a fresh one.
5. Agent output is wrapped in `OUTPUT_START_MARKER`/`OUTPUT_END_MARKER`; host parses each JSON chunk, strips `<internal>...</internal>` reasoning blocks in `src/router.ts`, and routes to the channel.
6. Agent-side IPC (writes to `/workspace/ipc/{messages,tasks}/` → `src/ipc.ts` watcher, polling every 1s) is how the agent sends proactive messages, schedules tasks, or registers groups. The host writes a delivery ack to `/workspace/ipc/acks/` per request; the agent's `mcp__nanoclaw__send_message` polls for the ack so failures surface at tool-call time instead of fire-and-forget.
7. Every host→channel send is audited in the `outbound_messages` table with a `source` tag (`channel` | `mcp` | `task`). When adding a new outbound path, tag it correctly — this is the observability spine for tracking who sent what and when.

**Main vs non-main group** (the primary privilege boundary): `isMain` set at registration, never mutable via IPC. Main reads the project root (RO), sees all groups/tasks, sends to any JID, can register/sync groups. Non-main is confined to its own folder + global (RO), can only schedule tasks for itself. Enforced in `src/ipc.ts` and `src/container-runner.ts`.

**Credential proxy** (`src/credential-proxy.ts`): Real credentials live in `.env` on the host; containers route outbound HTTPS through the proxy, which injects credentials per-request. Containers never see real tokens. `.env` is shadowed with `/dev/null` inside the container's project-root mount.

**Host-side service pattern** (third-party integrations): The credential proxy is Anthropic-specific by design — a transparent HTTP forwarder that injects headers. For integrations whose wire protocol can't be rewritten at the path-prefix layer (e.g. iCloud CalDAV returns absolute shard URLs inside DAV multistatus XML), NanoClaw uses a different shape: a host-side service (e.g. `src/caldav-service.ts`) owns the authenticated client and credentials, exposing a small JSON HTTP API on the bridge gateway. The container receives only a service URL (e.g. `NANOCLAW_CALDAV_SERVICE_URL`), and a thin container MCP (e.g. `container/agent-runner/src/caldav-mcp-stdio.ts`) forwards tool calls over `fetch`. Use this pattern for any new third-party integration where the wire protocol is stateful or involves non-trivial response rewriting.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: message loop, agent invocation, cursor semantics |
| `src/state.ts` | Process state: sessions, registered groups, active containers |
| `src/channels/registry.ts` | Channel registry (self-registration at startup) |
| `src/ipc.ts` | IPC watcher: messages, tasks, group registration, delivery acks |
| `src/router.ts` | `<internal>` stripping, outbound formatting |
| `src/config.ts` | Trigger pattern, paths, `NANOCLAW_DATA_DIR` resolution |
| `src/container-runner.ts` | Spawns agent containers, mounts, MessageStream piping |
| `src/credential-proxy.ts` | Intercepts outbound requests, injects credentials |
| `src/caldav-service.ts` | Host-side CalDAV service (iCloud calendar events + reminders/VTODOs) |
| `src/carddav-service.ts` | Host-side CardDAV service (iCloud contacts, read-only) |
| `src/task-scheduler.ts` | Cron-driven scheduled task execution |
| `src/db.ts` | SQLite operations |
| `groups/{name}/CLAUDE.md` | Per-group memory (isolated, agent-editable) |
| `container/agent-runner/` | Agent SDK entrypoint that runs inside the container |
| `container/agent-runner/src/caldav-mcp-stdio.ts` | Container MCP forwarder for CalDAV (wraps the host service) |
| `container/agent-runner/src/carddav-mcp-stdio.ts` | Container MCP forwarder for CardDAV (wraps the host service) |
| `container/skills/` | Claude Code skills synced into each container (`agent-browser`, `capabilities`, channel-specific formatting) |

## Commands

Run commands directly — don't tell the user to run them.

```bash
npm run dev              # Run with hot reload
npm run build            # Compile TypeScript
npm run typecheck        # Type-check without emit
npm run lint             # ESLint
npm run format:check     # Prettier check (use format:fix to write)
npm test                 # Vitest (single run)
npx vitest run path/to/file.test.ts             # Single file
npx vitest run -t "substring of test name"      # Single test by name
./container/build.sh     # Rebuild agent container image
```

Tests are colocated as `*.test.ts` next to source. Vitest config at `vitest.config.ts`.

Service management:

```bash
# macOS (launchd)
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # restart

# Linux (systemd)
systemctl --user start nanoclaw
systemctl --user stop nanoclaw
systemctl --user restart nanoclaw
```

## Skills

Four types. See [CONTRIBUTING.md](CONTRIBUTING.md) for the full taxonomy and SKILL.md format.

- **Feature skills** — merge a `skill/*` branch to add capabilities (e.g. `/add-telegram`, `/add-slack`)
- **Utility skills** — ship code files alongside SKILL.md (e.g. `/claw`)
- **Operational skills** — instruction-only workflows on `main` (e.g. `/setup`, `/debug`)
- **Container skills** — loaded inside agent containers at runtime (`container/skills/`)

| Skill | When to Use |
|-------|-------------|
| `/setup` | First-time installation, authentication, service configuration |
| `/customize` | Adding channels, integrations, changing behavior |
| `/debug` | Container issues, logs, troubleshooting |
| `/update-nanoclaw` | Bring upstream NanoClaw updates into a customized install |
| `/qodo-pr-resolver` | Fetch and fix Qodo PR review issues |
| `/get-qodo-rules` | Load org- and repo-level coding rules from Qodo before code tasks |

## Contributing

Before creating a PR, adding a skill, or preparing any contribution, you MUST read [CONTRIBUTING.md](CONTRIBUTING.md). It covers accepted change types, skill guidelines, SKILL.md format, PR requirements, and the pre-submission checklist.

## Gotchas

- **Per-group agent-runner caching**: `src/container-runner.ts` copies `container/agent-runner/src` into `data/sessions/{group}/agent-runner-src/`. Invalidation scans **all** `.ts` files — if any source file's mtime is newer than the cached copy, or the file count differs, the cache is rebuilt. This means adding a new MCP (new `.ts` file) correctly busts the cache. After editing the agent runner from outside the build system, you can still force-clear: `rm -r data/sessions/*/agent-runner-src 2>/dev/null`, then rebuild the container.
- **Container build cache**: Apple Container's buildkit caches COPY steps aggressively. `--no-cache` alone doesn't invalidate them. For a truly clean rebuild, prune the builder then re-run `./container/build.sh`.
- **`<internal>` tags**: Agents wrap internal reasoning in `<internal>...</internal>`; `src/router.ts` strips these before outbound. If the agent already called `send_message` directly, wrapping the final result in `<internal>` prevents a duplicate echo.
- **Multi-instance**: `NANOCLAW_DATA_DIR` overrides where `store/`, `groups/`, `data/`, and IPC live (`src/config.ts`). Two instances can share one checkout but keep separate DBs/sessions by setting different data dirs in their launchd/systemd units.
- **Cursor rollback semantics**: If a container errors *after* sending any output, the DB cursor is NOT rolled back (prevents duplicate user-visible replies). If it errors *before* output, the cursor rolls back for retry. See `src/index.ts`.
- **Credentials**: NanoClaw does not use OneCLI. Credentials live in `.env` at the project root; the built-in credential proxy (`src/credential-proxy.ts`) injects them at request time. Apple Container is the only supported runtime.
- **CalDAV / iCloud app-specific password rotation**: Apple forces periodic rotation. On 401, `src/caldav-service.ts` logs the failure clearly (and `/health` flips `loginStatus: "failed"`). Regenerate at appleid.apple.com, update `ICLOUD_APP_PASSWORD` in `.env`, and restart NanoClaw. The service retries login every 60s until it succeeds.

## Troubleshooting

**WhatsApp not connecting after upgrade:** WhatsApp is a separate skill, not bundled in core. Run `/add-whatsapp` (or `npx tsx scripts/apply-skill.ts .claude/skills/add-whatsapp && npm run build`). Existing auth credentials and groups are preserved.
