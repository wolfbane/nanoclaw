import fs from 'fs';
import https from 'https';
import path from 'path';

import { Api, Bot } from 'grammy';
import telegramify from 'telegramify-markdown';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { logOutboundMessage } from '../db.js';
import { readEnvFile } from '../env.js';
import { resolveGroupFolderPath } from '../group-folder.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
  SendOptions,
} from '../types.js';

const TG_PREFIX = 'tg:';

export interface TelegramChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

interface TelegramSendResult {
  messageId: number;
  parseMode: 'markdownv2' | 'plain';
}

// Telegram rejects messages over 4096 characters.
const TELEGRAM_MAX_LENGTH = 4096;
// Below this, MarkdownV2 escaping (worst case ~2x) can't push a chunk over the
// limit, so we skip the conversion-size check entirely on the hot path.
const SPLIT_FAST_PATH = 2000;
// Last-resort hard split for a single line that's too long even on its own.
const HARD_SPLIT_LIMIT = 3500;

/**
 * Wrap GitHub-Flavored-Markdown tables in a fenced code block before
 * conversion. Telegram has no table syntax, and telegramify-markdown mangles
 * table rows into INVALID MarkdownV2 — it emits `col\\_a` (an escaped backslash
 * followed by a *raw* underscore), which opens an italic entity that never
 * closes, so Telegram rejects the whole message with "can't find end of the
 * entity" and we fall back to ugly raw text. Fencing the table makes
 * telegramify treat it as a code block (left verbatim) → valid MarkdownV2 that
 * renders as aligned monospace. Only a header row immediately followed by a
 * `|---|` separator counts as a table (so stray `a | b` prose is untouched),
 * and tables already inside a code fence are left alone.
 */
export function fenceMarkdownTables(text: string): string {
  const lines = text.split('\n');
  const isRow = (l: string) => /^\s*\|.*\|\s*$/.test(l);
  const isSeparator = (l: string) => /^\s*\|[\s:|-]+\|\s*$/.test(l);
  const isFence = (l: string) => /^\s*```/.test(l);
  const out: string[] = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    if (isFence(lines[i])) {
      inFence = !inFence;
      out.push(lines[i]);
      continue;
    }
    if (
      !inFence &&
      isRow(lines[i]) &&
      i + 1 < lines.length &&
      isSeparator(lines[i + 1])
    ) {
      out.push('```');
      while (i < lines.length && isRow(lines[i]) && !isFence(lines[i])) {
        out.push(lines[i]);
        i++;
      }
      i--; // the for-loop's i++ will re-align
      out.push('```');
      continue;
    }
    out.push(lines[i]);
  }
  return out.join('\n');
}

/**
 * Convert Claude's CommonMark output into Telegram MarkdownV2.
 *
 * Claude emits standard Markdown (`**bold**`, `_italic_`, `file_name`, lists,
 * `[links](url)`). Telegram's legacy `Markdown` parse mode is strict and rejects
 * most of it ("can't find end of the entity"), so we previously dumped those
 * messages as unformatted plain text. telegramify-markdown maps CommonMark to
 * MarkdownV2 and escapes every special char outside entities, so the output
 * always parses. The trailing newline telegramify appends is stripped. Tables
 * are fenced first (see fenceMarkdownTables) since telegramify mis-escapes them.
 */
export function toTelegramMarkdownV2(text: string): string {
  return telegramify(fenceMarkdownTables(text), 'escape').replace(/\n+$/, '');
}

/**
 * Render Markdown to clean, readable PLAIN text for the send fallback. When
 * telegramify produces invalid MarkdownV2 (nested emphasis, a backtick inside a
 * code fence, etc.) Telegram rejects it; previously we then sent the *raw*
 * Markdown, so the user saw literal `*bold*` / backticks. This strips the noise
 * markers instead — but is word-boundary aware so it never corrupts identifiers
 * like `CLAUDE_CODE_DISABLE_AUTO_MEMORY` or `a_b_c` (intra-word underscores and
 * unpaired `*` are left alone). No parse_mode, so it can never re-trigger a
 * parse error.
 */
export function markdownToReadablePlain(text: string): string {
  return text
    .replace(/^[ \t]*```[^\n]*$/gm, '') // code-fence lines
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/`/g, '') // inline code + stray backticks
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1') // images → alt
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)') // links → text (url)
    .replace(/^[ \t]*#{1,6}[ \t]+/gm, '') // headings
    .replace(/^[ \t]*>[ \t]?/gm, '') // blockquotes
    .replace(/(^|[\s(])\*\*([^*\n]+)\*\*(?=[\s).,!?:;]|$)/g, '$1$2') // **bold**
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?:;]|$)/g, '$1$2') // *italic*
    .replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,!?:;]|$)/g, '$1$2') // _italic_ (boundary)
    .replace(/^[ \t]*[-*][ \t]+/gm, '• ') // bullets → •
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Split source text into pieces whose *converted* MarkdownV2 length stays within
 * Telegram's 4096-char limit. Splits only on newlines so Markdown entities are
 * never cut mid-delimiter; a single line too long even alone is hard-split.
 */
export function splitForTelegram(text: string): string[] {
  if (text.length <= SPLIT_FAST_PATH) return [text];

  const fits = (s: string) =>
    toTelegramMarkdownV2(s).length <= TELEGRAM_MAX_LENGTH;
  if (fits(text)) return [text];

  const chunks: string[] = [];
  let current = '';
  const flush = () => {
    if (current) {
      chunks.push(current);
      current = '';
    }
  };
  for (const line of text.split('\n')) {
    const candidate = current ? `${current}\n${line}` : line;
    if (fits(candidate)) {
      current = candidate;
      continue;
    }
    flush();
    if (fits(line)) {
      current = line;
      continue;
    }
    // Single line too long even on its own — hard-split by characters.
    for (let i = 0; i < line.length; i += HARD_SPLIT_LIMIT) {
      chunks.push(line.slice(i, i + HARD_SPLIT_LIMIT));
    }
  }
  flush();
  return chunks;
}

/**
 * Send a message as Telegram MarkdownV2, falling back to plain text if Telegram
 * still rejects the converted output. The fallback sends the *original* text
 * (no escape backslashes) so a parse failure degrades to readable plain text —
 * never worse than the pre-conversion behavior.
 */
async function sendTelegramMessage(
  api: { sendMessage: Api['sendMessage'] },
  chatId: string | number,
  text: string,
  options: { message_thread_id?: number } = {},
): Promise<TelegramSendResult> {
  try {
    const sent = await api.sendMessage(chatId, toTelegramMarkdownV2(text), {
      ...options,
      parse_mode: 'MarkdownV2',
    });
    return { messageId: sent.message_id, parseMode: 'markdownv2' };
  } catch (err) {
    // Fallback: send the original text as plain if MarkdownV2 parsing fails.
    logger.warn(
      {
        chatId,
        threadId: options.message_thread_id,
        err: err instanceof Error ? err.message : String(err),
      },
      'Telegram MarkdownV2 send failed, falling back to plain text',
    );
    // Strip markdown to readable plain (not the raw original) so a parse failure
    // degrades to clean text, never literal `*bold*` / backticks.
    const sent = await api.sendMessage(
      chatId,
      markdownToReadablePlain(text),
      options,
    );
    return { messageId: sent.message_id, parseMode: 'plain' };
  }
}

export class TelegramChannel implements Channel {
  name = 'telegram';

  private bot: Bot | null = null;
  private opts: TelegramChannelOpts;
  private botToken: string;

  constructor(botToken: string, opts: TelegramChannelOpts) {
    this.botToken = botToken;
    this.opts = opts;
  }

  /**
   * Download a Telegram file to the group's attachments directory.
   * Returns the container-relative path (e.g. /workspace/group/attachments/photo_123.jpg)
   * or null if the download fails.
   */
  private async downloadFile(
    fileId: string,
    groupFolder: string,
    filename: string,
  ): Promise<string | null> {
    if (!this.bot) return null;

    try {
      const file = await this.bot.api.getFile(fileId);
      if (!file.file_path) {
        logger.warn({ fileId }, 'Telegram getFile returned no file_path');
        return null;
      }

      const groupDir = resolveGroupFolderPath(groupFolder);
      const attachDir = path.join(groupDir, 'attachments');
      fs.mkdirSync(attachDir, { recursive: true });

      // Sanitize filename and add extension from Telegram's file_path if missing
      const tgExt = path.extname(file.file_path);
      const localExt = path.extname(filename);
      const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
      const finalName = localExt ? safeName : `${safeName}${tgExt}`;
      const destPath = path.join(attachDir, finalName);

      const fileUrl = `https://api.telegram.org/file/bot${this.botToken}/${file.file_path}`;
      const resp = await fetch(fileUrl);
      if (!resp.ok) {
        logger.warn(
          { fileId, status: resp.status },
          'Telegram file download failed',
        );
        return null;
      }

      const buffer = Buffer.from(await resp.arrayBuffer());
      fs.writeFileSync(destPath, buffer);

      logger.info({ fileId, dest: destPath }, 'Telegram file downloaded');
      return `/workspace/group/attachments/${finalName}`;
    } catch (err) {
      logger.error({ fileId, err }, 'Failed to download Telegram file');
      return null;
    }
  }

  async connect(): Promise<void> {
    this.bot = new Bot(this.botToken, {
      client: {
        baseFetchConfig: { agent: https.globalAgent, compress: true },
      },
    });

    // Command to get chat ID (useful for registration)
    this.bot.command('chatid', (ctx) => {
      const chatId = ctx.chat.id;
      const chatType = ctx.chat.type;
      const chatName =
        chatType === 'private'
          ? ctx.from?.first_name || 'Private'
          : (ctx.chat as any).title || 'Unknown';

      ctx.reply(
        `Chat ID: \`${TG_PREFIX}${chatId}\`\nName: ${chatName}\nType: ${chatType}`,
        { parse_mode: 'Markdown' },
      );
    });

    // Command to check bot status
    this.bot.command('ping', (ctx) => {
      ctx.reply(`${ASSISTANT_NAME} is online.`);
    });

    // Telegram bot commands handled above — skip them in the general handler
    // so they don't also get stored as messages. All other /commands flow through.
    const TELEGRAM_BOT_COMMANDS = new Set(['chatid', 'ping']);

    this.bot.on('message:text', async (ctx) => {
      if (ctx.message.text.startsWith('/')) {
        const cmd = ctx.message.text.slice(1).split(/[\s@]/)[0].toLowerCase();
        if (TELEGRAM_BOT_COMMANDS.has(cmd)) return;
      }

      const chatJid = `${TG_PREFIX}${ctx.chat.id}`;
      let content = ctx.message.text;
      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id.toString() ||
        'Unknown';
      const sender = ctx.from?.id.toString() || '';
      const msgId = ctx.message.message_id.toString();
      const threadId = ctx.message.message_thread_id;

      const replyTo = ctx.message.reply_to_message;
      const replyToMessageId = replyTo?.message_id?.toString();
      const replyToContent = replyTo?.text || replyTo?.caption;
      const replyToSenderName = replyTo
        ? replyTo.from?.first_name ||
          replyTo.from?.username ||
          replyTo.from?.id?.toString() ||
          'Unknown'
        : undefined;

      // Determine chat name
      const chatName =
        ctx.chat.type === 'private'
          ? senderName
          : (ctx.chat as any).title || chatJid;

      // Translate Telegram @bot_username mentions into TRIGGER_PATTERN format.
      // Telegram @mentions (e.g., @andy_ai_bot) won't match TRIGGER_PATTERN
      // (e.g., ^@Andy\b), so we prepend the trigger when the bot is @mentioned.
      const botUsername = ctx.me?.username?.toLowerCase();
      if (botUsername) {
        const entities = ctx.message.entities || [];
        const isBotMentioned = entities.some((entity) => {
          if (entity.type === 'mention') {
            const mentionText = content
              .substring(entity.offset, entity.offset + entity.length)
              .toLowerCase();
            return mentionText === `@${botUsername}`;
          }
          return false;
        });
        if (isBotMentioned && !TRIGGER_PATTERN.test(content)) {
          content = `@${ASSISTANT_NAME} ${content}`;
        }
      }

      // Store chat metadata for discovery
      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        chatName,
        'telegram',
        isGroup,
      );

      // Only deliver full message for registered groups
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        logger.debug(
          { chatJid, chatName },
          'Message from unregistered Telegram chat',
        );
        return;
      }

      // Deliver message — startMessageLoop() will pick it up
      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
        thread_id: threadId ? threadId.toString() : undefined,
        reply_to_message_id: replyToMessageId,
        reply_to_message_content: replyToContent,
        reply_to_sender_name: replyToSenderName,
      });

      logger.info(
        { chatJid, chatName, sender: senderName },
        'Telegram message stored',
      );
    });

    // Handle non-text messages: download files when possible, fall back to placeholders.
    const storeMedia = (
      ctx: any,
      placeholder: string,
      opts?: { fileId?: string; filename?: string },
    ) => {
      const chatJid = `${TG_PREFIX}${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';
      const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';

      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        undefined,
        'telegram',
        isGroup,
      );

      const deliver = (content: string) => {
        this.opts.onMessage(chatJid, {
          id: ctx.message.message_id.toString(),
          chat_jid: chatJid,
          sender: ctx.from?.id?.toString() || '',
          sender_name: senderName,
          content,
          timestamp,
          is_from_me: false,
        });
      };

      // If we have a file_id, attempt to download; deliver asynchronously
      if (opts?.fileId) {
        const msgId = ctx.message.message_id.toString();
        const filename =
          opts.filename ||
          `${placeholder.replace(/[[\] ]/g, '').toLowerCase()}_${msgId}`;
        this.downloadFile(opts.fileId, group.folder, filename).then(
          (filePath) => {
            if (filePath) {
              deliver(`${placeholder} (${filePath})${caption}`);
            } else {
              deliver(`${placeholder}${caption}`);
            }
          },
        );
        return;
      }

      deliver(`${placeholder}${caption}`);
    };

    this.bot.on('message:photo', (ctx) => {
      // Telegram sends multiple sizes; last is largest
      const photos = ctx.message.photo;
      const largest = photos?.[photos.length - 1];
      storeMedia(ctx, '[Photo]', {
        fileId: largest?.file_id,
        filename: `photo_${ctx.message.message_id}`,
      });
    });
    this.bot.on('message:video', (ctx) => {
      storeMedia(ctx, '[Video]', {
        fileId: ctx.message.video?.file_id,
        filename: `video_${ctx.message.message_id}`,
      });
    });
    this.bot.on('message:voice', (ctx) => {
      storeMedia(ctx, '[Voice message]', {
        fileId: ctx.message.voice?.file_id,
        filename: `voice_${ctx.message.message_id}`,
      });
    });
    this.bot.on('message:audio', (ctx) => {
      const name =
        ctx.message.audio?.file_name || `audio_${ctx.message.message_id}`;
      storeMedia(ctx, '[Audio]', {
        fileId: ctx.message.audio?.file_id,
        filename: name,
      });
    });
    this.bot.on('message:document', (ctx) => {
      const name = ctx.message.document?.file_name || 'file';
      storeMedia(ctx, `[Document: ${name}]`, {
        fileId: ctx.message.document?.file_id,
        filename: name,
      });
    });
    this.bot.on('message:sticker', (ctx) => {
      const emoji = ctx.message.sticker?.emoji || '';
      storeMedia(ctx, `[Sticker ${emoji}]`);
    });
    this.bot.on('message:location', (ctx) => storeMedia(ctx, '[Location]'));
    this.bot.on('message:contact', (ctx) => storeMedia(ctx, '[Contact]'));

    // Handle errors gracefully
    this.bot.catch((err) => {
      logger.error({ err: err.message }, 'Telegram bot error');
    });

    // Start polling — returns a Promise that resolves when started
    return new Promise<void>((resolve, reject) => {
      // grammy's start() rejects on fatal init failure (e.g. an invalid/revoked
      // token); that rejection was previously discarded, so connect() would hang
      // forever and block startup. Reject on it, and time out if neither fires.
      const timer = setTimeout(() => {
        reject(
          new Error('Telegram bot start timed out (no onStart within 30s)'),
        );
      }, 30_000);
      timer.unref();
      this.bot!.start({
        onStart: (botInfo) => {
          clearTimeout(timer);
          logger.info(
            { username: botInfo.username, id: botInfo.id },
            'Telegram bot connected',
          );
          console.log(`\n  Telegram bot: @${botInfo.username}`);
          console.log(
            `  Send /chatid to the bot to get a chat's registration ID\n`,
          );
          resolve();
        },
      }).catch((err) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      });
    });
  }

  async sendMessage(
    jid: string,
    text: string,
    opts: SendOptions = {},
  ): Promise<void> {
    if (!this.bot) {
      logger.warn('Telegram bot not initialized');
      return;
    }

    const threadId = opts.threadId;
    const source = opts.source ?? 'channel';

    try {
      const numericId = jid.slice(TG_PREFIX.length);
      const options = threadId
        ? { message_thread_id: parseInt(threadId, 10) }
        : {};

      // Telegram caps messages at 4096 chars; MarkdownV2 conversion expands
      // length, so split the source on line boundaries (with headroom) first.
      const results: TelegramSendResult[] = [];
      for (const chunk of splitForTelegram(text)) {
        results.push(
          await sendTelegramMessage(this.bot.api, numericId, chunk, options),
        );
      }
      const parseMode: 'markdownv2' | 'plain' | 'mixed' = results.every(
        (r) => r.parseMode === 'markdownv2',
      )
        ? 'markdownv2'
        : results.every((r) => r.parseMode === 'plain')
          ? 'plain'
          : 'mixed';
      logOutboundMessage({
        chat_jid: jid,
        channel: 'telegram',
        channel_message_ids: results.map((r) => r.messageId),
        parts: results.length,
        length: text.length,
        parse_mode: parseMode,
        thread_id: threadId ?? null,
        source,
      });
      logger.info(
        {
          jid,
          chatId: numericId,
          length: text.length,
          threadId,
          parts: results.length,
          messageIds: results.map((r) => r.messageId),
          parseMode,
        },
        'Telegram message sent',
      );
    } catch (err) {
      logger.error(
        {
          jid,
          length: text.length,
          threadId,
          err: err instanceof Error ? err.message : String(err),
        },
        'Failed to send Telegram message',
      );
    }
  }

  isConnected(): boolean {
    return this.bot !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith(TG_PREFIX);
  }

  async disconnect(): Promise<void> {
    if (this.bot) {
      this.bot.stop();
      this.bot = null;
      logger.info('Telegram bot stopped');
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.bot || !isTyping) return;
    try {
      const numericId = jid.slice(TG_PREFIX.length);
      await this.bot.api.sendChatAction(numericId, 'typing');
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Telegram typing indicator');
    }
  }
}

registerChannel('telegram', (opts: ChannelOpts) => {
  const env = readEnvFile(['TELEGRAM_BOT_TOKEN']);
  const token = process.env.TELEGRAM_BOT_TOKEN || env.TELEGRAM_BOT_TOKEN || '';
  if (!token) {
    logger.warn('Telegram: TELEGRAM_BOT_TOKEN not set');
    return null;
  }
  return new TelegramChannel(token, opts);
});
