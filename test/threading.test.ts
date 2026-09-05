/**
 * Tests for conversation threading.
 *
 * Two rules decide whether a message lands in an existing conversation: the
 * RFC 5322 headers, and — for Proton's own UI — a subject that has not
 * drifted. Both are asserted here.
 */

import { describe, it, expect } from 'bun:test';

import { threadingHeaders, replySubject, threadSubject } from '../src/threading';

describe('threadingHeaders()', () => {
  it('names the original message in In-Reply-To', () => {
    const { inReplyTo } = threadingHeaders({ messageId: '<a@example.com>' });
    expect(inReplyTo).toBe('<a@example.com>');
  });

  it('starts the chain with the original when there is no prior chain', () => {
    const { references } = threadingHeaders({ messageId: '<a@example.com>' });
    expect(references).toBe('<a@example.com>');
  });

  it('appends the original to an existing chain given as an array', () => {
    const { references } = threadingHeaders({
      messageId: '<c@example.com>',
      references: ['<a@example.com>', '<b@example.com>'],
    });
    expect(references).toBe('<a@example.com> <b@example.com> <c@example.com>');
  });

  it('appends to an existing chain given as a string', () => {
    const { references } = threadingHeaders({
      messageId: '<b@example.com>',
      references: '<a@example.com>',
    });
    expect(references).toBe('<a@example.com> <b@example.com>');
  });

  it('gives no headers at all when the original has no Message-ID', () => {
    // An In-Reply-To naming nothing is worse than none: it asserts a parent
    // that does not exist.
    expect(threadingHeaders({ subject: 'orphan' })).toEqual({
      inReplyTo: undefined,
      references: undefined,
    });
  });
});

describe('replySubject()', () => {
  it('adds the prefix', () => {
    expect(replySubject('Lunch')).toBe('Re: Lunch');
  });

  it('does not add it twice', () => {
    expect(replySubject('Re: Lunch')).toBe('Re: Lunch');
  });

  it('handles a missing subject', () => {
    expect(replySubject(undefined)).toBe('Re: ');
  });
});

describe('threadSubject()', () => {
  it('carries the subject byte for byte', () => {
    // Proton groups by subject plus participants, so any drift here starts a
    // new conversation in its UI even with correct headers.
    expect(threadSubject('Q3 planning')).toBe('Q3 planning');
  });

  it('does not add a Re: prefix', () => {
    expect(threadSubject('Q3 planning')).not.toContain('Re:');
  });

  it('leaves an existing Re: prefix exactly as it found it', () => {
    expect(threadSubject('Re: Q3 planning')).toBe('Re: Q3 planning');
  });

  it('preserves leading and trailing whitespace rather than tidying it', () => {
    expect(threadSubject('  spaced  ')).toBe('  spaced  ');
  });

  it('handles a missing subject', () => {
    expect(threadSubject(undefined)).toBe('');
  });
});
