/**
 * Claude provider — wraps the existing @anthropic-ai/claude-agent-sdk query()
 * call into the AgentProvider interface. Behavior is byte-identical to the
 * pre-provider-abstraction code path in container/agent-runner/src/index.ts;
 * this file is a pure adapter so other providers (codex, gemini, ...) can
 * plug into the same outer loop without rewriting it.
 *
 * Fork divergence from upstream/main's claude.ts: upstream owns its hooks +
 * MessageStream privately and emits a narrower event set. We keep our
 * existing PreCompact archiving hook in main index.ts (passed in via
 * ProviderOptions.hooks) and emit a Claude-specific `claude_assistant_uuid`
 * event so the outer loop can keep using `resumeSessionAt` for mid-turn
 * IPC pipe-in. See types.ts.
 */
import {
  query as sdkQuery,
  type HookCallback,
  type Options as SDKOptions,
} from '@anthropic-ai/claude-agent-sdk';

import { registerProvider } from './provider-registry.js';
import type {
  AgentProvider,
  AgentQuery,
  McpServerConfig,
  ProviderEvent,
  ProviderOptions,
  QueryInput,
} from './types.js';

const STALE_SESSION_RE = /no conversation found|ENOENT.*\.jsonl|session.*not found/i;

/** Parse a positive number from env, else the fallback. */
function envNum(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

interface SDKUserMessage {
  type: 'user';
  message: { role: 'user'; content: string };
  parent_tool_use_id: null;
  session_id: string;
}

/** Push-based async iterable for streaming user messages into the SDK. */
class MessageStream {
  private queue: SDKUserMessage[] = [];
  private waiting: (() => void) | null = null;
  private done = false;

  push(text: string): void {
    this.queue.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      session_id: '',
    });
    this.waiting?.();
  }

  end(): void {
    this.done = true;
    this.waiting?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (true) {
      while (this.queue.length > 0) {
        yield this.queue.shift()!;
      }
      if (this.done) return;
      await new Promise<void>((r) => {
        this.waiting = r;
      });
      this.waiting = null;
    }
  }
}

/**
 * Fork-local extension to ProviderOptions for the Claude provider only.
 * Carries the bits of SDK option surface our outer loop already configures
 * and that don't make sense to abstract across providers yet.
 */
export interface ClaudeProviderOptions extends ProviderOptions {
  /** Mid-session resume marker (uuid of the last assistant message). */
  resumeAt?: string;
  /** Global CLAUDE.md text to append to the claude_code preset, if any. */
  globalClaudeMd?: string;
  /** Tool allowlist (passed through unchanged). */
  allowedTools?: string[];
  /** Hooks (PreCompact, etc.) — passed through to the SDK as-is. */
  hooks?: SDKOptions['hooks'];
  /** systemPrompt override (slash-command path uses `undefined`). */
  systemPromptMode?: 'preset' | 'none';
  /** Setting sources (e.g. ['project','user']). */
  settingSources?: SDKOptions['settingSources'];
  /** Permission mode override (slash-command path bypasses). */
  permissionMode?: SDKOptions['permissionMode'];
  allowDangerouslySkipPermissions?: boolean;
}

export class ClaudeProvider implements AgentProvider {
  /**
   * Claude Code's SDK exposes slash commands directly (e.g. /compact). The
   * outer loop should route them through a separate query() call with empty
   * allowedTools — same as today's index.ts session-command path.
   */
  readonly supportsNativeSlashCommands = true;

  private opts: ClaudeProviderOptions;

  constructor(options: ProviderOptions = {}) {
    this.opts = options as ClaudeProviderOptions;
  }

  isSessionInvalid(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return STALE_SESSION_RE.test(msg);
  }

  query(input: QueryInput): AgentQuery {
    const stream = new MessageStream();
    stream.push(input.prompt);

    const allowedTools = this.opts.allowedTools ?? [];
    const mcpServers: Record<string, McpServerConfig> = this.opts.mcpServers ?? {};
    const env = this.opts.env ?? {};

    const systemPromptMode = this.opts.systemPromptMode ?? 'preset';
    const systemPrompt: SDKOptions['systemPrompt'] =
      systemPromptMode === 'none'
        ? undefined
        : this.opts.globalClaudeMd
          ? {
              type: 'preset' as const,
              preset: 'claude_code' as const,
              append: this.opts.globalClaudeMd,
            }
          : { type: 'preset' as const, preset: 'claude_code' as const };

    const sdkOptions: SDKOptions = {
      cwd: input.cwd,
      additionalDirectories: this.opts.additionalDirectories,
      resume: input.continuation,
      resumeSessionAt: this.opts.resumeAt,
      // Pin to Sonnet at the standard 200K window. Opus (the SDK default) is
      // ~5× the per-token cost; the [1m] window we previously used pushed the
      // auto-compaction ceiling to ~830K, so per-group sessions ballooned to
      // 100K+ tokens that got re-cached every 5 min — the dominant API cost.
      // The 200K window keeps that re-cached context bounded. (We also tried an
      // aggressive CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=30 in container-runner for
      // extra savings but it thrashed — compacting at ~60K refilled within a few
      // turns; removed. Auto-compaction is governed by CLAUDE_CODE_AUTO_COMPACT_
      // WINDOW=165000, set in index.ts.) 1M is GA at flat pricing, so a group
      // that needs it can set CLAUDE_MODEL=sonnet[1m].
      // Resolution order: ProviderOptions.model > CLAUDE_MODEL env > 'sonnet'.
      model: this.opts.model ?? process.env.CLAUDE_MODEL ?? 'sonnet',
      systemPrompt,
      allowedTools,
      env,
      permissionMode: this.opts.permissionMode ?? 'bypassPermissions',
      allowDangerouslySkipPermissions:
        this.opts.allowDangerouslySkipPermissions ?? true,
      settingSources: this.opts.settingSources ?? ['project', 'user'],
      mcpServers: mcpServers as unknown as SDKOptions['mcpServers'],
      hooks: this.opts.hooks,
      // Runaway-spend guardrails — tail-risk insurance (previously only the
      // 30-min container timeout + 10MB output cap existed; neither caps
      // tokens/cost). Generous per-run ceilings; operator-tunable via env or a
      // group's container_config.env. The SDK ends the query on cap-hit.
      maxTurns: envNum('CLAUDE_MAX_TURNS', 250),
      maxBudgetUsd: envNum('CLAUDE_MAX_BUDGET_USD', 5),
    };

    const sdkResult = sdkQuery({
      prompt: stream as unknown as AsyncIterable<SDKUserMessage>,
      options: sdkOptions,
    });

    let aborted = false;

    async function* translateEvents(): AsyncGenerator<ProviderEvent> {
      for await (const message of sdkResult) {
        if (aborted) return;
        // Liveness ping on every SDK event so the poll-loop's idle timer stays honest
        yield { type: 'activity' };

        if (message.type === 'system' && message.subtype === 'init') {
          yield { type: 'init', continuation: message.session_id };
        } else if (message.type === 'assistant' && 'uuid' in message) {
          // Fork-local: outer loop uses this for resumeSessionAt on next query
          yield { type: 'claude_assistant_uuid', uuid: (message as { uuid: string }).uuid };
        } else if (message.type === 'result') {
          const text =
            'result' in message ? (message as { result?: string }).result ?? null : null;
          yield { type: 'result', text };
        } else if (
          message.type === 'system' &&
          (message as { subtype?: string }).subtype === 'task_notification'
        ) {
          const tn = message as { summary?: string };
          yield { type: 'progress', message: tn.summary || 'Task notification' };
        }
      }
    }

    return {
      push: (msg) => stream.push(msg),
      end: () => stream.end(),
      events: translateEvents(),
      abort: () => {
        aborted = true;
        stream.end();
      },
    };
  }
}

// Suppress unused-import warning for HookCallback in environments where it's only
// referenced via the SDKOptions['hooks'] structural type.
void (null as unknown as HookCallback);

registerProvider('claude', (opts) => new ClaudeProvider(opts));
