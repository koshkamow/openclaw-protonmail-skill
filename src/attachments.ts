/**
 * Attachment helpers shared by the CLI and the library.
 *
 * These live in `src/` rather than inline in `bin/protonmail` so they can be
 * tested without standing up a Bridge connection: the CLI reaches its
 * attachment handling only after `initialize()` has already opened IMAP.
 *
 * @packageDocumentation
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * A file to attach, in the shape nodemailer accepts.
 *
 * @remarks
 * `path` is deliberately used over `content`: nodemailer streams the file at
 * send time rather than holding it in memory.
 */
export interface ResolvedAttachment {
  /** Base name of the file, used as the attachment's filename */
  filename: string;

  /** Absolute path on disk; nodemailer streams from here */
  path: string;
}

/**
 * Anything with a filename — the parts of mailparser's Attachment this module
 * needs in order to select one by name.
 */
export interface NamedAttachment {
  filename?: string;
}

/**
 * Raised when an attachment path does not resolve to a readable file.
 *
 * @remarks
 * Thrown rather than exiting so the CLI owns its exit codes and tests can
 * assert on the failure.
 */
export class AttachmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AttachmentError';
  }
}

/**
 * Turn `--attach=<path>` values into nodemailer attachment objects.
 *
 * @param paths - File paths as given on the command line
 * @returns One attachment per path, or `undefined` when none were given
 *
 * @throws {AttachmentError} If a path is missing or is not a regular file
 *
 * @remarks
 * Every path is checked up front, so a typo fails before any mail is sent
 * rather than producing a half-formed message.
 *
 * @example
 * ```typescript
 * resolveAttachments(['./report.pdf']);
 * // [{ filename: 'report.pdf', path: '/abs/path/report.pdf' }]
 * ```
 */
export function resolveAttachments(paths: string[]): ResolvedAttachment[] | undefined {
  if (paths.length === 0) return undefined;

  return paths.map((p) => {
    const resolved = path.resolve(p);

    let stat: fs.Stats;
    try {
      stat = fs.statSync(resolved);
    } catch {
      throw new AttachmentError(`attachment not found: ${p}`);
    }

    if (!stat.isFile()) {
      throw new AttachmentError(`attachment is not a file: ${p}`);
    }

    return { filename: path.basename(resolved), path: resolved };
  });
}

/**
 * Select one attachment of a parsed message by filename.
 *
 * @param list - Attachments from the parsed message
 * @param wanted - Filename asked for on the command line
 * @returns The matching attachment
 *
 * @throws {AttachmentError} If nothing matches, listing what is available
 *
 * @remarks
 * An exact match wins; a case-insensitive match is the fallback, since a
 * filename retyped from a mail client often differs only in case.
 */
export function pickAttachment<T extends NamedAttachment>(list: T[], wanted: string): T {
  const hit =
    list.find((a) => a.filename === wanted) ||
    list.find((a) => (a.filename || '').toLowerCase() === wanted.toLowerCase());

  if (!hit) {
    const available = list.length
      ? `Available: ${list.map((a) => a.filename).join(', ')}`
      : 'This message has no attachments.';
    throw new AttachmentError(`no attachment named '${wanted}'\n${available}`);
  }

  return hit;
}
