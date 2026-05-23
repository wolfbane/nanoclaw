import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'src/**/*.test.ts',
      'setup/**/*.test.ts',
      // Agent-runner tests that don't import the in-container Claude SDK
      // (e.g. pure-string-utility tests) run from the host vitest. Tests
      // that require the SDK still build/run inside the container.
      'container/agent-runner/src/**/*.test.ts',
    ],
    env: {
      CREDENTIAL_PROXY_HOST: '0.0.0.0',
    },
  },
});
