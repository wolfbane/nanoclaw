#!/bin/bash
# Resilient launcher for the NanoClaw host service.
#
# Why this exists (2026-06-14 incident): the launchd job pointed directly at
# /opt/homebrew/bin/node. That symlink is owned by the *unversioned* Homebrew
# `node` formula; when only keg-only `node@24` remained (the unversioned formula
# was removed), the symlink vanished. The running process survived on its
# in-memory binary, but a KeepAlive restart would have hit ENOENT and the
# service would have stayed down. This wrapper resolves a usable Node from a
# list of candidates so an unlinked/relinked Homebrew node can't take the
# service offline.
set -euo pipefail

REPO="/Users/matthew/nanoclaw"

CANDIDATES=(
  /opt/homebrew/bin/node                 # unversioned brew node (preferred when present)
  /opt/homebrew/opt/node@24/bin/node     # keg-only node@24 (current pin)
  /opt/homebrew/opt/node/bin/node        # keg path for unversioned formula
  /usr/local/bin/node                    # Intel brew / manual install
)
# Last resort: whatever is on PATH.
if cmd_node="$(command -v node 2>/dev/null)"; then
  CANDIDATES+=("$cmd_node")
fi

for n in "${CANDIDATES[@]}"; do
  if [ -x "$n" ]; then
    exec "$n" "$REPO/dist/index.js"
  fi
done

echo "nanoclaw-launch: no usable node binary found among: ${CANDIDATES[*]}" >&2
exit 127
