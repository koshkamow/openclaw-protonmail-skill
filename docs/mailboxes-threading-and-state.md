# Mailboxes, threading and message state

Behaviour that is not obvious from the command list, measured against Proton
Mail Bridge 03.25.00. `SKILL.md` links here rather than carrying it, so the
skill manifest stays a command reference.

## Mailboxes

Proton keeps **folders and labels in separate trees**, under `\Noselect`
parents named literally `Folders` and `Labels`, alongside the system
mailboxes:

```
INBOX      \Marked \Noinferiors            \Inbox
Sent       \Marked \Noinferiors \Sent      \Sent
Drafts     \Drafts \Noinferiors \Unmarked  \Drafts
Archive    \Archive \Noinferiors \Unmarked \Archive
Spam       \Junk \Marked \Noinferiors      \Junk
Trash      \Marked \Noinferiors \Trash     \Trash
All Mail   \All \Marked \Noinferiors
Starred    \Flagged \Marked \Noinferiors
Folders    \Noselect \Unmarked             ← user folders live below this
Labels     \Noselect \Unmarked             ← user labels live below this
```

A message lives in exactly one folder and can carry many labels. Because they
are different things, every command says which it means: the default is a
folder, and `--label` selects the other tree.

`--mailbox` resolves a bare name against the mailboxes that exist, so
`Receipts` finds `Folders/Receipts`. An unknown name lists what is available,
and a name that is both a folder and a label asks for the full path rather
than picking one. A full path from `list-folders` is accepted as given, and is
refused when it names the other tree — `delete-folder Labels/Urgent` is an
error rather than a silent guess.

Proton's own mailboxes (`INBOX`, `Sent`, `Drafts`, `Archive`, `Spam`, `Trash`,
`All Mail`, `Starred`) and the two tree roots cannot be created or deleted.

**UIDs are per-mailbox.** UID 77 in `Sent` is a different message from UID 77
in `INBOX`, and a message that moves gets a new UID at its destination —
`move` reports it as `newUid`.

## Moving and deleting out of a label

`move` and `delete` refuse a **label** as the source mailbox. A label mailbox
lists messages that live elsewhere, so moving out of one was measured to drop
the label *and* relocate the physical message, which is not what either
command promises. They ask you to name the folder the message lives in
instead. Moving *into* a label is fine; only the source is restricted.

## How a Proton star works

The star is membership of the `Starred` mailbox, not a flag you can set. A
starred message does read as `\Flagged` in its home mailbox, but that is a
projection of the label rather than the state: setting `\Flagged` directly
stars nothing, and Bridge reverts the flag within about fifteen seconds.

So `star` copies the message into `Starred` and `unstar` removes it from
there, matching it by Message-ID because `Starred` has its own UID space. Both
are idempotent and report whether the message was already in that state.

## `reply` versus `thread`

`reply` answers the sender under a `Re: ` subject. `thread` sends a **new**
message into an existing conversation, and differs in the two ways that decide
where it lands:

- The subject is carried **byte for byte** — no `Re: ` added, no whitespace
  tidied.
- The recipients can be set, so someone can be brought into the conversation
  without starting a new one.

`In-Reply-To` and `References` are taken from the message named, extending the
chain rather than restating it.

Both matter, for different reasons. The headers are what any
standards-respecting client threads on; the unchanged subject is what Proton's
own UI needs, because it groups a conversation by subject *plus participants*.
A subject that drifts splits the thread in Proton even when the headers are
right.

## Attachments

Every `--attach` path is checked before anything is sent, so a mistyped path
fails on its own message rather than producing a half-formed email.

`--attachment` matches the filename exactly first, then case-insensitively,
and lists what the message does carry when nothing matches. It writes raw
bytes to stdout, so redirect them to a file.
