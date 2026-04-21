---
name: finance
description: Matthew's personal finance and investment tracking via the `cents` CLI. Invoke when the user asks about investments, stocks, tickers (NVDA, AAPL, etc.), portfolio, positions, theses, watchlists, alerts, market research, financial scans, or `cents`. Also invoke when the morning brief needs to surface cents alerts.
---

# Finance — `cents` CLI

The `cents` CLI is Matthew's canonical investment-tracking data layer. Ground financial answers in actual CLI output, not estimates.

## Preflight — check the mount

```bash
test -d /workspace/extra/cents && echo "cents: yes" || echo "cents: NO"
```

If absent, the group you're in doesn't have cents access — say so and stop.

The data store is at `/workspace/extra/cents-data`. `cents scan` requires that mount to be RW.

## Commands

Run every invocation with `uv run --project`:

```bash
# Research a ticker
uv run --project /workspace/extra/cents cents research NVDA --suggest-thesis
uv run --project /workspace/extra/cents cents research NVDA --output json

# Theses
uv run --project /workspace/extra/cents cents thesis list
uv run --project /workspace/extra/cents cents thesis create --title "..." --from-research NVDA

# Positions
uv run --project /workspace/extra/cents cents position open NVDA --size 100 --price 135 --thesis ID
uv run --project /workspace/extra/cents cents position list

# Watchlist & alerts
uv run --project /workspace/extra/cents cents watch add NVDA --thesis ID
uv run --project /workspace/extra/cents cents scan
uv run --project /workspace/extra/cents cents alert list
```

Use `--help` on any command for full options.
