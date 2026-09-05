/**
 * ProtonMail Skill for OpenClaw
 *
 * Provides secure email integration through Proton Mail Bridge.
 * Bridge runs locally and provides IMAP/SMTP access to your ProtonMail account
 * while maintaining end-to-end encryption.
 *
 * @packageDocumentation
 *
 * @example
 * ```typescript
 * import ProtonMailSkill from 'openclaw-protonmail-skill';
 *
 * const skill = new ProtonMailSkill({
 *   account: 'user@pm.me',
 *   bridgePassword: 'bridge-generated-password'
 * });
 *
 * await skill.initialize();
 * const inbox = await skill.listInbox(10);
 * await skill.cleanup();
 * ```
 */

import type { ParsedMail } from 'mailparser';

import { bridgeTlsOptions } from './bridge-tls';
import type { EmailMetadata } from './imap';
import { IMAPClient } from './imap';
import type { MailboxInfo } from './mailboxes';
import { resolveMailboxPath, resolveTargetMailbox } from './mailboxes';
import type { ReplyOptions, SendOptions, SentMessageInfo, ThreadOptions } from './smtp';
import { SMTPClient } from './smtp';
import { registerTools } from './tools';

export type { ResolvedAttachment } from './attachments';
export {
  AttachmentError,
  pickAttachment,
  resolveAttachments,
} from './attachments';
export { bridgeTlsOptions } from './bridge-tls';
export type { EmailMetadata, IMAPConfig } from './imap';
export type { MailboxInfo, MailboxKind } from './mailboxes';
export {
  assertDeletable,
  assertRelocatableSource,
  classifyMailbox,
  FOLDERS_ROOT,
  isSystemMailbox,
  LABELS_ROOT,
  MailboxError,
  resolveMailboxPath,
  resolveTargetMailbox,
  STARRED_MAILBOX,
  TRASH_MAILBOX,
} from './mailboxes';
export type {
  ReplyOptions,
  SendOptions,
  SentMessageInfo,
  SMTPConfig,
  ThreadOptions,
} from './smtp';
export type { ThreadableMessage, ThreadingHeaders } from './threading';
export {
  replySubject,
  threadingHeaders,
  threadSubject,
} from './threading';

/**
 * Configuration options for ProtonMail skill
 */
export interface ProtonMailConfig {
  /** ProtonMail account email (e.g., user@pm.me or user@protonmail.com) */
  account?: string;

  /** Bridge-generated password (NOT your ProtonMail password) */
  bridgePassword?: string;

  /** IMAP host (default: 127.0.0.1) */
  imapHost?: string;

  /** IMAP port (default: 1143) */
  imapPort?: number;

  /** SMTP host (default: 127.0.0.1) */
  smtpHost?: string;

  /** SMTP port (default: 1025) */
  smtpPort?: number;
}

/**
 * Load configuration from environment variables or passed config
 */
function loadConfig(config?: ProtonMailConfig): Required<
  Omit<ProtonMailConfig, 'account' | 'bridgePassword'>
> & {
  account: string;
  bridgePassword: string;
} {
  const account = config?.account || process.env.PROTONMAIL_ACCOUNT;
  const bridgePassword = config?.bridgePassword || process.env.PROTONMAIL_BRIDGE_PASSWORD;

  if (!account) {
    throw new Error(
      'ProtonMail account not configured. Set PROTONMAIL_ACCOUNT env var or pass account in config.',
    );
  }

  if (!bridgePassword) {
    throw new Error(
      'ProtonMail Bridge password not configured. Set PROTONMAIL_BRIDGE_PASSWORD env var or pass bridgePassword in config.',
    );
  }

  return {
    account,
    bridgePassword,
    imapHost: config?.imapHost || '127.0.0.1',
    imapPort: config?.imapPort || 1143,
    smtpHost: config?.smtpHost || '127.0.0.1',
    smtpPort: config?.smtpPort || 1025,
  };
}

/**
 * Main skill class for ProtonMail integration
 *
 * Manages IMAP and SMTP connections to Proton Mail Bridge and provides
 * high-level email operations for OpenClaw.
 */
export class ProtonMailSkill {
  private imap: IMAPClient;
  private smtp: SMTPClient;

  /**
   * Create a new ProtonMail skill instance
   *
   * @param config - Optional configuration. If not provided, reads from environment variables.
   *
   * @remarks
   * The Bridge password is separate from your ProtonMail password. Get it from
   * Proton Mail Bridge → Account Settings → Mailbox Configuration.
   *
   * Configuration priority:
   * 1. Passed config object
   * 2. Environment variables (PROTONMAIL_ACCOUNT, PROTONMAIL_BRIDGE_PASSWORD)
   */
  constructor(config?: ProtonMailConfig) {
    const fullConfig = loadConfig(config);

    // Security hardening: Proton Bridge must be localhost-only
    const localHosts = new Set(['127.0.0.1', 'localhost', '::1']);
    if (!localHosts.has(fullConfig.imapHost) || !localHosts.has(fullConfig.smtpHost)) {
      throw new Error(
        'Unsafe Bridge host configuration. IMAP/SMTP hosts must be localhost (127.0.0.1, localhost, or ::1).',
      );
    }

    // secure: false means "connect in the clear, then STARTTLS" — the same
    // shape as the SMTP config below, and how Bridge's IMAP port works.
    const imapConfig = {
      user: fullConfig.account,
      password: fullConfig.bridgePassword,
      host: fullConfig.imapHost,
      port: fullConfig.imapPort,
      secure: false,
    };

    // secure: false plus requireTLS means "connect in the clear, then insist on
    // STARTTLS" — which is how Bridge's SMTP port works. The connection fails
    // rather than falling back to plaintext if the upgrade is unavailable.
    const smtpConfig = {
      host: fullConfig.smtpHost,
      port: fullConfig.smtpPort,
      secure: false,
      requireTLS: true,
      tls: bridgeTlsOptions(fullConfig.smtpHost),
      auth: {
        user: fullConfig.account,
        pass: fullConfig.bridgePassword,
      },
    };

    this.imap = new IMAPClient(imapConfig);
    this.smtp = new SMTPClient(smtpConfig);
  }

  /**
   * Initialize the skill and register tools with OpenClaw
   *
   * @throws {Error} If Bridge is not running or credentials are invalid
   *
   * @remarks
   * Ensure Proton Mail Bridge is running before calling this method.
   */
  async initialize(): Promise<void> {
    await this.imap.connect();
    registerTools(this);
  }

  /**
   * Cleanup and disconnect from Bridge
   *
   * @remarks
   * Always call this when shutting down to cleanly close connections.
   */
  async cleanup(): Promise<void> {
    await this.imap.disconnect();
  }

  // ========================================
  // Public methods for OpenClaw tool calls
  // ========================================

  /**
   * List recent emails from inbox
   *
   * @param limit - Maximum number of emails to return (default: 10)
   * @param unreadOnly - Only return unread emails (default: false)
   * @returns Array of email metadata (sender, subject, date, etc.)
   *
   * @example
   * ```typescript
   * const recent = await skill.listInbox(5, true); // 5 unread emails
   * ```
   */
  async listInbox(limit = 10, unreadOnly = false, mailbox = 'INBOX'): Promise<EmailMetadata[]> {
    return this.imap.listInbox(limit, unreadOnly, await this.resolveMailbox(mailbox));
  }

  /**
   * Search emails by query
   *
   * @param query - Search query (sender, subject, body keywords)
   * @param limit - Maximum results to return (default: 10)
   * @returns Matching emails
   *
   * @example
   * ```typescript
   * const results = await skill.searchEmails('from:alice@example.com', 20);
   * ```
   */
  async searchEmails(query: string, limit = 10, mailbox = 'INBOX'): Promise<EmailMetadata[]> {
    return this.imap.search(query, limit, await this.resolveMailbox(mailbox));
  }

  /**
   * Read a specific email by ID
   *
   * @param messageId - Message UID or sequence number
   * @returns Full email content (headers, body, attachments)
   *
   * @throws {Error} If message ID is invalid or email doesn't exist
   */
  async readEmail(messageId: string, mailbox = 'INBOX'): Promise<ParsedMail> {
    return this.imap.readMessage(messageId, await this.resolveMailbox(mailbox));
  }

  /**
   * Send a new email via ProtonMail
   *
   * @param to - Recipient email address
   * @param subject - Email subject
   * @param body - Email body (plain text)
   * @param options - Optional settings (CC, BCC, HTML, attachments)
   * @returns Send result
   *
   * @example
   * ```typescript
   * await skill.sendEmail(
   *   'alice@example.com',
   *   'Meeting Follow-up',
   *   'Thanks for the meeting today...',
   *   { cc: 'bob@example.com' }
   * );
   * ```
   */
  async sendEmail(
    to: string,
    subject: string,
    body: string,
    options?: SendOptions,
  ): Promise<SentMessageInfo> {
    return this.smtp.send(to, subject, body, options);
  }

  /**
   * Reply to an existing email thread
   *
   * @param messageId - Original message ID to reply to
   * @param body - Reply text
   * @param options - Optional settings (attachments)
   * @returns Send result
   *
   * @remarks
   * Automatically sets Reply-To, In-Reply-To, and References headers
   * to maintain threading.
   */
  async replyToEmail(
    messageId: string,
    body: string,
    options?: ReplyOptions,
    mailbox = 'INBOX',
  ): Promise<SentMessageInfo> {
    const original = await this.imap.readMessage(messageId, await this.resolveMailbox(mailbox));
    return this.smtp.reply(original, body, options);
  }

  /**
   * Send a new message into an existing conversation
   *
   * @param messageId - UID of a message in the conversation to continue
   * @param body - Message text
   * @param options - Recipients and attachments
   * @returns Send result
   *
   * @remarks
   * Where replyToEmail answers the sender under a `Re: ` subject, this carries
   * the subject byte for byte and lets the recipients be set. Proton groups a
   * conversation by subject plus participants, so an unchanged subject is what
   * keeps the message in the thread in its UI.
   */
  async continueThread(
    messageId: string,
    body: string,
    options?: ThreadOptions,
    mailbox = 'INBOX',
  ): Promise<SentMessageInfo> {
    const original = await this.imap.readMessage(messageId, await this.resolveMailbox(mailbox));
    return this.smtp.continueThread(original, body, options);
  }

  /**
   * Turn a mailbox name from a caller into a full IMAP path.
   *
   * @remarks
   * INBOX short-circuits, so the common case costs no extra round trip. Any
   * other name is resolved against the mailboxes that exist, which is what
   * lets `--mailbox=Receipts` mean `Folders/Receipts` and reports an unknown
   * or ambiguous name instead of selecting nothing.
   *
   * @private
   */
  private async resolveMailbox(mailbox: string): Promise<string> {
    if (!mailbox || mailbox === 'INBOX') return 'INBOX';
    return resolveTargetMailbox(mailbox, await this.imap.listMailboxes());
  }

  // ========================================
  // Mailboxes
  // ========================================

  /**
   * List every mailbox, classified as system, folder, label or container
   *
   * @returns Mailboxes in the order the server reports them
   *
   * @remarks
   * Proton keeps folders and labels in separate trees, under `\Noselect`
   * parents named `Folders` and `Labels`. A message lives in one folder and
   * can carry many labels.
   */
  async listMailboxes(): Promise<MailboxInfo[]> {
    return this.imap.listMailboxes();
  }

  /**
   * Create a folder or a label
   *
   * @param name - Bare name (`Receipts`) or full path (`Folders/Receipts`)
   * @param kind - Which tree to create it in
   * @returns The path created, and whether it already existed
   */
  async createMailbox(
    name: string,
    kind: 'folder' | 'label' = 'folder',
  ): Promise<{ path: string; created: boolean }> {
    return this.imap.createMailbox(resolveMailboxPath(name, kind));
  }

  /**
   * Delete a folder or a label
   *
   * @param name - Bare name (`Receipts`) or full path (`Folders/Receipts`)
   * @param kind - Which tree it lives in
   * @returns The path deleted
   *
   * @throws {MailboxError} If it names a system mailbox, a tree root, or
   *   a mailbox that does not exist
   */
  async deleteMailbox(
    name: string,
    kind: 'folder' | 'label' = 'folder',
  ): Promise<{ path: string }> {
    return this.imap.deleteMailbox(resolveMailboxPath(name, kind));
  }

  // ========================================
  // Message state
  // ========================================

  /**
   * Mark a message read or unread
   *
   * @param uid - Message UID
   * @param read - True for read, false for unread
   * @param mailbox - Mailbox the message lives in (default: INBOX)
   */
  async markRead(
    uid: string,
    read: boolean,
    mailbox = 'INBOX',
  ): Promise<{ uid: string; read: boolean }> {
    return this.imap.markRead(uid, read, await this.resolveMailbox(mailbox));
  }

  /**
   * Star a message
   *
   * @param uid - Message UID
   * @param mailbox - Mailbox the message lives in (default: INBOX)
   *
   * @remarks
   * Proton's star is membership of the `Starred` mailbox. Setting `\Flagged`
   * directly does not star anything; Bridge reverts it.
   */
  async starEmail(
    uid: string,
    mailbox = 'INBOX',
  ): Promise<{ uid: string; starred: boolean; alreadyStarred: boolean }> {
    return this.imap.star(uid, await this.resolveMailbox(mailbox));
  }

  /**
   * Remove a message's star
   *
   * @param uid - Message UID
   * @param mailbox - Mailbox the message lives in (default: INBOX)
   */
  async unstarEmail(
    uid: string,
    mailbox = 'INBOX',
  ): Promise<{ uid: string; starred: boolean; wasStarred: boolean }> {
    return this.imap.unstar(uid, await this.resolveMailbox(mailbox));
  }

  /**
   * Move a message to another mailbox
   *
   * @param uid - Message UID
   * @param target - Destination: a full path, or a bare folder or label name
   * @param mailbox - Mailbox the message lives in (default: INBOX)
   *
   * @remarks
   * The target is resolved against the mailboxes that exist, so a system
   * mailbox (`Archive`) and a user folder (`Receipts`) are both accepted, and
   * a name that exists in both trees is reported as ambiguous rather than
   * guessed at.
   */
  async moveEmail(
    uid: string,
    target: string,
    mailbox = 'INBOX',
  ): Promise<{ uid: string; from: string; to: string; newUid: string | null }> {
    const boxes = await this.imap.listMailboxes();
    return this.imap.moveMessage(
      uid,
      resolveTargetMailbox(target, boxes),
      mailbox === 'INBOX' ? 'INBOX' : resolveTargetMailbox(mailbox, boxes),
    );
  }

  /**
   * Delete a message, to Trash by default
   *
   * @param uid - Message UID
   * @param permanent - Expunge rather than move to Trash
   * @param mailbox - Mailbox the message lives in (default: INBOX)
   */
  async deleteEmail(
    uid: string,
    permanent = false,
    mailbox = 'INBOX',
  ): Promise<{ uid: string; deleted: 'trashed' | 'expunged'; to: string | null }> {
    return this.imap.deleteMessage(uid, permanent, await this.resolveMailbox(mailbox));
  }
}

export default ProtonMailSkill;
