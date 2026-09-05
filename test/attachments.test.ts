/**
 * Tests for the attachment helpers behind `--attach` and `--attachment`.
 *
 * These cover the paths the CLI takes before it opens a Bridge connection:
 * resolving files named on the command line, and selecting one attachment of
 * a parsed message by name.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  resolveAttachments,
  pickAttachment,
  AttachmentError,
} from '../src/attachments';

let tmpDir: string;
let filePath: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'protonmail-attach-'));
  filePath = path.join(tmpDir, 'report.pdf');
  fs.writeFileSync(filePath, 'pretend pdf bytes');
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('resolveAttachments()', () => {
  it('returns undefined when no paths were given', () => {
    expect(resolveAttachments([])).toBeUndefined();
  });

  it('resolves a relative path to an absolute one', () => {
    const relative = path.relative(process.cwd(), filePath);
    const [attachment] = resolveAttachments([relative])!;

    expect(path.isAbsolute(attachment.path)).toBe(true);
    expect(fs.realpathSync(attachment.path)).toBe(fs.realpathSync(filePath));
  });

  it('uses the file base name as the attachment filename', () => {
    const [attachment] = resolveAttachments([filePath])!;
    expect(attachment.filename).toBe('report.pdf');
  });

  it('resolves every path when several are given, in order', () => {
    const second = path.join(tmpDir, 'data.csv');
    fs.writeFileSync(second, 'a,b,c');

    const resolved = resolveAttachments([filePath, second])!;

    expect(resolved).toHaveLength(2);
    expect(resolved.map((a) => a.filename)).toEqual(['report.pdf', 'data.csv']);
  });

  it('throws AttachmentError naming the path that does not exist', () => {
    const missing = path.join(tmpDir, 'nope.pdf');

    expect(() => resolveAttachments([missing])).toThrow(AttachmentError);
    expect(() => resolveAttachments([missing])).toThrow(`attachment not found: ${missing}`);
  });

  it('throws when the path is a directory rather than a file', () => {
    expect(() => resolveAttachments([tmpDir])).toThrow('attachment is not a file');
  });

  it('rejects the whole batch when any one path is bad, before sending', () => {
    const missing = path.join(tmpDir, 'nope.pdf');
    expect(() => resolveAttachments([filePath, missing])).toThrow(AttachmentError);
  });
});

describe('pickAttachment()', () => {
  const list = [
    { filename: 'Invoice.PDF', content: Buffer.from('one') },
    { filename: 'notes.txt', content: Buffer.from('two') },
  ];

  it('selects by exact filename', () => {
    expect(pickAttachment(list, 'notes.txt').content.toString()).toBe('two');
  });

  it('falls back to a case-insensitive match', () => {
    expect(pickAttachment(list, 'invoice.pdf').content.toString()).toBe('one');
  });

  it('prefers the exact match over the case-insensitive one', () => {
    const both = [
      { filename: 'report.pdf', content: Buffer.from('lower') },
      { filename: 'REPORT.PDF', content: Buffer.from('upper') },
    ];
    expect(pickAttachment(both, 'REPORT.PDF').content.toString()).toBe('upper');
  });

  it('throws listing what is available when the name does not match', () => {
    expect(() => pickAttachment(list, 'missing.pdf')).toThrow(AttachmentError);
    expect(() => pickAttachment(list, 'missing.pdf')).toThrow(
      /no attachment named 'missing.pdf'[\s\S]*Available: Invoice.PDF, notes.txt/
    );
  });

  it('says so plainly when the message has no attachments at all', () => {
    expect(() => pickAttachment([], 'anything.pdf')).toThrow(
      /This message has no attachments\./
    );
  });
});
