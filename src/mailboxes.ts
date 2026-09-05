/**
 * Proton's mailbox tree: Folders, Labels, and the system mailboxes.
 *
 * @packageDocumentation
 *
 * @remarks
 * Proton exposes two separate user trees over IMAP, under `\Noselect` parents
 * named literally `Folders` and `Labels`, alongside the system mailboxes.
 * Observed on Bridge 03.25.00:
 *
 * ```
 * INBOX      \Marked \Noinferiors            \Inbox
 * Sent       \Marked \Noinferiors \Sent      \Sent
 * Drafts     \Drafts \Noinferiors \Unmarked  \Drafts
 * Archive    \Archive \Noinferiors \Unmarked \Archive
 * Spam       \Junk \Marked \Noinferiors      \Junk
 * Trash      \Marked \Noinferiors \Trash     \Trash
 * All Mail   \All \Marked \Noinferiors
 * Starred    \Flagged \Marked \Noinferiors
 * Folders    \Noselect \Unmarked             ← user folders live below this
 * Labels     \Noselect \Unmarked             ← user labels live below this
 * ```
 *
 * The two behave differently: a message lives in exactly one folder, and can
 * carry many labels. Because they are different things, the CLI names which
 * one it means rather than guessing — `--label` selects the Labels tree, and
 * the default is Folders.
 */

/** Which tree a mailbox belongs to */
export type MailboxKind = 'system' | 'folder' | 'label' | 'container';

/** A mailbox as the CLI reports it */
export interface MailboxInfo {
  /** Full IMAP path, e.g. `Folders/Receipts` */
  path: string;

  /** Leaf name, e.g. `Receipts` */
  name: string;

  /** Which tree it belongs to */
  kind: MailboxKind;

  /** IMAP special-use attribute, when the server gives one */
  specialUse: string | null;

  /** Whether messages can be stored in it — false for the `\Noselect` parents */
  selectable: boolean;
}

/** The `\Noselect` parent of the user folder tree */
export const FOLDERS_ROOT = 'Folders';

/** The `\Noselect` parent of the user label tree */
export const LABELS_ROOT = 'Labels';

/**
 * Mailboxes Proton provides and that must not be deleted.
 *
 * @remarks
 * Deleting one is not a recoverable mistake, and Bridge does not always
 * refuse. Compared case-insensitively, since IMAP only guarantees that
 * `INBOX` itself is case-insensitive.
 */
const SYSTEM_MAILBOXES = [
  'INBOX',
  'Sent',
  'Drafts',
  'Archive',
  'Spam',
  'Trash',
  'All Mail',
  'Starred',
];

/**
 * Whether a name is one of Proton's own mailboxes.
 *
 * @param name - A mailbox name with no tree prefix, e.g. `INBOX`
 *
 * @remarks
 * Compared case-insensitively, since IMAP only guarantees that `INBOX` itself
 * is case-insensitive.
 */
export function isSystemMailbox(name: string): boolean {
  const trimmed = (name || '').trim().toLowerCase();
  return SYSTEM_MAILBOXES.some((m) => m.toLowerCase() === trimmed);
}

/** Raised when a mailbox name or operation is not allowed. */
export class MailboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MailboxError';
  }
}

/**
 * Classify a mailbox by its path and LIST flags.
 *
 * @param path - Full IMAP path
 * @param flags - LIST flags reported for it
 * @returns Which tree the mailbox belongs to
 */
export function classifyMailbox(path: string, flags: string[] = []): MailboxKind {
  if (path === FOLDERS_ROOT || path === LABELS_ROOT) return 'container';
  if (flags.includes('\\Noselect')) return 'container';
  if (path.startsWith(`${FOLDERS_ROOT}/`)) return 'folder';
  if (path.startsWith(`${LABELS_ROOT}/`)) return 'label';
  return 'system';
}

/**
 * Turn a name given on the command line into a full IMAP path.
 *
 * @param name - Either a bare name (`Receipts`) or a full path (`Folders/Receipts`)
 * @param kind - Which tree a bare name belongs to
 * @returns The full path
 *
 * @throws {MailboxError} If the name is empty, or names the wrong tree for `kind`
 *
 * @remarks
 * A bare name is placed under the requested tree. A name that already carries
 * its tree is accepted as given, so a path copied out of `list-folders` works
 * — but only if it agrees with `kind`, so `create-folder Labels/x` is an error
 * rather than a folder that quietly became a label.
 *
 * @example
 * ```typescript
 * resolveMailboxPath('Receipts', 'folder');         // 'Folders/Receipts'
 * resolveMailboxPath('Folders/Receipts', 'folder'); // 'Folders/Receipts'
 * resolveMailboxPath('Receipts', 'label');          // 'Labels/Receipts'
 * ```
 */
export function resolveMailboxPath(name: string, kind: 'folder' | 'label'): string {
  const trimmed = (name || '').trim();

  if (!trimmed) {
    throw new MailboxError('mailbox name is required');
  }

  // A path separator is meaningful (nesting); a control character or a
  // wildcard is not, and would be interpreted by the server.
  // eslint-disable-next-line no-control-regex
  if (/[\r\n\x00-\x1F\x7F*%"]/.test(trimmed)) {
    throw new MailboxError(`mailbox name contains invalid characters: ${name}`);
  }

  if (trimmed.startsWith('/') || trimmed.endsWith('/') || trimmed.includes('//')) {
    throw new MailboxError(`mailbox name has an empty path segment: ${name}`);
  }

  const wanted = kind === 'folder' ? FOLDERS_ROOT : LABELS_ROOT;
  const other = kind === 'folder' ? LABELS_ROOT : FOLDERS_ROOT;

  if (trimmed === wanted || trimmed === other) {
    throw new MailboxError(`'${trimmed}' is the tree itself, not a mailbox in it`);
  }

  if (trimmed.startsWith(`${other}/`)) {
    throw new MailboxError(
      `'${trimmed}' is a ${other === LABELS_ROOT ? 'label' : 'folder'}, ` +
        `but this command was told ${kind}`
    );
  }

  if (trimmed.startsWith(`${wanted}/`)) {
    return trimmed;
  }

  // A bare system mailbox name would otherwise be prefixed into
  // `Folders/INBOX` — a mailbox that does not exist — so the guard against
  // touching system mailboxes would never see the name the user typed, and
  // `delete-folder INBOX` would report "not found" rather than why it refused.
  if (isSystemMailbox(trimmed)) {
    throw new MailboxError(
      `'${trimmed}' is a Proton system mailbox, not a ${kind}`
    );
  }

  return `${wanted}/${trimmed}`;
}

/**
 * Check that a mailbox may be deleted.
 *
 * @param path - Full IMAP path
 *
 * @throws {MailboxError} If the path names a system mailbox or a tree root
 *
 * @remarks
 * Deleting `Folders` would take every user folder with it, and deleting a
 * system mailbox is not something a typo should be able to do.
 */
export function assertDeletable(path: string): void {
  const trimmed = (path || '').trim();

  if (trimmed === FOLDERS_ROOT || trimmed === LABELS_ROOT) {
    throw new MailboxError(
      `refusing to delete '${trimmed}': it is the tree holding every user ` +
        `${trimmed === FOLDERS_ROOT ? 'folder' : 'label'}`
    );
  }

  const system = SYSTEM_MAILBOXES.find((m) => m.toLowerCase() === trimmed.toLowerCase());
  if (system) {
    throw new MailboxError(`refusing to delete '${system}': it is a Proton system mailbox`);
  }
}
