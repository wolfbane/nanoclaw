// Provider self-registration barrel.
// Each import triggers the provider module's registerProvider() call at top
// level. Selection is by AGENT_PROVIDER env (default 'claude'); see
// runQuery() in ../index.ts.

import './claude.js';
import './codex.js';
import './mock.js';
