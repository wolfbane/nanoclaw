export interface AgentProvider {
  /**
   * True if the provider's underlying SDK handles slash commands natively and
   * wants them passed through as raw text. When false, the poll-loop formats
   * slash commands like any other chat message.
   */
  readonly supportsNativeSlashCommands: boolean;

  /** Start a new query. Returns a handle for streaming input and output. */
  query(input: QueryInput): AgentQuery;

  /**
   * True if the given error indicates the stored continuation is invalid
   * (missing transcript, unknown session, etc.) and should be cleared.
   */
  isSessionInvalid(err: unknown): boolean;
}

/**
 * Options passed to provider constructors. Fields are common to most
 * providers; individual providers may ignore any they don't need.
 */
export interface ProviderOptions {
  assistantName?: string;
  mcpServers?: Record<string, McpServerConfig>;
  env?: Record<string, string | undefined>;
  additionalDirectories?: string[];
  /**
   * Model alias (`sonnet`, `opus`, `haiku`) or full model ID. Passed through
   * to the underlying SDK. If omitted, the SDK default is used.
   */
  model?: string;
  /**
   * Reasoning effort (`'low' | 'medium' | 'high' | 'xhigh' | 'max'`). Passed
   * through to the underlying SDK. If omitted, the SDK default is used.
   */
  effort?: string;
}

export interface QueryInput {
  /** Initial prompt (already formatted by agent-runner). */
  prompt: string;

  /**
   * Opaque continuation token from a previous query. The provider decides
   * what this means (session ID, thread ID, nothing at all).
   */
  continuation?: string;

  /** Working directory inside the container. */
  cwd: string;

  /**
   * System context to inject. Providers translate this into whatever their
   * SDK expects (preset append, full system prompt, per-turn injection…).
   */
  systemContext?: {
    instructions?: string;
  };
}

export interface McpServerConfig {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface AgentQuery {
  /** Push a follow-up message into the active query. */
  push(message: string): void;

  /** Signal that no more input will be sent. */
  end(): void;

  /** Output event stream. */
  events: AsyncIterable<ProviderEvent>;

  /** Force-stop the query. */
  abort(): void;
}

/**
 * Token usage for one turn, reported by providers that surface it (e.g. Codex's
 * `turn/completed`). Used by the host to record per-provider usage/cost — Claude
 * usage is captured separately by the credential proxy, so the Claude provider
 * leaves this unset to avoid double-counting. `raw` carries the provider's
 * original usage object so the host can recover fields we don't model yet.
 */
/**
 * Subscription rate-limit snapshot (Codex on a flat ChatGPT plan emits this per
 * turn via `account/rateLimits/updated`). The complement to token shadow-cost:
 * it answers whether the plan's quota is enough for the workload. `primary` is
 * the short (≈5h) window, `secondary` the long (≈weekly) window.
 */
export interface ProviderRateLimits {
  primaryUsedPercent?: number;
  secondaryUsedPercent?: number;
  primaryResetsAt?: string;
  secondaryResetsAt?: string;
  planType?: string;
  raw?: unknown;
}

export interface ProviderUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  /** Subscription quota snapshot, where the provider reports it (e.g. Codex). */
  rateLimits?: ProviderRateLimits;
  raw?: unknown;
}

export type ProviderEvent =
  | { type: 'init'; continuation: string }
  | { type: 'result'; text: string | null; usage?: ProviderUsage }
  | {
      type: 'error';
      message: string;
      retryable: boolean;
      classification?: string;
    }
  | { type: 'progress'; message: string }
  /**
   * Liveness signal. Providers MUST yield this on every underlying SDK
   * event (tool call, thinking, partial message, anything) so the
   * poll-loop's idle timer stays honest during long tool runs.
   */
  | { type: 'activity' }
  /**
   * Fork-local extension. The Claude provider emits this on every assistant
   * message; the outer loop uses the uuid as `resumeSessionAt` on the next
   * query so IPC messages piped in mid-turn don't re-process already-seen
   * assistant content. Non-Claude providers do not emit this event.
   */
  | { type: 'claude_assistant_uuid'; uuid: string };
