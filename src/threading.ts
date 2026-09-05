/**
 * Conversation threading.
 *
 * @packageDocumentation
 *
 * @remarks
 * Two things have to agree for a message to land in an existing conversation.
 *
 * The headers are the standard part: `In-Reply-To` names the message being
 * answered and `References` carries the chain, per RFC 5322. Every
 * standards-respecting client threads on those.
 *
 * Proton's UI additionally groups by **subject plus participants**. So a
 * subject that drifts — even by a `Re: ` that was not there before — starts a
 * new conversation in Proton's own interface while the headers still say
 * otherwise. `threadSubject()` therefore returns the original subject byte for
 * byte, and it is `replySubject()` that adds the prefix.
 */

/** The threading headers to put on an outgoing message */
export interface ThreadingHeaders {
  /** Message-ID of the message being answered */
  inReplyTo: string | undefined;

  /** Space-separated chain, per RFC 5322 */
  references: string | undefined;
}

/**
 * Anything with the fields threading reads — the parts of mailparser's
 * ParsedMail this module needs.
 */
export interface ThreadableMessage {
  subject?: string;
  messageId?: string;
  references?: string | string[];
}

/**
 * Build `In-Reply-To` and `References` for a message answering this one.
 *
 * @param original - The message being answered
 * @returns Headers to place on the outgoing message
 *
 * @remarks
 * mailparser reports `references` as a string or an array depending on how
 * many there were; both are normalised to the space-separated string RFC 5322
 * calls for. The original's own Message-ID is appended, which is what extends
 * the chain rather than restating it.
 *
 * A message with no Message-ID yields undefined for both, rather than headers
 * naming nothing — an empty `In-Reply-To` is worse than none.
 */
export function threadingHeaders(original: ThreadableMessage): ThreadingHeaders {
  const messageId = original.messageId;

  if (!messageId) {
    return { inReplyTo: undefined, references: undefined };
  }

  const existing = Array.isArray(original.references)
    ? original.references.join(' ')
    : (original.references ?? '');

  return {
    inReplyTo: messageId,
    references: existing ? `${existing} ${messageId}` : messageId,
  };
}

/**
 * Subject for a reply: `Re: ` once, never twice.
 *
 * @param subject - The original subject
 *
 * @example
 * ```typescript
 * replySubject('Lunch');     // 'Re: Lunch'
 * replySubject('Re: Lunch'); // 'Re: Lunch'
 * ```
 */
export function replySubject(subject?: string): string {
  const original = subject ?? '';
  return original.startsWith('Re: ') ? original : `Re: ${original}`;
}

/**
 * Subject for a new message continuing a conversation: unchanged.
 *
 * @param subject - The original subject
 *
 * @remarks
 * Byte-identical on purpose. Proton groups a conversation by subject plus
 * participants, so adding or trimming anything here splits the thread in its
 * UI even when `In-Reply-To` and `References` are correct.
 */
export function threadSubject(subject?: string): string {
  return subject ?? '';
}
