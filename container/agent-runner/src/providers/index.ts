// Provider self-registration barrel.
// Each import triggers the provider module's registerProvider() call at top
// level. Phase 2 adds claude. Codex is added in Phase 4.

import './claude.js';
import './mock.js';
