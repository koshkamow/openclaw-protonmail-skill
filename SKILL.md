---
name: protonmail
description: ProtonMail integration via Proton Mail Bridge for reading and sending encrypted emails.
homepage: https://github.com/rvacyber/openclaw-protonmail-skill
metadata: {"openclaw":{"emoji":"🔐","requires":{"env":["PROTONMAIL_ACCOUNT","PROTONMAIL_BRIDGE_PASSWORD"]},"install":[{"id":"brew-bridge","kind":"brew","formula":"proton-mail-bridge","bins":[],"label":"Install Proton Mail Bridge (macOS)","cask":true}]}}
---

![RVA Cyber](../assets/branding/rva-cyber-logo-horizontal-v1.png)

# ProtonMail Skill (v1.0.1)

Use ProtonMail for secure email via Proton Mail Bridge. Runs on Bun. CLI tested against live Proton Mail Bridge.

## Setup (once)

1. **Install Proton Mail Bridge:**
   ```bash
   brew install --cask proton-mail-bridge
   ```

2. **Launch Bridge and sign in:**
   - Open Proton Mail Bridge app
   - Sign in with your ProtonMail credentials
   - Bridge will generate local IMAP/SMTP credentials

3. **Configure the skill:**
   Add to your OpenClaw config (`~/.openclaw/openclaw.json`):
   ```json
   {
     "skills": {
       "entries": {
         "protonmail": {
           "enabled": true,
           "env": {
             "PROTONMAIL_ACCOUNT": "your-email@pm.me",
             "PROTONMAIL_BRIDGE_PASSWORD": "bridge-generated-password"
           }
         }
       }
     }
   }
   ```

   **Get Bridge credentials:**
   - In Bridge, click your account → Mailbox configuration
   - Copy the IMAP password (NOT your ProtonMail password)
   - Use `skills.entries.protonmail` (not `skills.protonmail`)

## CLI Usage

The skill provides a `protonmail` CLI tool:

```bash
# List inbox (most recent 10 emails)
protonmail list-inbox --limit=10 [--unread]

# Search emails
protonmail search "from:alice@example.com" --limit=20

# Read specific email
protonmail read <uid>

# Write one attachment's bytes to stdout — redirect them to a file
protonmail read <uid> --attachment=report.pdf > report.pdf

# Send email
protonmail send --to=bob@example.com --subject="Meeting" --body="See you at 3pm"

# Send email with attachment(s) — repeat --attach for multiple files
protonmail send --to=bob@example.com --subject="Report" --body="Attached." --attach=/path/report.pdf --attach=/path/data.csv

# Reply to email (optionally with attachments)
protonmail reply <uid> --body="Sounds good!" [--attach=/path/file.pdf]
```

Every `--attach` path is checked before anything is sent, so a mistyped path
fails on its own message rather than producing a half-formed email.
`--attachment` matches the filename exactly first, then case-insensitively,
and lists what the message does carry when nothing matches.

## Common Requests

- **List inbox:** "Check my ProtonMail inbox"
- **Search emails:** "Search ProtonMail for emails from alice@example.com"
- **Read email:** "Read ProtonMail email UID 31"
- **Send email:** "Send an email via ProtonMail to bob@example.com about the project"
- **Reply:** "Reply to ProtonMail email UID 31"

## How It Works

1. Proton Mail Bridge runs locally and connects to your ProtonMail account
2. Bridge provides local IMAP (read) and SMTP (send) servers
3. This skill connects to Bridge's local servers
4. All encryption/decryption happens locally via Bridge
5. No third-party services — direct ProtonMail integration

## Security

- ✅ Official Proton software (audited, open-source Bridge)
- ✅ End-to-end encryption maintained
- ✅ Credentials stored locally only
- ✅ No API keys or tokens — uses standard IMAP/SMTP
- ✅ Bridge password is separate from your ProtonMail password

## Troubleshooting

### "Connection refused" errors
- **Check Bridge is running:** Open Proton Mail Bridge app
- **Verify ports:** Bridge should show 127.0.0.1:1143 (IMAP) and 127.0.0.1:1025 (SMTP)

### "Authentication failed"
- **Use Bridge password, not ProtonMail password:** Get it from Bridge → Account → Mailbox configuration
- **Check account email:** Must match exactly (e.g., `user@pm.me` or `user@protonmail.com`)

### "Skill not found"
- **Reinstall skill:** Run `bun run install-skill` in the skill directory
- **Check OpenClaw config:** Ensure `skills.protonmail.enabled: true`

## Development

See [README.md](README.md) for development setup and testing.

## License

MIT — See [LICENSE](LICENSE)
