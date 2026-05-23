/**
 * Host-side container config for the `codex` provider.
 *
 * Codex reads auth and MCP config from ~/.codex. We give each session its
 * own private copy of that directory so:
 *
 * - The user's host ~/.codex/auth.json reaches the container without us
 *   touching their host config.toml (which the host's own `codex` CLI
 *   might be using).
 * - The in-container provider can rewrite config.toml freely on every
 *   wake with container-appropriate MCP server paths, without racing
 *   other sessions or leaking per-session paths back to the host.
 *
 * Env passthrough covers the runtime knobs read by Codex:
 *   OPENAI_API_KEY  — fallback auth when auth.json isn't a subscription token
 *   CODEX_MODEL     — model override if the user wants something other than the default
 *   OPENAI_BASE_URL — rare, but supports API-compatible alternates
 */
import fs from 'fs';
import path from 'path';

import { registerProviderContainerConfig } from './provider-container-registry.js';

registerProviderContainerConfig('codex', (ctx) => {
  const codexDir = path.join(ctx.sessionDir, 'codex');
  fs.mkdirSync(codexDir, { recursive: true });

  // Copy the host's auth.json into the per-session dir if it exists.
  // Only auth.json — config.toml gets rewritten by the in-container codex
  // provider on every wake, so copying it would just be overwritten.
  const hostHome = ctx.hostEnv.HOME;
  if (hostHome) {
    const hostAuth = path.join(hostHome, '.codex', 'auth.json');
    const sessionAuth = path.join(codexDir, 'auth.json');
    if (fs.existsSync(hostAuth) && !fs.existsSync(sessionAuth)) {
      fs.copyFileSync(hostAuth, sessionAuth);
    }
  }

  const env: Record<string, string> = {};
  for (const key of [
    'OPENAI_API_KEY',
    'CODEX_MODEL',
    'OPENAI_BASE_URL',
  ] as const) {
    const value = ctx.hostEnv[key];
    if (value) env[key] = value;
  }

  return {
    mounts: [
      {
        hostPath: codexDir,
        containerPath: '/home/node/.codex',
        readonly: false,
      },
    ],
    env,
  };
});
