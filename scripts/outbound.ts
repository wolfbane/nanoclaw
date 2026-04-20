#!/usr/bin/env tsx
/**
 * Read recent outbound messages logged by the host.
 *
 * Usage:
 *   tsx scripts/outbound.ts                 # last 20 across all chats
 *   tsx scripts/outbound.ts --jid tg:123    # last 20 for one chat
 *   tsx scripts/outbound.ts --limit 50
 *   tsx scripts/outbound.ts --since 2h      # last N minutes/hours/days
 *   tsx scripts/outbound.ts --json          # raw JSON output
 */
import { getRecentOutboundMessages, initDatabase } from '../src/db.js';

function parseArgs(argv: string[]): {
  jid?: string;
  limit: number;
  sinceMs?: number;
  json: boolean;
} {
  let jid: string | undefined;
  let limit = 20;
  let sinceMs: number | undefined;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--jid') jid = argv[++i];
    else if (arg === '--limit') limit = parseInt(argv[++i], 10);
    else if (arg === '--since') sinceMs = parseDuration(argv[++i]);
    else if (arg === '--json') json = true;
    else if (arg === '-h' || arg === '--help') {
      console.log(
        'Usage: tsx scripts/outbound.ts [--jid <jid>] [--limit N] [--since 2h] [--json]',
      );
      process.exit(0);
    }
  }
  return { jid, limit, sinceMs, json };
}

function parseDuration(s: string): number {
  const m = /^(\d+)([smhd])$/.exec(s);
  if (!m) throw new Error(`Invalid duration "${s}" (use 30m / 2h / 7d)`);
  const n = parseInt(m[1], 10);
  const mult = { s: 1e3, m: 6e4, h: 3.6e6, d: 8.64e7 }[m[2] as 's' | 'm' | 'h' | 'd'];
  return n * mult;
}

function main(): void {
  const { jid, limit, sinceMs, json } = parseArgs(process.argv.slice(2));
  initDatabase();

  let rows = getRecentOutboundMessages(jid, limit);
  if (sinceMs !== undefined) {
    const cutoff = Date.now() - sinceMs;
    rows = rows.filter((r) => new Date(r.sent_at).getTime() >= cutoff);
  }

  if (json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }

  if (rows.length === 0) {
    console.log('No outbound messages found.');
    return;
  }

  for (const r of rows) {
    const ids = r.channel_message_ids ? ` ids=${r.channel_message_ids}` : '';
    const thread = r.thread_id ? ` thread=${r.thread_id}` : '';
    const mode = r.parse_mode ? ` mode=${r.parse_mode}` : '';
    console.log(
      `${r.sent_at}  ${r.channel}  ${r.chat_jid}  len=${r.length} parts=${r.parts}${mode}${thread} src=${r.source}${ids}`,
    );
  }
  console.log(`\n${rows.length} row(s)`);
}

main();
