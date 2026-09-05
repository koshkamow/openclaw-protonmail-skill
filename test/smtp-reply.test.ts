/**
 * Tests for SMTPClient.reply() — verifies correct mailparser AddressObject
 * shape handling and threading header construction.
 *
 * Regression coverage for:
 *   https://github.com/rvacyber/openclaw-protonmail-skill/issues/3
 *
 * Root cause: reply() was accessing `from?.[0]?.address` but mailparser's
 * ParsedMail exposes From as AddressObject ({ value: EmailAddress[] }),
 * not as EmailAddress[]. The correct path is `from?.value?.[0]?.address`.
 */

import { beforeEach, describe, expect, it, mock } from 'bun:test';
import type { AddressObject, EmailAddress, ParsedMail } from 'mailparser';
import type { SendMailOptions } from 'nodemailer';

// ---------------------------------------------------------------------------
// Minimal nodemailer transporter mock — captures sendMail calls.
//
// mock.module() must run before the module under test is loaded, and static
// imports are hoisted above it — hence the dynamic import below.
// ---------------------------------------------------------------------------
// The parameter is declared so the recorded calls are typed: without it the
// mock's call tuple is empty and mock.calls[0][0] does not typecheck.
const mockSendMail = mock(async (_options: SendMailOptions) => ({
  messageId: '<sent@test>',
}));

const transport = { createTransport: mock(() => ({ sendMail: mockSendMail })) };
mock.module('nodemailer', () => ({ default: transport, ...transport }));

const { SMTPClient } = await import('../src/smtp');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
// SMTPClient arrives through a dynamic import, so the binding is a value and
// the instance type is reached through it rather than by name.
function makeSmtp(): InstanceType<typeof SMTPClient> {
  return new SMTPClient({
    host: '127.0.0.1',
    port: 1025,
    secure: false,
    auth: { user: 'bucky@pm.me', pass: 'bridge-pw' },
  });
}

/** An address header in mailparser's shape: the list, plus its two renderings */
function addresses(...value: EmailAddress[]): AddressObject {
  const text = value.map((a) => (a.name ? `${a.name} <${a.address}>` : `${a.address}`)).join(', ');
  return { value, text, html: text };
}

/**
 * Build a ParsedMail, overriding whichever fields a test cares about.
 *
 * @remarks
 * Typed as the real ParsedMail rather than a loose object, so the four fields
 * mailparser always sets — attachments, headers, headerLines, html — are here
 * whether or not a test reads them, and an override that does not fit the
 * library's shape fails to compile instead of at the assertion.
 */
function parsedMail(overrides: Partial<ParsedMail> = {}): ParsedMail {
  return {
    attachments: [],
    headers: new Map(),
    headerLines: [],
    html: false,
    from: addresses({ address: 'alice@example.com', name: 'Alice' }),
    replyTo: undefined,
    subject: 'Original subject',
    messageId: '<original-msg-id@example.com>',
    references: undefined,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('SMTPClient.reply()', () => {
  beforeEach(() => {
    mockSendMail.mockClear();
    transport.createTransport.mockClear();
  });

  it('extracts recipient from from.value[0].address (mailparser shape)', async () => {
    const smtp = makeSmtp();
    const original = parsedMail();

    await smtp.reply(original, 'Hello back');

    const sent = mockSendMail.mock.calls[0][0];
    expect(sent.to).toBe('alice@example.com');
  });

  it('prefers replyTo.value[0].address over from when present', async () => {
    const smtp = makeSmtp();
    const original = parsedMail({
      replyTo: addresses({ address: 'noreply@lists.example.com', name: '' }),
    });

    await smtp.reply(original, 'Hello back');

    const sent = mockSendMail.mock.calls[0][0];
    expect(sent.to).toBe('noreply@lists.example.com');
  });

  it('prepends "Re: " to subject when not already present', async () => {
    const smtp = makeSmtp();
    await smtp.reply(parsedMail(), 'Hello back');
    expect(mockSendMail.mock.calls[0][0].subject).toBe('Re: Original subject');
  });

  it('does not double-prefix "Re: " when already present', async () => {
    const smtp = makeSmtp();
    await smtp.reply(parsedMail({ subject: 'Re: Already prefixed' }), 'Hi');
    expect(mockSendMail.mock.calls[0][0].subject).toBe('Re: Already prefixed');
  });

  it('sets inReplyTo to original messageId', async () => {
    const smtp = makeSmtp();
    await smtp.reply(parsedMail(), 'Hi');
    expect(mockSendMail.mock.calls[0][0].inReplyTo).toBe('<original-msg-id@example.com>');
  });

  it('builds references string from existing refs + original messageId', async () => {
    const smtp = makeSmtp();
    const original = parsedMail({
      references: ['<first@example.com>', '<second@example.com>'],
    });

    await smtp.reply(original, 'Hi');

    const sent = mockSendMail.mock.calls[0][0];
    expect(sent.references).toBe(
      '<first@example.com> <second@example.com> <original-msg-id@example.com>',
    );
  });

  it('builds references string when references is a string (not array)', async () => {
    const smtp = makeSmtp();
    const original = parsedMail({
      references: '<first@example.com>',
    });

    await smtp.reply(original, 'Hi');

    const sent = mockSendMail.mock.calls[0][0];
    expect(sent.references).toBe('<first@example.com> <original-msg-id@example.com>');
  });

  it('uses only messageId as references when no prior chain', async () => {
    const smtp = makeSmtp();
    await smtp.reply(parsedMail(), 'Hi');
    expect(mockSendMail.mock.calls[0][0].references).toBe('<original-msg-id@example.com>');
  });

  it('passes attachments through to nodemailer', async () => {
    const smtp = makeSmtp();
    const attachments = [{ filename: 'report.pdf', path: '/tmp/report.pdf' }];

    await smtp.reply(parsedMail(), 'Attached.', { attachments });

    expect(mockSendMail.mock.calls[0][0].attachments).toEqual(attachments);
  });

  it('leaves attachments undefined when no options are given', async () => {
    const smtp = makeSmtp();
    await smtp.reply(parsedMail(), 'Hi');
    expect(mockSendMail.mock.calls[0][0].attachments).toBeUndefined();
  });

  it('keeps threading headers intact when replying with an attachment', async () => {
    const smtp = makeSmtp();
    await smtp.reply(parsedMail(), 'Attached.', {
      attachments: [{ filename: 'report.pdf', path: '/tmp/report.pdf' }],
    });

    const sent = mockSendMail.mock.calls[0][0];
    expect(sent.inReplyTo).toBe('<original-msg-id@example.com>');
    expect(sent.references).toBe('<original-msg-id@example.com>');
    expect(sent.subject).toBe('Re: Original subject');
  });

  it('throws when no From or Reply-To address is available', async () => {
    const smtp = makeSmtp();
    const broken = parsedMail({ from: addresses(), replyTo: undefined });

    await expect(smtp.reply(broken, 'Hi')).rejects.toThrow('could not determine recipient');
  });

  it('sends no threading headers when the original has no Message-ID', async () => {
    const smtp = makeSmtp();
    await smtp.reply(parsedMail({ messageId: undefined }), 'Hi');

    const sent = mockSendMail.mock.calls[0][0];
    expect(sent.inReplyTo).toBeUndefined();
    expect(sent.references).toBeUndefined();
  });

  it('does not call sendMail when recipient extraction fails', async () => {
    const smtp = makeSmtp();
    const broken = parsedMail({ from: undefined, replyTo: undefined });

    await expect(smtp.reply(broken, 'Hi')).rejects.toThrow();
    expect(mockSendMail).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// continueThread() — a new message into an existing conversation
// ---------------------------------------------------------------------------
describe('SMTPClient.continueThread()', () => {
  beforeEach(() => {
    mockSendMail.mockClear();
    transport.createTransport.mockClear();
  });

  it('carries the subject byte for byte, with no Re: prefix', async () => {
    const smtp = makeSmtp();
    await smtp.continueThread(parsedMail(), 'Still on this.');

    expect(mockSendMail.mock.calls[0][0].subject).toBe('Original subject');
  });

  it('leaves an existing Re: subject exactly as it found it', async () => {
    const smtp = makeSmtp();
    await smtp.continueThread(parsedMail({ subject: 'Re: Original subject' }), 'More.');

    expect(mockSendMail.mock.calls[0][0].subject).toBe('Re: Original subject');
  });

  it('sets the threading headers from the original', async () => {
    const smtp = makeSmtp();
    await smtp.continueThread(parsedMail({ references: ['<first@example.com>'] }), 'More.');

    const sent = mockSendMail.mock.calls[0][0];
    expect(sent.inReplyTo).toBe('<original-msg-id@example.com>');
    expect(sent.references).toBe('<first@example.com> <original-msg-id@example.com>');
  });

  it('defaults the recipient to the original sender', async () => {
    const smtp = makeSmtp();
    await smtp.continueThread(parsedMail(), 'More.');

    expect(mockSendMail.mock.calls[0][0].to).toBe('alice@example.com');
  });

  it('sends to an explicit recipient instead, without leaving the thread', async () => {
    const smtp = makeSmtp();
    await smtp.continueThread(parsedMail(), 'Adding Bob.', { to: 'bob@example.com' });

    const sent = mockSendMail.mock.calls[0][0];
    expect(sent.to).toBe('bob@example.com');
    expect(sent.subject).toBe('Original subject');
    expect(sent.inReplyTo).toBe('<original-msg-id@example.com>');
  });

  it('passes cc, bcc and attachments through', async () => {
    const smtp = makeSmtp();
    const attachments = [{ filename: 'report.pdf', path: '/tmp/report.pdf' }];

    await smtp.continueThread(parsedMail(), 'With a file.', {
      cc: 'carol@example.com',
      bcc: 'dan@example.com',
      attachments,
    });

    const sent = mockSendMail.mock.calls[0][0];
    expect(sent.cc).toBe('carol@example.com');
    expect(sent.bcc).toBe('dan@example.com');
    expect(sent.attachments).toEqual(attachments);
  });

  it('throws when no recipient can be determined and none was given', async () => {
    const smtp = makeSmtp();
    await expect(smtp.continueThread(parsedMail({ from: undefined }), 'Hi')).rejects.toThrow(
      'thread: could not determine recipient',
    );
  });

  it('still sends when the original has no sender but a recipient was given', async () => {
    const smtp = makeSmtp();
    await smtp.continueThread(parsedMail({ from: undefined }), 'Hi', {
      to: 'bob@example.com',
    });

    expect(mockSendMail.mock.calls[0][0].to).toBe('bob@example.com');
  });
});
