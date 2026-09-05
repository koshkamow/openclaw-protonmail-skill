/**
 * Tests for the Folders/Labels tree rules.
 *
 * The guards here are the ones standing between a typo and a deleted
 * mailbox, so they are asserted directly rather than left to the live checks.
 */

import { describe, it, expect } from 'bun:test';

import {
  classifyMailbox,
  resolveMailboxPath,
  assertDeletable,
  MailboxError,
  FOLDERS_ROOT,
  LABELS_ROOT,
} from '../src/mailboxes';

describe('classifyMailbox()', () => {
  it('calls the tree roots containers', () => {
    expect(classifyMailbox(FOLDERS_ROOT, ['\\Noselect', '\\Unmarked'])).toBe('container');
    expect(classifyMailbox(LABELS_ROOT, ['\\Noselect', '\\Unmarked'])).toBe('container');
  });

  it('calls anything below Folders a folder', () => {
    expect(classifyMailbox('Folders/Receipts')).toBe('folder');
    expect(classifyMailbox('Folders/2026/Q1')).toBe('folder');
  });

  it('calls anything below Labels a label', () => {
    expect(classifyMailbox('Labels/Urgent')).toBe('label');
  });

  it('calls the Proton-provided mailboxes system', () => {
    expect(classifyMailbox('INBOX', ['\\Marked', '\\Noinferiors'])).toBe('system');
    expect(classifyMailbox('All Mail', ['\\All'])).toBe('system');
    expect(classifyMailbox('Starred', ['\\Flagged'])).toBe('system');
  });

  it('treats any \\Noselect mailbox as a container', () => {
    expect(classifyMailbox('Folders/Parent', ['\\Noselect'])).toBe('container');
  });
});

describe('resolveMailboxPath()', () => {
  it('places a bare name under the requested tree', () => {
    expect(resolveMailboxPath('Receipts', 'folder')).toBe('Folders/Receipts');
    expect(resolveMailboxPath('Urgent', 'label')).toBe('Labels/Urgent');
  });

  it('accepts a full path that already names its tree', () => {
    expect(resolveMailboxPath('Folders/Receipts', 'folder')).toBe('Folders/Receipts');
    expect(resolveMailboxPath('Labels/Urgent', 'label')).toBe('Labels/Urgent');
  });

  it('keeps nesting intact', () => {
    expect(resolveMailboxPath('2026/Q1', 'folder')).toBe('Folders/2026/Q1');
    expect(resolveMailboxPath('Folders/2026/Q1', 'folder')).toBe('Folders/2026/Q1');
  });

  it('trims surrounding whitespace', () => {
    expect(resolveMailboxPath('  Receipts  ', 'folder')).toBe('Folders/Receipts');
  });

  it('refuses a path naming the other tree', () => {
    // Silently creating a label here is exactly the guess this avoids.
    expect(() => resolveMailboxPath('Labels/Urgent', 'folder')).toThrow(MailboxError);
    expect(() => resolveMailboxPath('Labels/Urgent', 'folder')).toThrow('was told folder');
    expect(() => resolveMailboxPath('Folders/Receipts', 'label')).toThrow('was told label');
  });

  it('refuses the tree roots themselves', () => {
    expect(() => resolveMailboxPath('Folders', 'folder')).toThrow('is the tree itself');
    expect(() => resolveMailboxPath('Labels', 'label')).toThrow('is the tree itself');
  });

  it('requires a name', () => {
    expect(() => resolveMailboxPath('', 'folder')).toThrow('mailbox name is required');
    expect(() => resolveMailboxPath('   ', 'folder')).toThrow('mailbox name is required');
  });

  it('rejects IMAP wildcards and quotes, which the server would interpret', () => {
    expect(() => resolveMailboxPath('Rec*', 'folder')).toThrow('invalid characters');
    expect(() => resolveMailboxPath('Rec%', 'folder')).toThrow('invalid characters');
    expect(() => resolveMailboxPath('Rec"pts', 'folder')).toThrow('invalid characters');
  });

  it('rejects control characters, which could inject a command', () => {
    expect(() => resolveMailboxPath('Rec\r\nA1 LOGOUT', 'folder')).toThrow(
      'invalid characters'
    );
  });

  it('refuses a bare system mailbox name rather than prefixing it', () => {
    // Regression: these used to resolve to Folders/INBOX — a mailbox that does
    // not exist — so `delete-folder INBOX` reported "not found" and the guard
    // against deleting system mailboxes was unreachable from the CLI.
    for (const box of ['INBOX', 'Sent', 'Drafts', 'Archive', 'Spam', 'Trash', 'All Mail', 'Starred']) {
      expect(() => resolveMailboxPath(box, 'folder')).toThrow('system mailbox');
      expect(() => resolveMailboxPath(box, 'label')).toThrow('system mailbox');
    }
  });

  it('refuses a bare system mailbox name whatever its case', () => {
    expect(() => resolveMailboxPath('inbox', 'folder')).toThrow('system mailbox');
  });

  it('still allows a user mailbox that merely resembles a system one', () => {
    expect(resolveMailboxPath('Archived', 'folder')).toBe('Folders/Archived');
    expect(resolveMailboxPath('Folders/Trash', 'folder')).toBe('Folders/Trash');
  });

  it('rejects empty path segments', () => {
    expect(() => resolveMailboxPath('/Receipts', 'folder')).toThrow('empty path segment');
    expect(() => resolveMailboxPath('Receipts/', 'folder')).toThrow('empty path segment');
    expect(() => resolveMailboxPath('a//b', 'folder')).toThrow('empty path segment');
  });
});

describe('assertDeletable()', () => {
  it('allows a user folder or label', () => {
    expect(() => assertDeletable('Folders/Receipts')).not.toThrow();
    expect(() => assertDeletable('Labels/Urgent')).not.toThrow();
  });

  it('refuses the tree roots, which hold every user mailbox', () => {
    expect(() => assertDeletable('Folders')).toThrow('every user folder');
    expect(() => assertDeletable('Labels')).toThrow('every user label');
  });

  it('refuses each Proton system mailbox', () => {
    for (const box of ['INBOX', 'Sent', 'Drafts', 'Archive', 'Spam', 'Trash', 'All Mail', 'Starred']) {
      expect(() => assertDeletable(box)).toThrow('system mailbox');
    }
  });

  it('refuses a system mailbox whatever its case', () => {
    expect(() => assertDeletable('inbox')).toThrow('system mailbox');
    expect(() => assertDeletable('TrAsH')).toThrow('system mailbox');
  });
});
