#!/usr/bin/env tsx
/**
 * Summarize Anthropic API usage captured by the credential proxy.
 *
 * Usage:
 *   tsx scripts/usage-summary.ts                 # last 14 days, daily totals
 *   tsx scripts/usage-summary.ts --days 30       # last 30 days
 *   tsx scripts/usage-summary.ts --by-model      # break down by model
 *   tsx scripts/usage-summary.ts --by-source     # break down by source IP
 *   tsx scripts/usage-summary.ts --by-provider   # Claude actual vs Codex shadow cost
 *   tsx scripts/usage-summary.ts --recent 20     # last 20 individual requests
 */
import Database from 'better-sqlite3';
import path from 'path';

import { STORE_DIR } from '../src/config.js';

function fmt(n: number, w = 8): string {
  return n.toFixed(2).padStart(w);
}

function main(): void {
  const argv = process.argv.slice(2);
  let days = 14;
  let byModel = false;
  let bySource = false;
  let byProvider = false;
  let recent = 0;
  function readIntArg(flag: string, raw: string | undefined): number {
    if (raw === undefined) {
      console.error(`Error: ${flag} requires a numeric value`);
      process.exit(1);
    }
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n) || n <= 0) {
      console.error(`Error: ${flag} expects a positive integer, got "${raw}"`);
      process.exit(1);
    }
    return n;
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--days') days = readIntArg('--days', argv[++i]);
    else if (a === '--by-model') byModel = true;
    else if (a === '--by-source') bySource = true;
    else if (a === '--by-provider') byProvider = true;
    else if (a === '--recent') recent = readIntArg('--recent', argv[++i]);
    else if (a === '-h' || a === '--help') {
      console.log(
        'Usage: tsx scripts/usage-summary.ts [--days N] [--by-model] [--by-source] [--by-provider] [--recent N]',
      );
      return;
    }
  }

  const db = new Database(path.join(STORE_DIR, 'messages.db'), {
    readonly: true,
  });
  const since = new Date(Date.now() - days * 86400_000)
    .toISOString()
    .slice(0, 10);

  if (recent > 0) {
    const rows = db
      .prepare(
        `SELECT ts, model, status, input_tokens, cache_read_input_tokens AS cr,
                cache_creation_input_tokens AS cw, output_tokens AS out,
                cost_usd, duration_ms, is_streaming
         FROM api_usage ORDER BY id DESC LIMIT ?`,
      )
      .all(recent) as Array<Record<string, unknown>>;
    console.log(
      'time                       model                  status  in     cw     cr      out    cost    dur(s)',
    );
    for (const r of rows) {
      console.log(
        `${(r.ts as string).slice(0, 19).padEnd(20)} ${String(r.model ?? '?').padEnd(28)} ` +
          `${String(r.status).padStart(3)}   ${String(r.input_tokens).padStart(5)} ` +
          `${String(r.cw).padStart(7)} ${String(r.cr).padStart(7)} ${String(r.out).padStart(5)}  ` +
          `$${fmt(r.cost_usd as number, 5)}  ${((r.duration_ms as number) / 1000).toFixed(1)}`,
      );
    }
    db.close();
    return;
  }

  if (byModel) {
    const rows = db
      .prepare(
        `SELECT substr(ts,1,10) AS day, model,
                SUM(input_tokens) AS i, SUM(cache_creation_input_tokens) AS cw,
                SUM(cache_read_input_tokens) AS cr, SUM(output_tokens) AS o,
                SUM(cost_usd) AS cost, COUNT(*) AS n
         FROM api_usage WHERE ts >= ? GROUP BY day, model ORDER BY day, model`,
      )
      .all(since) as Array<Record<string, unknown>>;
    console.log(
      'date        model                       reqs    in       cw       cr        out      cost',
    );
    for (const r of rows) {
      console.log(
        `${r.day}  ${String(r.model ?? '?').padEnd(28)} ${String(r.n).padStart(4)}  ` +
          `${String(r.i).padStart(7)}  ${String(r.cw).padStart(7)}  ${String(r.cr).padStart(8)}  ` +
          `${String(r.o).padStart(7)}  $${fmt(r.cost as number, 6)}`,
      );
    }
    db.close();
    return;
  }

  if (bySource) {
    const rows = db
      .prepare(
        `SELECT source_ip, COUNT(*) AS n, SUM(cost_usd) AS cost
         FROM api_usage WHERE ts >= ? GROUP BY source_ip ORDER BY cost DESC`,
      )
      .all(since) as Array<Record<string, unknown>>;
    console.log('source_ip            requests    cost');
    for (const r of rows) {
      console.log(
        `${String(r.source_ip ?? '?').padEnd(20)} ${String(r.n).padStart(8)}  $${fmt(r.cost as number, 7)}`,
      );
    }
    db.close();
    return;
  }

  if (byProvider) {
    const rows = db
      .prepare(
        `SELECT COALESCE(provider,'anthropic') AS provider, COUNT(*) AS n,
                SUM(input_tokens) AS i, SUM(output_tokens) AS o,
                SUM(cost_usd) AS cost, SUM(shadow_cost_usd) AS shadow
         FROM api_usage WHERE ts >= ? GROUP BY provider ORDER BY cost DESC`,
      )
      .all(since) as Array<Record<string, unknown>>;
    console.log(
      'provider     reqs    input        output     actual$   shadow$ (Claude-equiv)',
    );
    let actual = 0;
    let shadow = 0;
    for (const r of rows) {
      actual += r.cost as number;
      shadow += r.shadow as number;
      console.log(
        `${String(r.provider).padEnd(11)} ${String(r.n).padStart(4)}  ${String(r.i).padStart(10)}  ` +
          `${String(r.o).padStart(9)}  $${fmt(r.cost as number, 6)}  $${fmt(r.shadow as number, 6)}`,
      );
    }
    console.log(
      `\nActual spend (${days}d):        $${actual.toFixed(2)}  (metered Claude)`,
    );
    console.log(
      `If all-Claude (${days}d):        $${(actual + shadow).toFixed(2)}  (actual + Codex shadow)`,
    );
    console.log(
      `Codex shadow run rate:        $${((shadow / days) * 30).toFixed(0)}/month  (vs the ChatGPT subscription price)`,
    );
    db.close();
    return;
  }

  // Default: daily totals
  const rows = db
    .prepare(
      `SELECT substr(ts,1,10) AS day, COUNT(*) AS n,
              SUM(input_tokens) AS i, SUM(cache_creation_input_tokens) AS cw,
              SUM(cache_read_input_tokens) AS cr, SUM(output_tokens) AS o,
              SUM(cost_usd) AS cost
       FROM api_usage WHERE ts >= ? GROUP BY day ORDER BY day`,
    )
    .all(since) as Array<Record<string, unknown>>;

  console.log(
    'date        reqs   input        cache-w      cache-r       output    cost',
  );
  let totalCost = 0;
  for (const r of rows) {
    totalCost += r.cost as number;
    console.log(
      `${r.day}  ${String(r.n).padStart(4)}  ${String(r.i).padStart(9)}  ${String(r.cw).padStart(9)}  ` +
        `${String(r.cr).padStart(10)}  ${String(r.o).padStart(8)}  $${fmt(r.cost as number, 6)}`,
    );
  }
  console.log(`\n${days}-day total: $${totalCost.toFixed(2)}`);
  if (rows.length > 0) {
    console.log(`Daily avg:    $${(totalCost / rows.length).toFixed(2)}`);
    console.log(
      `Run rate:     $${((totalCost / rows.length) * 30).toFixed(0)}/month`,
    );
  }
  db.close();
}

main();
