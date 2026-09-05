/**
 * Tests for the CLI's argument handling.
 *
 * These could not exist while the command lived in `bin/protonmail`: that file
 * has no extension, so it was neither typechecked nor importable as a module,
 * and every path through it needed a live Bridge connection first. With the
 * body in `src/cli.ts` the parsing is reachable on its own.
 */

import { describe, expect, it } from 'bun:test';
import type { AddressObject } from 'mailparser';

import {
  addressText,
  COMMANDS,
  getArg,
  getArgs,
  isKindFilter,
  KIND_FILTERS,
  mailboxArg,
  mailboxKind,
  messageOf,
  requireUid,
  UsageError,
} from '../src/cli';

function address(text: string): AddressObject {
  return { value: [{ address: text, name: '' }], text, html: text };
}

describe('getArg()', () => {
  it('reads the value of a --name=value flag', () => {
    expect(getArg(['send', '--to=bob@example.com'], 'to')).toBe('bob@example.com');
  });

  it('returns null when the flag is absent', () => {
    expect(getArg(['send'], 'to')).toBeNull();
  });

  it('keeps an = inside the value', () => {
    expect(getArg(['search', '--body=a=b'], 'body')).toBe('a=b');
  });

  it('returns the empty string for a flag given with no value', () => {
    expect(getArg(['send', '--cc='], 'cc')).toBe('');
  });

  it('takes the first occurrence when a flag is repeated', () => {
    expect(getArg(['send', '--to=a@x', '--to=b@x'], 'to')).toBe('a@x');
  });

  it('does not match a flag whose name is a prefix of another', () => {
    expect(getArg(['read', '--attachment=report.pdf'], 'attach')).toBeNull();
  });
});

describe('getArgs()', () => {
  it('collects every occurrence in order', () => {
    const args = ['send', '--attach=/a.pdf', '--body=hi', '--attach=/b.csv'];
    expect(getArgs(args, 'attach')).toEqual(['/a.pdf', '/b.csv']);
  });

  it('returns an empty array when the flag is absent', () => {
    expect(getArgs(['send'], 'attach')).toEqual([]);
  });

  it('drops an occurrence given with no value', () => {
    expect(getArgs(['send', '--attach=', '--attach=/a.pdf'], 'attach')).toEqual(['/a.pdf']);
  });
});

describe('requireUid()', () => {
  it('returns the first positional argument when it is digits', () => {
    expect(requireUid(['star', '1962'], 'star')).toBe('1962');
  });

  it('throws UsageError naming the command when the uid is missing', () => {
    expect(() => requireUid(['star'], 'star')).toThrow(UsageError);
    expect(() => requireUid(['star'], 'star')).toThrow('star requires a numeric message UID');
  });

  it('throws when the uid is not a number', () => {
    expect(() => requireUid(['star', 'latest'], 'star')).toThrow(UsageError);
  });

  it('throws rather than accepting a flag in the uid position', () => {
    expect(() => requireUid(['star', '--mailbox=Sent'], 'star')).toThrow(UsageError);
  });
});

describe('mailboxArg()', () => {
  it('defaults to INBOX', () => {
    expect(mailboxArg(['list-inbox'])).toBe('INBOX');
  });

  it('reads --mailbox when given', () => {
    expect(mailboxArg(['list-inbox', '--mailbox=Sent'])).toBe('Sent');
  });

  it('falls back to INBOX for an empty --mailbox=', () => {
    expect(mailboxArg(['list-inbox', '--mailbox='])).toBe('INBOX');
  });
});

describe('mailboxKind()', () => {
  it('is a folder by default', () => {
    expect(mailboxKind(['create-folder', 'Receipts'])).toBe('folder');
  });

  it('is a label when --label is present', () => {
    expect(mailboxKind(['create-folder', 'Urgent', '--label'])).toBe('label');
  });
});

describe('isKindFilter()', () => {
  it('accepts every documented --kind value', () => {
    for (const kind of KIND_FILTERS) {
      expect(isKindFilter(kind)).toBe(true);
    }
  });

  it('rejects anything else', () => {
    expect(isKindFilter('folders')).toBe(false);
    expect(isKindFilter('')).toBe(false);
  });
});

describe('addressText()', () => {
  it('renders a single address header', () => {
    expect(addressText(address('Alice <alice@example.com>'))).toBe('Alice <alice@example.com>');
  });

  it('joins the array form mailparser uses for a grouped header', () => {
    expect(addressText([address('a@x'), address('b@x')])).toBe('a@x, b@x');
  });

  it('is undefined when the header is absent', () => {
    expect(addressText(undefined)).toBeUndefined();
  });
});

describe('messageOf()', () => {
  it('takes the message of an Error', () => {
    expect(messageOf(new Error('bridge is down'))).toBe('bridge is down');
  });

  it('takes the message of a subclass', () => {
    expect(messageOf(new UsageError('search requires a query'))).toBe('search requires a query');
  });

  it('stringifies a thrown value that is not an Error', () => {
    expect(messageOf('plain string')).toBe('plain string');
    expect(messageOf(undefined)).toBe('undefined');
  });
});

describe('COMMANDS', () => {
  it('documents every verb the CLI dispatches', () => {
    const verbs = [
      'list-inbox',
      'search',
      'read',
      'send',
      'reply',
      'list-folders',
      'create-folder',
      'delete-folder',
      'thread',
      'mark-read',
      'mark-unread',
      'star',
      'unstar',
      'move',
      'delete',
    ];

    for (const verb of verbs) {
      expect(COMMANDS).toContain(`  ${verb} `);
    }
  });
});
