/**
 * Tests for the pure query and formatting helpers in src/imap.ts.
 *
 * These are the pieces that changed shape when the client moved from `imap`
 * to ImapFlow: search criteria became an object rather than an array of
 * tuples, and the From column is rendered from the envelope rather than
 * parsed out of a raw header. The output shape is a compatibility promise, so
 * it is asserted here rather than left to the live checks.
 */

import { describe, it, expect } from 'bun:test';

import {
  parseSearchQuery,
  sanitizeSearchInput,
  sanitizeSearchValue,
  formatAddresses,
} from '../src/imap';

describe('parseSearchQuery()', () => {
  it('maps from: to the from criterion', () => {
    expect(parseSearchQuery('from:alice@example.com')).toEqual({
      from: 'alice@example.com',
    });
  });

  it('maps subject: and body: to their criteria', () => {
    expect(parseSearchQuery('subject:meeting')).toEqual({ subject: 'meeting' });
    expect(parseSearchQuery('body:invoice')).toEqual({ body: 'invoice' });
  });

  it('accepts a quoted value with spaces', () => {
    expect(parseSearchQuery('subject:"quarterly report"')).toEqual({
      subject: 'quarterly report',
    });
  });

  it('ANDs distinct filters into one criteria object', () => {
    expect(parseSearchQuery('from:alice@example.com subject:meeting')).toEqual({
      from: 'alice@example.com',
      subject: 'meeting',
    });
  });

  it('takes the last value when one filter is repeated', () => {
    // Requiring both would be a contradiction that can only return nothing.
    expect(parseSearchQuery('from:alice@example.com from:bob@example.com')).toEqual({
      from: 'bob@example.com',
    });
  });

  it('turns newer_than:7d into a since date roughly 7 days back', () => {
    const criteria = parseSearchQuery('newer_than:7d');
    const since = criteria.since as Date;

    expect(since).toBeInstanceOf(Date);
    const daysBack = (Date.now() - since.getTime()) / 86_400_000;
    expect(daysBack).toBeGreaterThan(6.9);
    expect(daysBack).toBeLessThan(7.1);
  });

  it('turns newer_than:12h into a since date roughly 12 hours back', () => {
    const since = parseSearchQuery('newer_than:12h').since as Date;
    const hoursBack = (Date.now() - since.getTime()) / 3_600_000;

    expect(hoursBack).toBeGreaterThan(11.9);
    expect(hoursBack).toBeLessThan(12.1);
  });

  it('combines a filter with a date window', () => {
    const criteria = parseSearchQuery('from:alice@example.com newer_than:1d');

    expect(criteria.from).toBe('alice@example.com');
    expect(criteria.since).toBeInstanceOf(Date);
  });

  it('falls back to a subject search for a bare keyword', () => {
    expect(parseSearchQuery('invoice')).toEqual({ subject: 'invoice' });
  });

  it('strips filter tokens before the fallback subject search', () => {
    // Regression: a stray U+0008 in this regex meant the tokens were never
    // stripped, so the fallback searched for the query verbatim.
    expect(parseSearchQuery('newer_than:999d invoice')).toEqual({ subject: 'invoice' });
  });

  it('rejects a query that reduces to nothing searchable', () => {
    expect(() => parseSearchQuery('newer_than:999d')).toThrow(
      'Search query is empty or contains unsupported characters'
    );
  });
});

describe('sanitizeSearchInput()', () => {
  it('requires a non-empty query', () => {
    expect(() => sanitizeSearchInput('   ')).toThrow('Search query is required');
  });

  it('rejects a query longer than 200 characters', () => {
    expect(() => sanitizeSearchInput('a'.repeat(201))).toThrow('too long');
  });

  it('rejects CR and LF, which would let a query inject an IMAP command', () => {
    expect(() => sanitizeSearchInput('alice\r\nA1 LOGOUT')).toThrow(
      'invalid control characters'
    );
  });

  it('rejects other control characters', () => {
    expect(() => sanitizeSearchInput('alice\x00bob')).toThrow('invalid control characters');
  });

  it('trims and returns an ordinary query', () => {
    expect(sanitizeSearchInput('  from:alice@example.com  ')).toBe('from:alice@example.com');
  });
});

describe('sanitizeSearchValue()', () => {
  it('accepts ordinary address and word characters', () => {
    expect(sanitizeSearchValue('alice+tag@example.com')).toBe('alice+tag@example.com');
  });

  it('returns empty for an empty value rather than throwing', () => {
    expect(sanitizeSearchValue('  ')).toBe('');
  });

  it('rejects characters outside the allowlist', () => {
    expect(() => sanitizeSearchValue('alice"; DROP')).toThrow('unsupported characters');
  });
});

describe('formatAddresses()', () => {
  it('renders an address with no display name in angle brackets', () => {
    expect(formatAddresses([{ address: 'alice@example.com' }])).toBe('<alice@example.com>');
  });

  it('renders a display name before the address', () => {
    expect(formatAddresses([{ name: 'Alice', address: 'alice@example.com' }])).toBe(
      'Alice <alice@example.com>'
    );
  });

  it('joins several addresses with a comma', () => {
    expect(
      formatAddresses([
        { name: 'Alice', address: 'alice@example.com' },
        { address: 'bob@example.com' },
      ])
    ).toBe('Alice <alice@example.com>, <bob@example.com>');
  });

  it('returns an empty string for a missing or empty list', () => {
    expect(formatAddresses(undefined)).toBe('');
    expect(formatAddresses([])).toBe('');
  });

  // The three ways this normalises rather than reproduces the raw header.
  // Asserted so the difference is recorded rather than assumed away — the
  // doc comment used to claim the output matched the old header passthrough.
  it('normalises a bare address into angle brackets', () => {
    // Raw header `From: alice@example.com` used to come through verbatim.
    expect(formatAddresses([{ address: 'alice@example.com' }])).toBe('<alice@example.com>');
  });

  it('drops the quotes around a display name that needed them', () => {
    // Raw header: `"Smith, Alice" <alice@example.com>`
    expect(formatAddresses([{ name: 'Smith, Alice', address: 'alice@example.com' }])).toBe(
      'Smith, Alice <alice@example.com>'
    );
  });

  it('lists every address where the old code showed only the first', () => {
    const rendered = formatAddresses([
      { address: 'alice@example.com' },
      { address: 'bob@example.com' },
      { address: 'carol@example.com' },
    ]);

    expect(rendered).toBe('<alice@example.com>, <bob@example.com>, <carol@example.com>');
  });

  it('renders an address with no address part without throwing', () => {
    expect(formatAddresses([{ name: 'Nameless' }])).toBe('Nameless <>');
  });
});
