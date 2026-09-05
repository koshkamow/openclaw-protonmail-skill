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

### Folders and labels

Proton keeps **folders and labels in separate trees**, under `\Noselect`
parents named `Folders` and `Labels`. A message lives in exactly one folder and
can carry many labels, so every command says which it means: the default is a
folder, and `--label` selects the other tree.

```bash
# Every mailbox, classified as system / folder / label / container
protonmail list-folders

# Just one kind
protonmail list-folders --kind=folder
protonmail list-folders --kind=label

# Create — "Receipts" becomes Folders/Receipts, or Labels/Receipts with --label
protonmail create-folder Receipts
protonmail create-folder Urgent --label

# Nesting works; intermediate levels are created for you
protonmail create-folder "2026/Q1"

# Delete
protonmail delete-folder Receipts
protonmail delete-folder Urgent --label
```

A full path from `list-folders` is accepted as given (`Folders/Receipts`), and
is refused when it names the other tree — `delete-folder Labels/Urgent` is an
error rather than a silent guess. Proton's own mailboxes (`INBOX`, `Sent`,
`Drafts`, `Archive`, `Spam`, `Trash`, `All Mail`, `Starred`) and the two tree
roots cannot be created or deleted.

### Message state

```bash
protonmail mark-read <uid>
protonmail mark-unread <uid>
protonmail star <uid>
protonmail unstar <uid>

# Move: a system mailbox, or a bare folder/label name, or a full path
protonmail move <uid> Archive
protonmail move <uid> Receipts
protonmail move <uid> Labels/Urgent

# Delete moves to Trash, which is recoverable
protonmail delete <uid>

# Irrecoverable, so it has to be asked for
protonmail delete <uid> --permanent
```

All of these take `--mailbox=<path>` to act on a message outside INBOX. UIDs
are per-mailbox, so a message that moves gets a new UID in its destination —
`move` reports it as `newUid`.

**How a Proton star works.** Measured against Bridge 03.25.00: the star is
membership of the `Starred` mailbox, not a flag you can set. A starred message
does read as `\Flagged` in its home mailbox, but that is a projection of the
label rather than the state — setting `\Flagged` directly stars nothing, and
Bridge reverts the flag within about fifteen seconds. So `star` copies the
message into `Starred` and `unstar` removes it from there, matching it by
Message-ID because `Starred` has its own UID space. Both are idempotent and
report whether the message was already in that state.

## Common Requests

- **List inbox:** "Check my ProtonMail inbox"
- **Search emails:** "Search ProtonMail for emails from alice@example.com"
- **Read email:** "Read ProtonMail email UID 31"
- **Send email:** "Send an email via ProtonMail to bob@example.com about the project"
- **Reply:** "Reply to ProtonMail email UID 31"
- **List folders:** "What folders and labels do I have in ProtonMail?"
- **Make a folder:** "Create a ProtonMail folder called Receipts"

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
