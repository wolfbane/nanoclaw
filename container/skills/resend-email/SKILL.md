---
name: resend-email
description: Send emails via the Resend API. Use for notifications, reports, or sharing content with Matthew or other allowed recipients.
---

# Send Email with Resend

Send emails using the Resend API. The API key is available as `$RESEND_API_KEY` in the environment.

**Allowed recipients:** garrett@trispoke.com, matt.fellows@gmail.com  
**Default from:** robot@notifications.vibe-coded.ai

## Send a plain text or HTML email

```bash
curl -s -X POST https://api.resend.com/emails \
  -H "Authorization: Bearer $RESEND_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "from": "robot@notifications.vibe-coded.ai",
    "to": ["matt.fellows@gmail.com"],
    "subject": "Your subject",
    "html": "<p>Your message here</p>"
  }'
```

## Send with a base64 file attachment

Local file paths do not work with Resend (returns 422). Always use base64-encoded content:

```bash
# Encode file to base64
B64=$(base64 -i /workspace/group/yourfile.pdf)

curl -s -X POST https://api.resend.com/emails \
  -H "Authorization: Bearer $RESEND_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{
    \"from\": \"robot@notifications.vibe-coded.ai\",
    \"to\": [\"matt.fellows@gmail.com\"],
    \"subject\": \"Your subject\",
    \"html\": \"<p>See attached.</p>\",
    \"attachments\": [{
      \"filename\": \"yourfile.pdf\",
      \"content\": \"$B64\"
    }]
  }"
```

A successful response returns `{"id": "..."}`. Any non-2xx response is an error.
