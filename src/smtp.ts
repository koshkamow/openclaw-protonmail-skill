/**
 * SMTP Client for Proton Mail Bridge
 * 
 * Provides email sending capabilities through Bridge's local SMTP server.
 * Connects to 127.0.0.1:1025 by default.
 * 
 * @packageDocumentation
 */

import nodemailer from 'nodemailer';
import type { Transporter, SendMailOptions } from 'nodemailer';
import type { PeerCertificate } from 'tls';

import { threadingHeaders, replySubject, threadSubject } from './threading';

/**
 * SMTP connection configuration
 */
export interface SMTPConfig {
  /** SMTP host (Bridge runs on localhost) */
  host: string;
  
  /** SMTP port (Bridge default: 1025) */
  port: number;
  
  /** Use TLS from start (false for Bridge) */
  secure: boolean;
  
  /** Bridge authentication credentials */
  auth: {
    /** Bridge account email */
    user: string;
    
    /** Bridge-generated password */
    pass: string;
  };
  
  /** Fail rather than fall back to plaintext when STARTTLS is unavailable */
  requireTLS?: boolean;

  /**
   * TLS options for the STARTTLS upgrade.
   *
   * @remarks
   * Build these with `bridgeTlsOptions()` — Bridge's certificate names only
   * the IP `127.0.0.1`, and Bun needs the host named explicitly.
   */
  tls?: {
    rejectUnauthorized?: boolean;
    checkServerIdentity?: (servername: string, cert: PeerCertificate) => Error | undefined;
  };
}

/**
 * Options for sending emails
 */
export interface SendOptions {
  /** CC recipients (comma-separated or array) */
  cc?: string | string[];
  
  /** BCC recipients (comma-separated or array) */
  bcc?: string | string[];
  
  /** HTML version of the email body */
  html?: string;
  
  /** File attachments */
  attachments?: Array<{
    /** Attachment filename */
    filename: string;
    
    /** File path or Buffer */
    content?: Buffer | string;
    
    /** File path */
    path?: string;
  }>;
}

/**
 * Options for replying to an existing message
 *
 * @remarks
 * Narrower than {@link SendOptions} on purpose. Recipients and subject are
 * derived from the message being answered, so accepting `cc`/`bcc`/`html`
 * here would advertise settings that reply() does not read.
 */
export interface ReplyOptions {
  /** File attachments */
  attachments?: SendOptions['attachments'];
}

/**
 * Options for continuing an existing conversation
 *
 * @remarks
 * Unlike {@link ReplyOptions}, recipients can be set: a message brought into
 * a thread may need to reach someone who was not on the original.
 */
export interface ThreadOptions {
  /** Recipients; defaults to the original sender */
  to?: string | string[];

  /** CC recipients */
  cc?: string | string[];

  /** BCC recipients */
  bcc?: string | string[];

  /** File attachments */
  attachments?: SendOptions['attachments'];
}

/**
 * The address a reply to this message should go to.
 *
 * @remarks
 * mailparser's ParsedMail shapes From and Reply-To as AddressObject, not as
 * arrays. The address lives at `.value[0].address` — not `[0].address`, which
 * is the bug this once had.
 */
function originalSender(originalMessage: any, verb: string): string {
  const address =
    originalMessage?.replyTo?.value?.[0]?.address ||
    originalMessage?.from?.value?.[0]?.address;

  if (!address) {
    throw new Error(
      `${verb}: could not determine recipient — original message has no From or Reply-To address`
    );
  }

  return address;
}

/**
 * SMTP client for sending emails via Proton Mail Bridge
 * 
 * @remarks
 * Uses nodemailer for SMTP operations. Bridge handles encryption
 * and routing to Proton servers.
 */
export class SMTPClient {
  private transporter: Transporter;
  private config: SMTPConfig;

  /**
   * Create a new SMTP client
   * 
   * @param config - SMTP connection settings
   */
  constructor(config: SMTPConfig) {
    this.config = config;
    this.transporter = nodemailer.createTransport(config);
  }

  /**
   * Send a new email
   * 
   * @param to - Recipient email address
   * @param subject - Email subject
   * @param body - Plain text email body
   * @param options - Additional options (CC, BCC, HTML, attachments)
   * @returns Send result with messageId
   * 
   * @throws {Error} If sending fails (invalid recipient, Bridge offline, etc.)
   * 
   * @example
   * ```typescript
   * const result = await smtp.send(
   *   'alice@example.com',
   *   'Project Update',
   *   'The project is on track...',
   *   {
   *     cc: 'bob@example.com',
   *     html: '<p>The project is <strong>on track</strong>...</p>'
   *   }
   * );
   * console.log('Sent:', result.messageId);
   * ```
   */
  async send(
    to: string,
    subject: string,
    body: string,
    options?: SendOptions
  ): Promise<any> {
    const mailOptions: SendMailOptions = {
      from: this.config.auth.user,
      to,
      subject,
      text: body,
      html: options?.html,
      cc: options?.cc,
      bcc: options?.bcc,
      attachments: options?.attachments
    };

    try {
      const result = await this.transporter.sendMail(mailOptions);
      return result;
    } catch (error) {
      throw new Error(`Failed to send email: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Reply to an existing email thread
   * 
   * @param originalMessage - Original email (from IMAP readMessage)
   * @param body - Reply text
   * @param options - Additional options (attachments)
   * @returns Send result
   * 
   * @throws {Error} If reply fails
   *
   * @remarks
   * This method automatically:
   * - Extracts the original sender from Reply-To or From header
   * - Prepends "Re: " to subject if not already present
   * - Sets In-Reply-To and References headers for proper threading
   *
   * @example
   * ```typescript
   * const original = await imap.readMessage('1234');
   * await smtp.reply(original, 'Thanks, I'll review this today.');
   * ```
   */
  async reply(originalMessage: any, body: string, options?: ReplyOptions): Promise<any> {
    const to = originalSender(originalMessage, 'reply');
    const { inReplyTo, references } = threadingHeaders(originalMessage);

    const mailOptions: SendMailOptions = {
      from: this.config.auth.user,
      to,
      subject: replySubject(originalMessage.subject),
      text: body,
      inReplyTo,
      references,
      attachments: options?.attachments,
    };

    return this.transporter.sendMail(mailOptions);
  }

  /**
   * Send a new message into an existing conversation
   *
   * @param originalMessage - A message from the conversation to continue
   * @param body - Message text
   * @param options - Recipients and attachments; recipients default to the
   *   original sender
   * @returns Send result
   *
   * @throws {Error} If no recipient can be determined
   *
   * @remarks
   * Distinct from {@link reply} in the two ways that decide where the message
   * lands. The subject is carried byte for byte rather than prefixed, because
   * Proton groups a conversation by subject plus participants and any drift
   * starts a new one in its UI. And the recipients can be set, so a message
   * can be brought to someone else without leaving the thread.
   *
   * @example
   * ```typescript
   * const original = await imap.readMessage('1234');
   * await smtp.continueThread(original, 'Adding Bob.', { to: 'bob@example.com' });
   * ```
   */
  async continueThread(
    originalMessage: any,
    body: string,
    options?: ThreadOptions
  ): Promise<any> {
    const to = options?.to ?? originalSender(originalMessage, 'thread');
    const { inReplyTo, references } = threadingHeaders(originalMessage);

    const mailOptions: SendMailOptions = {
      from: this.config.auth.user,
      to,
      cc: options?.cc,
      bcc: options?.bcc,
      subject: threadSubject(originalMessage.subject),
      text: body,
      inReplyTo,
      references,
      attachments: options?.attachments,
    };

    return this.transporter.sendMail(mailOptions);
  }
}
