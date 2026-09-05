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
 * Render envelope addresses the way the raw header reads.
 *
 * @remarks
 * `Alice <alice@example.com>` when a display name is set, `<alice@example.com>`
 * when it is not — the shape the previous header-parsing implementation
 * produced. Unlike that one, an RFC 2047 encoded name arrives here decoded.
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
   * @returns Array of email metadata, newest first
   *
   * @example
   * ```typescript
   * const emails = await imap.listInbox(10, true);
   * console.log(emails.map(e => `${e.from}: ${e.subject}`));
   * ```
   */
  async listInbox(limit = 10, unreadOnly = false): Promise<EmailMetadata[]> {
    return this.withMailbox('INBOX', true, async (client) => {
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
   * @returns Matching emails, newest first
   *
   * @example
   * Supported query formats:
   * - `from:alice@example.com` - Emails from sender
   * - `subject:meeting` - Subject contains keyword
   * - `body:invoice` - Body contains keyword
   * - `newer_than:7d` - Last 7 days
   */
  async search(query: string, limit = 10): Promise<EmailMetadata[]> {
    const criteria = parseSearchQuery(query);

    return this.withMailbox('INBOX', true, async (client) => {
      const uids = await client.search(criteria, { uid: true });

      if (!uids || uids.length === 0) return [];

      return this.fetchMetadata(client, uids.slice(-limit));
    });
  }

  /**
   * Read full email content by UID
   *
   * @param messageId - Message UID
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
  async readMessage(messageId: string): Promise<ParsedMail> {
    return this.withMailbox('INBOX', true, async (client) => {
      const msg = await client.fetchOne(messageId, { source: true }, { uid: true });

      if (!msg || !msg.source) {
        throw new Error(`Message UID ${messageId} not found in INBOX`);
      }

      return simpleParser(msg.source);
    });
  }
}
