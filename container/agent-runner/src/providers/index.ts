// Provider self-registration barrel.
// Each import triggers the provider module's registerProvider() call at top
// level. Phase 1 only registers the mock provider; claude is added in Phase 2,
// codex in Phase 4.

import './mock.js';
