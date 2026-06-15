# Audit Remediation Plan — 2026-05-13

Codebase audit performed 2026-05-13 by 7 specialized review agents (deps, config, bugs, security, tests, architecture, docs). Findings consolidated and partitioned into 5 workstream buckets below. Two doc fixes shipped immediately (commit `ad23d89`); the rest are captured here as future work.

**How to use this file:**
- Each bucket is a self-contained workstream with non-overlapping file ownership
- Buckets 1-3 can run in parallel (no conflicts)
- Buckets 4-5 must sequence after Bucket 3 (need new tests as verification surface)
- Strike through items as completed; don't delete (audit trail)

---

## Bucket 1 — Surface Maintainer

**Risk:** low | **Effort:** ~2-3 hr | **Blocks:** nothing | **Blocked by:** nothing

Owns documentation drift and observable configuration knobs.

**Files in scope:**
- `README.md`
- `CLAUDE.md` (project root)
- `docs/**`
- `CONTRIBUTING.md`
- `src/config.ts` (magic-number documentation only — no behavior change)
- `.env.example`
- `~/Library/LaunchAgents/com.nanoclaw.plist` (documentation/comments)
- `container/skills/*/SKILL.md`

**Items:**

- [x] **CLAUDE.md** — fix "carddav read-only" → "create/read/update — delete intentionally omitted" *(shipped `ad23d89`)*
- [x] **README.md** — Apple-Container-only runtime; remove Docker as default *(shipped `ad23d89`)*
- [x] **`src/config.ts`** — magic-number constants now carry one-line "what changing this affects" comments. *(2026-06-15)*
- [x] **`src/config.ts`** — `POLL_INTERVAL`, `IPC_POLL_INTERVAL`, `SCHEDULER_POLL_INTERVAL` now env-overridable (same pattern as `IDLE_TIMEOUT`). *(2026-06-15)*
- [x] **`src/container-runner.ts`** — stdout/stderr truncation already WARNs; added a one-time WARN when the marker parse-buffer overflows and is dropped. *(2026-06-15)*
- [ ] **`.env.example`** — add `NANOCLAW_DATA_DIR` (multi-instance), `IDLE_TIMEOUT`, `CONTAINER_TIMEOUT`, port overrides for `CALDAV_SERVICE_PORT` / `CARDDAV_SERVICE_PORT` / `CREDENTIAL_PROXY_PORT`. One-line comment per var.
- [ ] **launchd plist documentation** — add a comment-style doc note at the top of `com.nanoclaw.plist` explaining: plist `EnvironmentVariables` win over `.env` and `process.env`. Resolution order is plist → process.env → .env → hardcoded fallback.
- [ ] **CLAUDE.md** — remove or correct the "per-group `container.json` files" reference (no such files actually exist on disk; `container_config` is stored in the DB instead).
- [ ] **CLAUDE.md "Gotchas"** — defensively reframe the "no longer uses OneCLI" line so it reads as design context, not as a "users might expect it" warning. Two years from now nobody will remember OneCLI.
- [ ] **`container/skills/*/SKILL.md`** — drift check. Specifically: `slack-formatting/SKILL.md` mentions WhatsApp/Slack formatting but Slack isn't actually installed. Either remove WA/Slack mentions or note they're conditional.
- [ ] **README.md** — RFS section lists `add-signal` as a wanted skill but other channel skills were dropped from this fork; reconsider what RFS items remain relevant.

**Done when:** README + CLAUDE.md + docs/ accurately describe the fork as it actually exists. `src/config.ts` reads as self-documenting.

---

## Bucket 2 — Dependency Steward

**Risk:** medium | **Effort:** ~3-4 hr | **Blocks:** nothing | **Blocked by:** nothing

Owns version pins, CVE remediation, transitive cleanup.

**Files in scope:**
- `package.json` + `package-lock.json` (root)
- `container/agent-runner/package.json` + `package-lock.json`
- `container/Dockerfile` (system-level pins: pip, uv, apt)

**Items (severity from audit):**

- [ ] 🔴 **`axios` transitive CVEs** — root `package.json`. ~13 advisories (prototype pollution, SSRF bypass, CRLF injection). Investigate which dep pulls it in; bump or replace.
- [ ] 🔴 **`postcss` XSS** — root, transitive. CVE: unescaped `</style>`. Bump.
- [ ] 🔴 **`fast-uri` path traversal** — agent-runner, transitive. CVE: percent-encoded dot segments. Bump.
- [ ] 🟡 **`hono` 5x moderate CVEs** — agent-runner, transitive. bodyLimit bypass, JSX/CSS injection, JWT validation, cache leakage.
- [ ] 🟡 **`@anthropic-ai/sdk` ≥0.91.0 file perms** — agent-runner, transitive (via Agent SDK). Insecure file perms in memory tool.
- [ ] 🟡 **`ip-address` XSS** — agent-runner, transitive. Address6 HTML methods.
- [x] 🟡 **Pin `uv` installer** in `container/Dockerfile` — now `ARG UV_VERSION=0.11.16` via the versioned install URL (was unversioned `astral.sh` curl). *(2026-06-15)*
- [x] 🟡 **Pin `faster-whisper`** in `container/Dockerfile` — now `ARG FASTER_WHISPER_VERSION=1.2.1` (`pip install faster-whisper==…`). *(2026-06-15)*
- [x] 🟢 **Resolve `cron-parser` version drift** — agent-runner now pins `5.5.0` to match root. *(2026-06-15)*

**Verification protocol after each bump:**
1. `npm install` (root) and `(cd container/agent-runner && npm install)`
2. `npm test` — all tests pass
3. `npm run typecheck` — no errors
4. `./container/build.sh` — image builds clean
5. Restart launchd; smoke test by sending a message to telegram_main and confirming reply

**Done when:** `npm audit` returns 0 high/critical at both `package.json` locations; `./container/build.sh` reproducible; service runs cleanly.

---

## Bucket 3 — Test Strengthener

**Risk:** low | **Effort:** ~half-day | **Blocks:** Bucket 4 | **Blocked by:** nothing

Tightens test coverage so reliability fixes (Bucket 4) have something to verify against. Pure test-file work.

**Files in scope:**
- `src/**/*.test.ts` only — no production code changes

**Items:**

- [x] 🔴 **DAV mocks accept any input** — done *(2026-06-15)*. The tsdav mocks now
  403 faithfully: filename must match `^[A-F0-9-]{36}\.(vcf|ics)$` (create), and
  carddav bodies must carry an `N:` line (create + update); the service maps the
  403 to 502, so every create/update happy-path test now guards filename/N:
  correctness. Direct validator tests added. Verified the guard bites by
  temporarily breaking `davFilename` (both create tests failed), then restored.
- [ ] 🟡 **New `container-spawn-failures.test.ts`** — exercise: `spawn()` throws ENOENT (binary missing), OOM kill (SIGKILL), disk-full exit codes, signal-9 mid-execution.
- [ ] 🟡 **New `mcp-lifecycle.test.ts`** — MCP server fails to start, bridge connection timeout, credential exchange fails.
- [ ] 🟡 **Telegram grammy mock tightening** — assert handlers actually receive their expected event types. Add tests for sendMessage network failures, file-download timeouts, malformed media context.
- [ ] 🟡 **Credential proxy** — add tests: timeout (slow upstream), malformed response body, wrong content-type, oversized response.
- [ ] 🟡 **Group queue retry behavior** — add test: `processMessages` throws (e.g., group folder deleted mid-run); verify retry doesn't loop infinitely.
- [ ] 🟢 **Replace `await polling` patterns with `vi.waitFor()`** in `carddav-service.test.ts` login wait — current 5ms-poll-with-timeout is fragile on slow CI.
- [ ] 🟢 **Audit weak assertions** — places where `toHaveBeenCalled()` is used without checking arguments or side effects (cited examples in `session-commands.test.ts:119-122` and several `container-runner.test.ts` paths).

**Done when:** new tests pass; existing tests still green; the DAV mock-validation tweak demonstrably catches the original N-field/UUID-filename bug class (run `git revert 4ec79bc` locally and watch the test fail, then restore).

---

## Bucket 4 — Reliability Engineer

**Risk:** high | **Effort:** ~half to full day | **Blocks:** Bucket 5 | **Blocked by:** Bucket 3

Bug fixes in orchestrator core. Touches the hot path; needs Bucket 3's tightened tests as verification.

**Files in scope:**
- `src/index.ts`
- `src/session-cleanup.ts`
- `src/state.ts`
- `src/group-queue.ts`
- `src/dav-service-util.ts`
- `src/ipc.ts`
- `src/db.ts`

**Items:**

- [ ] 🔴 **Cursor advance race** — `src/index.ts:192` calls `setLastTimestamp()` before all per-group enqueues at `:276-278` confirm. If an enqueue fails/skips, the global cursor advances past unprocessed messages. Fix: either acquire all per-group locks before advancing, or split cursor into per-group state and only advance after that group confirms enqueue.
- [ ] 🔴 **`src/session-cleanup.ts:10`** — `execFile` callback can throw if `stdout.trim().split('\n')` fails on non-string stdout, or if the spawned script errors. Wrap in try/catch; log + continue rather than killing the cleanup loop. Also ensure `setInterval(runCleanup, ...)` at line 24 has the inner promise's rejection caught.
- [ ] 🟡 **DAV retry timer leak** — `src/dav-service-util.ts:165-167` uses `setInterval(...).unref()` then `void attemptLogin()` which silently swallows rejections. Shutdown logic in `index.ts:372-382` doesn't clear the timer. Fix: store the interval handle, clear on shutdown, log rejections.
- [ ] 🟡 **Session-cleanup setInterval doesn't unref** — `src/session-cleanup.ts:24` keeps Node alive during shutdown.
- [ ] 🟡 **IPC parser file-rename atomicity** — `src/ipc.ts:237-244`: `JSON.parse()` can throw (caught) but `fs.renameSync` at 244 can ALSO throw, leaving the file in limbo. Add a fallback: on rename failure, log + delete the source file.
- [ ] 🟡 **`getCursor()` stale state** — `src/state.ts:52-67` loads from DB on first call, never re-syncs. If DB is updated externally (concurrent restart, manual SQL), in-memory `lastAgentTimestamp` is stale until next process restart. Add periodic re-sync OR make `getCursor()` re-read from DB if stale-by-N-seconds.
- [ ] 🟡 **Group queue retry timer accumulation** — `src/group-queue.ts:279-283` `setTimeout` is never cleaned up on group disposal. Repeated failures accumulate pending timers. Track timers per group; clear on group dispose.
- [ ] 🟡 **`containerConfig` schema validation** — `src/db.ts:711, 764` deserializes via `JSON.parse()` without validation. Malformed JSON in DB causes opaque crashes. Add a zod schema or hand-rolled validator with clear error messages.

**Done when:** all items fixed; tests from Bucket 3 (where applicable) pass; manual smoke test of orchestrator startup, message handling, container spawn/reap, scheduled tasks all clean.

---

## Bucket 5 — Architecture Refactorer

**Risk:** high | **Effort:** ~full day to 1.5 days | **Blocks:** nothing | **Blocked by:** Bucket 4

Structural improvements. Refactoring buggy code locks in bugs, so Bucket 4 must finish first.

**Files in scope:**
- `src/dav-service-util.ts` (extract abstraction)
- `src/caldav-service.ts` (consume abstraction)
- `src/carddav-service.ts` (consume abstraction)
- `container/agent-runner/src/index.ts` (extract MCP plugin registry)
- `container/agent-runner/src/mcps/` (new directory — `caldav.ts`, `carddav.ts`, `ipc.ts`)
- Optional: `src/index.ts` (split into `startup.ts` / `loops.ts` / `shutdown.ts`)

**Items:**

- [ ] 🟡 **Extract `DavServiceFactory<T>` abstraction in `src/dav-service-util.ts`** — current factor extracts ~40% of caldav/carddav scaffolding; the HTTP route handlers are still hand-repeated. Define a factory that takes a protocol name + handler map and returns a ready-to-mount HTTP service. Caldav and carddav consume it.
- [ ] 🟡 **Container MCP plugin registry** — match the host's `src/channels/registry.ts` self-registration pattern. Move MCP definitions out of `container/agent-runner/src/index.ts` into per-MCP files (`mcps/caldav.ts`, `mcps/carddav.ts`, `mcps/ipc.ts`); each self-registers via a registry map; `index.ts` iterates the registry. Adding a new MCP becomes one new file, not an edit to the monolith.
- [ ] 🟢 **Split `src/index.ts` into smaller pieces** *(optional — defer until onboarding pain appears)* — `startup.ts` (service launch), `loops.ts` (message + scheduler poll loops), `shutdown.ts` (cleanup). Current 561 lines is on the edge; not blocking.
- [ ] 🟢 **Audit `src/dav-service-util.ts` exports** — 18 exported functions, only 2 callers (caldav + carddav). Either consolidate into a class/object, or accept the granularity if testability outweighs.

**Done when:** caldav and carddav implementations shrink by ~30%; container/agent-runner gains a plugin registry; `index.ts` size unchanged unless `startup.ts` split is performed; all tests pass; runtime behavior unchanged.

---

## Out of scope (intentionally deferred)

Real findings from the audit that aren't earning a bucket. File a backlog ticket if any becomes urgent.

| Item | Why deferred | Source |
|---|---|---|
| Credential proxy origin/HMAC check | No exploit today; only matters if proxy ever rebinds off `127.0.0.1` | Security |
| IPC rate limiting / disk quota | Hypothetical compromised container; not a real threat in personal-bot context | Security |
| `findResourceOwningUrl` `..` traversal hardening | Mitigated by tsdav URL normalization | Security |
| `execFileSync` instead of `execSync` template strings | Container name pre-validated; safe today | Security |
| `chat_jid` ↔ `chatJid` casing lint rule | Real but cosmetic; deserves its own focused refactor outside this cycle | Architecture |
| `dav-service-util.ts` over-factored exports | If Bucket 5 consolidates DavServiceFactory, this resolves itself | Architecture |
| Real `host ↔ container` integration test | High effort (real container in CI); medium value (most failure modes already covered by mocks if Bucket 3 ships) | Tests |

---

## Reassuring confirmations from the audit

The codebase is structurally sound. These items showed up as "looked, found nothing wrong":

- **No exploitable security findings today.** Credential isolation (proxy pattern), mount allowlist enforcement, IPC authorization all correctly scoped.
- **CLI/SDK version pin alignment correct** (claude-code `2.1.136` ↔ agent-sdk `0.2.136`).
- **No dead code in `src/`** — all 144 public exports have a real caller.
- **All declared package dependencies actually used** (no `npm prune` candidates).
- **`src/types.ts` well-scoped** (137 lines, no bloat, consistent naming).
- **`src/mount-security.ts` design excellent** — external allowlist file (outside project root), tamper-proof from inside container.

---

## Sequencing recap

```
Week 1 (parallel, no conflicts):
  ┌─ Bucket 1: Surface Maintainer  ─┐
  ├─ Bucket 2: Dependency Steward  ─┤── three branches, three PRs
  └─ Bucket 3: Test Strengthener   ─┘

Week 2:
  Bucket 4: Reliability Engineer (uses Bucket 3's tighter tests for verification)

Week 3:
  Bucket 5: Architecture Refactorer (rebases on Bucket 4's reliability fixes)
```

Total estimated effort if one human does it serially: ~4-5 days. If buckets 1-3 parallelize: ~2.5-3 days.

---

## 2026-05-22 — Session log

Out-of-cycle work driven by observed friction, not the original audit. Logged here so the decisions and open follow-ups don't live only in chat history.

### Shipped

- **Briefs: script-driven calendar pre-fetch (Option C).** Morning + evening brief prompts (in `scheduled_tasks` rows, not in git) now have a bash `script` field that fetches calendars + events + reminders from the host CalDAV service in parallel, injects them as `data`, and instructs the agent to format-only — no `list_events`/`list_reminders` calls, no consulting memory for calendar facts. Closes the recurring "from memory but no event on calendar yet" leak (3 occurrences May 14–19). Old prompts backed up in `docs/backups/brief-prompts-2026-05-20.md` for rollback.
- **Briefs: `<internal>` wrap on final response.** Briefs were producing a leaked second Telegram message because the agent's final response text wasn't suppressed. Prompt now mandates `<internal>...</internal>` around the wrap-up. Verified: leak gone.
- **`groups/telegram_main/CLAUDE.md` (gitignored; user data)** — added two principles: "Reference, don't restate" (pairs with the existing "Update the record when resolving") and "Voice messages" (faster-whisper invocation pattern; agent was incorrectly claiming no transcription was possible despite preinstall in commit `94a3fa2`).
- **Per-request Anthropic usage tracking.** `src/credential-proxy.ts` now tees responses (handling gzip/brotli/deflate-encoded SSE), parses `usage` from `message_start` + `message_delta`, computes cost, writes to a new `api_usage` table. Summary script at `scripts/usage-summary.ts` (default daily totals; `--by-model`, `--by-source`, `--recent N`).

### Open follow-ups

- [ ] **`api_usage` group/task attribution.** Today's table has `source_ip` only. Correlating request timestamp against active container state would let us answer "which task is most expensive." Useful once we have a few days of data and want to break down costs.
- [ ] **Pricing-table maintenance.** Hardcoded model→price map in `src/credential-proxy.ts`. If Anthropic changes prices, edit there. Worth a comment pointing at `https://www.anthropic.com/pricing` (already added inline).
- [ ] **Reminders multi-list aggregation.** `GET /reminders` on the host CalDAV service takes one `calendar_url`. If Matthew ever adds a second Apple Reminders list, the brief script won't see it. Deferred — user confirmed single list today.
- [ ] **Cents-data interpretation cost trend.** NanoClaw now interprets cents data on demand, billed to the `clawbackup` key (via the proxy). Watch `usage-summary.ts` over the next 1–2 weeks; if `clawbackup` daily climbs meaningfully above the ~$2.30 baseline, investigate which sessions are doing the heavy cents work and whether Haiku is sufficient for parts of it.
- [ ] **`.env.bak.2026-04-21`, `.env.bak.pre-multibot-revert`.** Untracked files at repo root from before this session. Either delete or move out of the working tree.
- [ ] **Briefs: thread-section drift.** New brief prompts forbid dates/times/locations in *Threads*. If the failure mode re-emerges in a new shape, escalate to two-task split (Option D from the analysis): one task formats calendar from script data, a separate task with no calendar tools at all generates the threads roundup.

---

## 2026-06-14 — Bucket 4 re-review (against current code)

All 8 Bucket 4 items re-verified against the code (the audit was a month stale).
Most were already resolved by intervening work; two were fixed this day.

| # | Item | Verdict |
|---|------|---------|
| 1 🔴 | Cursor advance race | **Resolved** — cursor split into global "seen" (`setLastTimestamp`) + per-group "processed" (`getCursor`/`setCursor`, advanced only after pipe/handle) + `recoverPendingMessages()`. |
| 2 🔴 | session-cleanup `execFile` throw | **Non-issue** — `err` path handled, `stdout` is a utf8 string, `runCleanup` isn't async. |
| 3 🟡 | DAV retry-timer leak | **Resolved** — `retryTimer.unref()` + `stop()`/`clearInterval` on server close + `inFlight` guard. |
| 4 🟡 | session-cleanup `setInterval` no `unref` | **Cosmetic, left as-is** — present, but shutdown uses `process.exit(0)`. |
| 5 🟡 | IPC rename atomicity | **Fixed (commit e1bdc92)** — `quarantineFile()` with delete-on-failure fallback at both error paths. |
| 6 🟡 | `getCursor` stale state | **Mitigated** — concurrent-restart trigger removed by the new singleton lock (`src/singleton-lock.ts`); `getCursor` also recovers from the last bot reply. |
| 7 🟡 | group-queue retry-timer accumulation | **Cosmetic, left as-is** — handle not cleared on dispose, but bounded by `MAX_RETRIES` + `shuttingDown` guard + `process.exit`. |
| 8 🟡 | `containerConfig` schema validation | **Fixed (commit e1bdc92)** — `safeParseContainerConfig()` + 5 unit tests. |

Net: Bucket 4 effectively closed. Only #4 and #7 remain — cosmetic timer-`unref` hygiene, deferred as low value.

---

## 2026-06-15 — "fix everything that doesn't need data collection" sweep

Cleared the verified review-squad backlog (`nanoclaw-{qkf,dec,3q4,r1k,3yo}`) plus
the in-scope Bucket 1/2 items. Six commits, each typecheck + full-suite green
(472 tests) and deployed (host restart; agent-runner via runner-cache refresh;
one image rebuild for the Dockerfile pins).

- **Host reliability/perf** (`qkf` #16/#22/#23/#27/#33, `dec` #7/#40, #35/#38):
  async non-blocking `stopContainer`; process-group kill in remote-control;
  boundary-aware mount blocked-pattern match; idempotent per-column DB
  migrations; grace-period-honoring queue shutdown; error-ack for malformed IPC;
  async zlib in the proxy; `readJsonBodyOr400` object-shape validation + all
  CalDAV handlers.
- **Agent-runner** (`r1k`, `qkf` #24/#25/#26/#13): maxTurns/maxBudgetUsd
  guardrails; tightened `STALE_THREAD_RE`; partial-output-on-timeout for codex;
  `/compact` keeps the container warm; drain IPC before honoring `_close`.
- **container-runner** (`qkf` #17/#18/#19): signature-based runner-src cache
  invalidation; skills sync prunes deletions; `--cpus` cap (+ env-tunable mem).
- **DB** (`dec` #10): WAL + busy_timeout (daemon + CLI multi-process access).
- **Cursor races** (`3q4` #4/#11/#28): oldest-first `getNewMessages` so a burst
  can't bury a low-traffic trigger; stranded-IPC recovery on container exit.
- **Codex rate-limit capture** (`3yo`): `account/rateLimits/updated` →
  `codex_rate_limits` table → `usage-summary --rate-limits`.
- **Bucket 2**: pinned `uv` 0.11.16 + `faster-whisper` 1.2.1 in the Dockerfile;
  agent-runner `cron-parser` → `5.5.0` (image rebuilt + verified).
- **Bucket 1**: `config.ts` magic-number docs + env-overridable poll intervals;
  parse-buffer-overflow WARN; `.env.example` tuning section; OneCLI reframe.

Deliberately deferred (out of scope): `nanoclaw-23s` (A/B eval — needs accrued
data), Bucket 2 CVE bumps (need advisory/version lookups), Bucket 3 broader test
expansion, Bucket 5 refactors, `07l` provider-interface/memory-scaffold.
