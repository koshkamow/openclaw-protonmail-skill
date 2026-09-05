/**
 * IMAP Client for Proton Mail Bridge
 *
 * Provides low-level IMAP operations for reading emails from ProtonMail.
 * Connects to Bridge's local IMAP server (127.0.0.1:1143 by default).
 *
 * @packageDocumentation
 */

import { ImapFlow } from 'imapflow';
import type { MailboxLockObject, SearchObject } from 'imapflow';
import { simpleParser, ParsedMail } from 'mailparser';

import { bridgeTlsOptions } from './bridge-tls';
import {
  assertDeletable,
  assertRelocatableSource,
  classifyMailbox,
  MailboxError,
  STARRED_MAILBOX,
  TRASH_MAILBOX,
} from './mailboxes';
import type { MailboxInfo } from './mailboxes';

/**
 * IMAP connection configuration
 */
export interface IMAPConfig {
  /** Bridge account username (email address) */
  user: string;

  /** Bridge-generated password */
  password: string;

  /** IMAP host (Bridge runs on localhost) */
  host: string;

  /** IMAP port (Bridge default: 1143) */
  port: number;

  /**
   * Implicit TLS from the first byte.
   *
   * @remarks
   * Bridge offers STARTTLS on a plaintext port instead, so this stays false
   * and the connection is upgraded during the handshake.
   */
  secure?: boolean;
}

/**
 * Email metadata returned by list operations
 */
export interface EmailMetadata {
  /** Message UID */
  uid: string;

  /** Sender address */
  from: string;

  /** Subject line */
  subject: string;

  /** Received date */
  date: Date;

  /** Read/unread status */
  flags: string[];
}

/** An address as ImapFlow reports it in an envelope */
interface EnvelopeAddress {
  name?: string;
  address?: string;
}

/**
 * Render envelope addresses in RFC 5322 form.
 *
 * @param list - Addresses from the message envelope
 * @returns `Alice <alice@example.com>` with a display name,
 *   `<alice@example.com>` without, several joined by `, `
 *
 * @remarks
 * This is a **normalisation, not a reproduction** of the From header. The
 * previous implementation passed through whatever bytes followed `From:`, and
 * an envelope cannot reconstruct those, so the output is regular instead.
 * Against the raw header it differs in four ways:
 *
 * - A bare `From: alice@example.com` gains angle brackets.
 * - A quoted display name loses its quotes: `"Smith, Alice" <a@x>` becomes
 *   `Smith, Alice <a@x>`.
 * - Every address is listed; the old code showed only the first.
 * - An RFC 2047 encoded name arrives decoded rather than as `=?utf-8?B?...?=`.
 *
 * Each is a regularisation of the same information, and this is a display
 * column rather than something parsed downstream — but it is not byte-identical
 * to what the header carried, and only the last of the four was called out
 * when the client was swapped.
 */
export function formatAddresses(list?: EnvelopeAddress[]): string {
  if (!list || list.length === 0) return '';

  return list
    .map((a) => (a.name ? `${a.name} <${a.address ?? ''}>` : `<${a.address ?? ''}>`))
    .join(', ');
}

/**
 * Parse search query string into IMAP criteria
 *
 * @param query - User-friendly search query
 * @returns ImapFlow search criteria
 *
 */
export function parseSearchQuery(query: string): SearchObject {
  const terms: SearchObject[] = [];

  const q = sanitizeSearchInput(query);

  // Parse supported key:value filters with quoted or unquoted values
  const filterRegex = /(from|subject|body):(?:"([^"]{1,200})"|([^\s]{1,200}))/gi;
  let match: RegExpExecArray | null;
  while ((match = filterRegex.exec(q)) !== null) {
    const key = match[1].toLowerCase();
    const rawValue = (match[2] || match[3] || '').trim();
    const value = sanitizeSearchValue(rawValue);
    if (!value) continue;

    if (key === 'from') terms.push({ from: value });
    if (key === 'subject') terms.push({ subject: value });
    if (key === 'body') terms.push({ body: value });
  }

  const dateMatch = q.match(/newer_than:(\d{1,3})([dh])/i);
  if (dateMatch) {
    const value = parseInt(dateMatch[1], 10);
    const unit = dateMatch[2].toLowerCase();
    if (value > 0 && value <= 365) {
      const date = new Date();
      if (unit === 'd') date.setDate(date.getDate() - value);
      else if (unit === 'h') date.setHours(date.getHours() - value);
      terms.push({ since: date });
    }
  }

  // If no supported filters, do safe keyword subject search
  if (terms.length === 0) {
    const fallback = sanitizeSearchValue(
      q.replace(/(from|subject|body|newer_than):[^\s]+/gi, '').trim()
    );
    if (!fallback) {
      throw new Error('Search query is empty or contains unsupported characters');
    }
    return { subject: fallback };
  }

  // Distinct keys on one SearchObject already AND together, which is what
  // several filters in a query mean. Repeating one filter — two `from:` in
  // the same query — takes the last value rather than requiring both, since
  // requiring both is a contradiction that can only return nothing.
  return Object.assign({}, ...terms) as SearchObject;
}

export function sanitizeSearchInput(input: string): string {
  const trimmed = (input || '').trim();
  if (!trimmed) {
    throw new Error('Search query is required');
  }
  if (trimmed.length > 200) {
    throw new Error('Search query too long (max 200 chars)');
  }
  // Block CR/LF and control chars. The class is the point of this guard,
  // so the rule that objects to control characters is off for this line.
  // eslint-disable-next-line no-control-regex
  if (/[\r\n\x00-\x1F\x7F]/.test(trimmed)) {
    throw new Error('Search query contains invalid control characters');
  }
  return trimmed;
}

export function sanitizeSearchValue(input: string): string {
  const value = (input || '').trim();
  if (!value) return '';
  // Allowlist: common email/search characters only
  if (!/^[a-zA-Z0-9@._+\-\s:]+$/.test(value)) {
    throw new Error('Search query contains unsupported characters');
  }
  return value.slice(0, 200);
}

/**
 * IMAP client for reading emails via Proton Mail Bridge
 *
 * @remarks
 * Bridge must be running before calling connect(). Every mailbox is opened
 * read-only and under a lock, so a fetch cannot run against whatever mailbox
 * a previous call happened to leave selected.
 */
export class IMAPClient {
  private client: ImapFlow | null = null;
  private config: IMAPConfig;

  /**
   * Create a new IMAP client
   *
   * @param config - IMAP connection settings
   */
  constructor(config: IMAPConfig) {
    this.config = config;
  }

  /**
   * Connect to Bridge IMAP server
   *
   * @throws {Error} If Bridge is not running or credentials are invalid
   *
   * @remarks
   * Ensure Proton Mail Bridge is running before calling this. An ImapFlow
   * instance cannot be reused after logout, so the client is built here
   * rather than in the constructor.
   */
  async connect(): Promise<void> {
    if (this.client) {
      return; // Already connected
    }

    const client = new ImapFlow({
      host: this.config.host,
      port: this.config.port,
      secure: this.config.secure ?? false,
      auth: {
        user: this.config.user,
        pass: this.config.password,
      },
      tls: bridgeTlsOptions(this.config.host),
      // ImapFlow logs every command at info level by default, which would put
      // the session — mailbox names, subjects — on stdout alongside the JSON
      // the CLI prints.
      logger: false,
    });

    // Without a listener an emitted error is an unhandled 'error' event, which
    // takes the process down instead of surfacing to the caller.
    client.on('error', () => {
      this.client = null;
    });

    await client.connect();
    this.client = client;
  }

  /**
   * Disconnect from Bridge
   */
  async disconnect(): Promise<void> {
    if (!this.client) return;

    const client = this.client;
    this.client = null;
    await client.logout();
  }

  /**
   * The live connection, or an error naming what the caller skipped.
   *
   * @private
   */
  private requireClient(): ImapFlow {
    if (!this.client) {
      throw new Error('IMAP client is not connected - call connect() first');
    }
    return this.client;
  }

  /**
   * Run an operation with a mailbox selected, and release it afterwards.
   *
   * @param mailbox - Mailbox path to select
   * @param readOnly - Select with EXAMINE rather than SELECT
   * @param fn - Work to run while the mailbox is held
   *
   * @remarks
   * The lock is what makes the selected mailbox unambiguous: concurrent calls
   * queue rather than stealing each other's selection, and the mailbox is
   * released even when the body throws.
   *
   * @private
   */
  private async withMailbox<T>(
    mailbox: string,
    readOnly: boolean,
    fn: (client: ImapFlow) => Promise<T>
  ): Promise<T> {
    const client = this.requireClient();
    const lock: MailboxLockObject = await client.getMailboxLock(mailbox, { readOnly });

    try {
      return await fn(client);
    } finally {
      lock.release();
    }
  }

  /**
   * Fetch metadata for a set of UIDs, newest first.
   *
   * @private
   */
  private async fetchMetadata(client: ImapFlow, uids: number[]): Promise<EmailMetadata[]> {
    if (uids.length === 0) return [];

    const emails: EmailMetadata[] = [];

    for await (const msg of client.fetch(
      uids.join(','),
      { uid: true, flags: true, envelope: true },
      { uid: true }
    )) {
      emails.push({
        uid: String(msg.uid),
        from: formatAddresses(msg.envelope?.from),
        subject: msg.envelope?.subject ?? '',
        date: msg.envelope?.date ?? new Date(NaN),
        flags: [...(msg.flags ?? [])],
      });
    }

    // The server answers in ascending order whatever order was asked for, so
    // newest-first is restored here rather than assumed.
    return emails.sort((a, b) => Number(b.uid) - Number(a.uid));
  }

  /**
   * List emails from inbox
   *
   * @param limit - Maximum emails to return
   * @param unreadOnly - Filter to unread messages only
   * @param mailbox - Mailbox to list (default: INBOX)
   * @returns Array of email metadata, newest first
   *
   * @example
   * ```typescript
   * const emails = await imap.listInbox(10, true);
   * console.log(emails.map(e => `${e.from}: ${e.subject}`));
   * ```
   */
  async listInbox(limit = 10, unreadOnly = false, mailbox = 'INBOX'): Promise<EmailMetadata[]> {
    return this.withMailbox(mailbox, true, async (client) => {
      const criteria: SearchObject = unreadOnly ? { seen: false } : { all: true };
      const uids = await client.search(criteria, { uid: true });

      if (!uids || uids.length === 0) return [];

      return this.fetchMetadata(client, uids.slice(-limit));
    });
  }

  /**
   * Search emails by query
   *
   * @param query - Search query (supports IMAP search syntax)
   * @param limit - Maximum results
   * @param mailbox - Mailbox to search (default: INBOX)
   * @returns Matching emails, newest first
   *
   * @example
   * Supported query formats:
   * - `from:alice@example.com` - Emails from sender
   * - `subject:meeting` - Subject contains keyword
   * - `body:invoice` - Body contains keyword
   * - `newer_than:7d` - Last 7 days
   */
  async search(query: string, limit = 10, mailbox = 'INBOX'): Promise<EmailMetadata[]> {
    const criteria = parseSearchQuery(query);

    return this.withMailbox(mailbox, true, async (client) => {
      const uids = await client.search(criteria, { uid: true });

      if (!uids || uids.length === 0) return [];

      return this.fetchMetadata(client, uids.slice(-limit));
    });
  }

  /**
   * List every mailbox, classified by which tree it belongs to
   *
   * @returns Mailboxes in the order the server reports them
   *
   * @example
   * ```typescript
   * const boxes = await imap.listMailboxes();
   * boxes.filter(b => b.kind === 'folder'); // user folders only
   * ```
   */
  async listMailboxes(): Promise<MailboxInfo[]> {
    const client = this.requireClient();

    return (await client.list()).map((box) => ({
      path: box.path,
      name: box.name,
      kind: classifyMailbox(box.path, [...(box.flags ?? [])]),
      specialUse: box.specialUse ?? null,
      selectable: !(box.flags ?? new Set<string>()).has('\\Noselect'),
    }));
  }

  /**
   * Create a mailbox
   *
   * @param path - Full IMAP path, e.g. `Folders/Receipts`
   * @returns The path created, and whether it already existed
   *
   * @remarks
   * Intermediate levels are created by the server, so `Folders/a/b` works
   * without creating `Folders/a` first.
   */
  async createMailbox(path: string): Promise<{ path: string; created: boolean }> {
    const client = this.requireClient();
    const result = await client.mailboxCreate(path);

    return { path: result.path, created: result.created };
  }

  /**
   * Delete a mailbox
   *
   * @param path - Full IMAP path
   * @returns The path deleted
   *
   * @throws {MailboxError} If the path names a system mailbox or a tree root,
   *   or if the mailbox does not exist
   *
   * @remarks
   * Existence is checked first so a typo reports the name rather than a raw
   * server error, and the guard against system mailboxes runs before anything
   * is sent.
   */
  async deleteMailbox(path: string): Promise<{ path: string }> {
    assertDeletable(path);

    const client = this.requireClient();

    const existing = (await client.list()).find((box) => box.path === path);
    if (!existing) {
      throw new MailboxError(`mailbox not found: ${path}`);
    }

    await client.mailboxDelete(path);
    return { path };
  }

  // ========================================
  // Message state
  // ========================================

  /**
   * Mark a message read or unread
   *
   * @param uid - Message UID
   * @param read - True to set `\Seen`, false to clear it
   * @param mailbox - Mailbox the message lives in
   * @returns The UID and its resulting read state
   *
   * @throws {Error} If the UID is not in the mailbox
   */
  async markRead(uid: string, read: boolean, mailbox = 'INBOX'): Promise<{ uid: string; read: boolean }> {
    return this.withMailbox(mailbox, false, async (client) => {
      await this.assertMessageExists(client, uid, mailbox);

      if (read) {
        await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true });
      } else {
        await client.messageFlagsRemove(uid, ['\\Seen'], { uid: true });
      }

      return { uid, read };
    });
  }

  /**
   * Star a message
   *
   * @param uid - Message UID
   * @param mailbox - Mailbox the message lives in
   * @returns The UID, and whether it was already starred
   *
   * @remarks
   * A star is membership of the `Starred` mailbox, so this copies the message
   * into it. Setting `\Flagged` directly does not star anything — Bridge
   * reverts the flag within about fifteen seconds, because the label is the
   * state and the flag only reflects it.
   */
  async star(uid: string, mailbox = 'INBOX'): Promise<{ uid: string; starred: boolean; alreadyStarred: boolean }> {
    const messageId = await this.messageIdOf(uid, mailbox);
    const existing = await this.findByMessageId(STARRED_MAILBOX, messageId);

    if (existing.length > 0) {
      return { uid, starred: true, alreadyStarred: true };
    }

    await this.withMailbox(mailbox, false, async (client) => {
      await client.messageCopy(uid, STARRED_MAILBOX, { uid: true });
    });

    return { uid, starred: true, alreadyStarred: false };
  }

  /**
   * Remove a message's star
   *
   * @param uid - Message UID
   * @param mailbox - Mailbox the message lives in
   * @returns The UID, and whether it had been starred
   *
   * @remarks
   * Removes the message's copy from the `Starred` mailbox, which is the label
   * rather than the message: the message stays where it lives. The copy is
   * found by Message-ID, since `Starred` has its own UID space.
   */
  async unstar(uid: string, mailbox = 'INBOX'): Promise<{ uid: string; starred: boolean; wasStarred: boolean }> {
    const messageId = await this.messageIdOf(uid, mailbox);
    const starredUids = await this.findByMessageId(STARRED_MAILBOX, messageId);

    if (starredUids.length === 0) {
      return { uid, starred: false, wasStarred: false };
    }

    await this.withMailbox(STARRED_MAILBOX, false, async (client) => {
      await client.messageDelete(starredUids, { uid: true });
    });

    return { uid, starred: false, wasStarred: true };
  }

  /**
   * Move a message to another mailbox
   *
   * @param uid - Message UID
   * @param target - Full path of the destination
   * @param mailbox - Folder the message lives in
   * @returns The UID, where it went, and its new UID there when the server says
   *
   * @throws {MailboxError} If `mailbox` is a label rather than a folder
   *
   * @remarks
   * Bridge advertises MOVE, so this is one atomic operation rather than a
   * copy followed by a delete that could half-fail.
   */
  async moveMessage(
    uid: string,
    target: string,
    mailbox = 'INBOX'
  ): Promise<{ uid: string; from: string; to: string; newUid: string | null }> {
    // A label is a projection, not a storage location; see
    // assertRelocatableSource for what MOVE against one was measured to do.
    assertRelocatableSource(mailbox);

    return this.withMailbox(mailbox, false, async (client) => {
      await this.assertMessageExists(client, uid, mailbox);

      const result = await client.messageMove(uid, target, { uid: true });

      // messageMove answers false when nothing matched. The existence check
      // above has already ruled that out, so this narrows the type rather
      // than reporting a case that can happen.
      const mapped = result === false ? undefined : result.uidMap?.get(Number(uid));

      return {
        uid,
        from: mailbox,
        to: target,
        newUid: mapped === undefined ? null : String(mapped),
      };
    });
  }

  /**
   * Delete a message
   *
   * @param uid - Message UID
   * @param permanent - Expunge instead of moving to Trash
   * @param mailbox - Folder the message lives in
   * @returns What was done and where the message went
   *
   * @throws {MailboxError} If `mailbox` is a label rather than a folder
   *
   * @remarks
   * The default moves to Trash, which is recoverable. Expunging is not, so it
   * happens only when asked for explicitly. Deleting from Trash itself is
   * always an expunge — there is nowhere else for it to go.
   */
  async deleteMessage(
    uid: string,
    permanent = false,
    mailbox = 'INBOX'
  ): Promise<{ uid: string; deleted: 'trashed' | 'expunged'; to: string | null }> {
    assertRelocatableSource(mailbox);

    const expunge = permanent || mailbox === TRASH_MAILBOX;

    if (expunge) {
      return this.withMailbox(mailbox, false, async (client) => {
        await this.assertMessageExists(client, uid, mailbox);
        await client.messageDelete(uid, { uid: true });
        return { uid, deleted: 'expunged' as const, to: null };
      });
    }

    await this.moveMessage(uid, TRASH_MAILBOX, mailbox);
    return { uid, deleted: 'trashed', to: TRASH_MAILBOX };
  }

  /**
   * Throw unless the UID is present in the currently selected mailbox.
   *
   * @private
   */
  private async assertMessageExists(client: ImapFlow, uid: string, mailbox: string): Promise<void> {
    const found = await client.fetchOne(uid, { uid: true }, { uid: true });
    if (!found) {
      throw new Error(`Message UID ${uid} not found in ${mailbox}`);
    }
  }

  /**
   * The Message-ID header of a UID, which identifies it across mailboxes.
   *
   * @private
   */
  private async messageIdOf(uid: string, mailbox: string): Promise<string> {
    return this.withMailbox(mailbox, true, async (client) => {
      const msg = await client.fetchOne(uid, { envelope: true }, { uid: true });

      if (!msg) {
        throw new Error(`Message UID ${uid} not found in ${mailbox}`);
      }

      const messageId = msg.envelope?.messageId;
      if (!messageId) {
        throw new Error(`Message UID ${uid} has no Message-ID, so it cannot be matched across mailboxes`);
      }

      return messageId;
    });
  }

  /**
   * UIDs in a mailbox carrying a given Message-ID.
   *
   * @private
   */
  private async findByMessageId(mailbox: string, messageId: string): Promise<number[]> {
    return this.withMailbox(mailbox, true, async (client) => {
      const hits = await client.search({ header: { 'message-id': messageId } }, { uid: true });
      return hits || [];
    });
  }

  /**
   * Read full email content by UID
   *
   * @param messageId - Message UID
   * @param mailbox - Mailbox the message lives in (default: INBOX)
   * @returns Parsed email with headers, body, and attachments
   *
   * @throws {Error} If message UID is invalid
   *
   * @example
   * ```typescript
   * const email = await imap.readMessage('1234');
   * console.log(email.text); // Plain text body
   * console.log(email.html); // HTML body
   * console.log(email.attachments); // File attachments
   * ```
   */
  async readMessage(messageId: string, mailbox = 'INBOX'): Promise<ParsedMail> {
    return this.withMailbox(mailbox, true, async (client) => {
      const msg = await client.fetchOne(messageId, { source: true }, { uid: true });

      if (!msg || !msg.source) {
        throw new Error(`Message UID ${messageId} not found in ${mailbox}`);
      }

      return simpleParser(msg.source);
    });
  }
}
