---
name: slack-formatting
description: Format messages for Slack. Use when responding to Slack channels (folder starts with "slack_" or JID contains slack identifiers).
---

# Slack Message Formatting

NanoClaw converts standard CommonMark to Slack's mrkdwn syntax before sending, so **write CommonMark for the basics** and use Slack-native syntax only for things CommonMark can't express (user/channel mentions, emoji shortcodes).

## How to detect Slack context

Check your group folder name or workspace path:
- Folder starts with `slack_` (e.g., `slack_engineering`, `slack_general`)
- Or check `/workspace/group/` path for `slack_` prefix

## Text styles — write CommonMark

| Style | Write this | Sent as |
|-------|------------|---------|
| Bold | `**text**` | `*text*` |
| Italic | `*text*` | `_text_` |
| Link | `[text](url)` | `<url\|text>` |
| Heading `#`–`######` | `## Heading` | `*Heading*` |
| Code (inline) | `` `code` `` | unchanged |
| Code block | ` ```code``` ` | unchanged |

Do NOT write Slack-native syntax directly for bold or links — the converter treats single-asterisk `*text*` as italic per CommonMark and will mangle it.

## Slack-specific — write native

These have no CommonMark equivalent; write them directly:

```
<@U1234567890>         # Mention a user by ID
<#C1234567890>         # Mention a channel by ID
<!here>                # @here
<!channel>             # @channel
:white_check_mark:     # Emoji shortcodes
:rocket:
~strikethrough~        # Slack's single-tilde strikethrough
```

## Lists

Slack supports bullet lists but NOT numbered lists:

- Use `- ` or `* ` bullets (CommonMark) — renders fine
- Or the bullet character `•` directly
- Avoid `1.` `2.` numbered lists

## Block quotes

```
> This is a block quote
> It can span multiple lines
```

Works the same in CommonMark and mrkdwn.

## Example message

```markdown
**Daily Standup Summary**

*March 21, 2026*

- **Completed:** Fixed authentication bug in login flow
- **In Progress:** Building new dashboard widgets
- **Blocked:** Waiting on API access from DevOps

> Next sync: Monday 10am

:white_check_mark: All tests passing | [View Build](https://ci.example.com/builds/123)
```

After conversion this becomes:

```
*Daily Standup Summary*

_March 21, 2026_

- *Completed:* Fixed authentication bug in login flow
- *In Progress:* Building new dashboard widgets
- *Blocked:* Waiting on API access from DevOps

> Next sync: Monday 10am

:white_check_mark: All tests passing | <https://ci.example.com/builds/123|View Build>
```

## What NOT to do

- NO `*single asterisks*` for bold — that's CommonMark italic and gets converted to `_italic_`
- NO `<url|text>` link syntax directly — write `[text](url)` and let the converter handle it
- NO `1.` `2.` numbered lists — Slack doesn't render them
- NO tables — Slack doesn't render them (use code blocks or plain text)
- NO `---` horizontal rules — Slack doesn't render them (they get stripped)
