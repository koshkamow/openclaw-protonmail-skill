/**
 * The `protonmail` command line.
 *
 * @packageDocumentation
 *
 * @remarks
 * The body of the CLI lives here rather than in `bin/protonmail` because
 * `bin/protonmail` has no file extension: tsc and Biome both key off `.ts`, so
 * nothing in that file is typechecked, linted or formatted. Under `src/` it is
 * all three, and the argument helpers below are unit-tested.
 *
 * `run()` returns an exit code rather than calling `process.exit()`, which is
 * what lets a test call it and what lets every path close the Bridge
 * connection on the way out. `bin/protonmail` is the two lines that turn that
 * code into the process's own.
 */

import type { AddressObject, Attachment } from 'mailparser';

import type { ResolvedAttachment } from './attachments';
import { pickAttachment, resolveAttachments } from './attachments';
import ProtonMailSkill from './index';
import type { MailboxInfo, MailboxKind } from './mailboxes';

/** The command list, printed on no command and on an unknown one */
export const COMMANDS: string = [
  'Commands:',
  '  list-inbox [--limit=N] [--unread] [--mailbox=<path>]',
  '  search <query> [--limit=N] [--mailbox=<path>]',
  '  read <uid> [--attachment=<filename>] [--mailbox=<path>]',
  '  send --to= --subject= --body= [--cc=] [--bcc=] [--attach=<path> ...]',
  '  reply <uid> --body= [--attach=<path> ...] [--mailbox=<path>]',
  '  list-folders [--kind=folder|label|system|container|all]',
  '  create-folder <name> [--label]',
  '  delete-folder <name> [--label]',
  '  thread <uid> --body= [--to=] [--cc=] [--bcc=] [--attach=<path> ...]',
  '  mark-read <uid> [--mailbox=<path>]',
  '  mark-unread <uid> [--mailbox=<path>]',
  '  star <uid> [--mailbox=<path>]',
  '  unstar <uid> [--mailbox=<path>]',
  '  move <uid> <mailbox> [--mailbox=<source>]',
  '  delete <uid> [--permanent] [--mailbox=<path>]',
].join('\n');

/** What `list-folders --kind=` accepts: a mailbox kind, or every kind */
export const KIND_FILTERS = ['all', 'folder', 'label', 'system', 'container'] as const;

/** One accepted value of `--kind` */
export type KindFilter = (typeof KIND_FILTERS)[number];

/**
 * Raised when the command line itself is wrong.
 *
 * @remarks
 * Distinct from an error the Bridge reports: this one is the caller's typo, and
 * it is printed as a message rather than a stack.
 */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

/**
 * The message of a thrown value.
 *
 * @param error - Whatever `catch` bound, which the language types as `unknown`
 *
 * @remarks
 * A `catch` clause is one of the few places a genuine `unknown` is correct:
 * any value can be thrown, so the type cannot be narrower than that. This is
 * the boundary where it is narrowed, once, for everything downstream.
 */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The value of a `--name=value` flag.
 *
 * @returns The value, or null when the flag is absent
 */
export function getArg(args: string[], name: string): string | null {
  const prefix = `--${name}=`;
  const arg = args.find((a) => a.startsWith(prefix));
  return arg ? arg.substring(prefix.length) : null;
}

/**
 * Every value of a flag that may be repeated, such as `--attach=`.
 *
 * @returns The values in the order given, empty values dropped
 */
export function getArgs(args: string[], name: string): string[] {
  const prefix = `--${name}=`;
  return args
    .filter((a) => a.startsWith(prefix))
    .map((a) => a.substring(prefix.length))
    .filter(Boolean);
}

/**
 * The value of an optional `--name=value` flag, absent when it is empty.
 *
 * @returns The value, or undefined when the flag is missing **or blank**
 *
 * @remarks
 * `--to=` with nothing after it means the flag was not really given, and the
 * commands that read these flags document a fallback for an absent one —
 * `thread` sends to the original sender. Forwarding `''` instead would skip
 * that fallback and fail at nodemailer, so an empty value is treated as
 * absence here rather than at each call site.
 */
export function optionalArg(args: string[], name: string): string | undefined {
  return getArg(args, name) || undefined;
}

/**
 * The UID a message command acts on.
 *
 * @throws {UsageError} If the first positional argument is missing or is not
 *   a run of digits
 */
export function requireUid(args: string[], command: string): string {
  const uid = args[1];
  if (!uid || !/^\d+$/.test(uid)) {
    throw new UsageError(`${command} requires a numeric message UID`);
  }
  return uid;
}

/**
 * Which mailbox a command acts on.
 *
 * @remarks
 * A bare name is resolved against the mailboxes that exist, so
 * `--mailbox=Receipts` finds `Folders/Receipts`.
 */
export function mailboxArg(args: string[]): string {
  return getArg(args, 'mailbox') || 'INBOX';
}

/**
 * Which tree a folder command means.
 *
 * @remarks
 * Proton keeps folders and labels in separate trees and they behave
 * differently, so the command says which it means rather than guessing.
 */
export function mailboxKind(args: string[]): Extract<MailboxKind, 'folder' | 'label'> {
  return args.includes('--label') ? 'label' : 'folder';
}

/** Whether a `--kind` value is one this command accepts */
export function isKindFilter(value: string): value is KindFilter {
  return (KIND_FILTERS as readonly string[]).includes(value);
}

/**
 * Render an address header for display.
 *
 * @remarks
 * mailparser reports `To` and `Cc` as one AddressObject or an array of them,
 * depending on the header. Reading `.text` off the array yielded undefined,
 * which is what this had been printing for a grouped recipient list.
 */
export function addressText(
  field: AddressObject | AddressObject[] | undefined,
): string | undefined {
  if (!field) return undefined;
  return Array.isArray(field) ? field.map((a) => a.text).join(', ') : field.text;
}

/** One attachment as the `read` command summarises it */
interface AttachmentSummary {
  filename: string | undefined;
  contentType: string;
  size: number;
}

function summariseAttachments(attachments: Attachment[]): AttachmentSummary[] {
  return attachments.map((a) => ({
    filename: a.filename,
    contentType: a.contentType,
    size: a.size,
  }));
}

/** Print a result as the indented JSON every command answers in */
function emit(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

/**
 * Run one command against an initialised skill.
 *
 * @returns The process exit code
 *
 * @throws {UsageError} If the command line is wrong
 */
async function dispatch(
  skill: ProtonMailSkill,
  command: string,
  args: string[],
  attachments: ResolvedAttachment[] | undefined,
): Promise<number> {
  switch (command) {
    case 'list-inbox': {
      const limit = Number.parseInt(getArg(args, 'limit') || '10', 10);
      const unreadOnly = args.includes('--unread');
      emit(await skill.listInbox(limit, unreadOnly, mailboxArg(args)));
      return 0;
    }

    case 'search': {
      const query = args[1];
      if (!query) {
        throw new UsageError('search requires a query');
      }
      const limit = Number.parseInt(getArg(args, 'limit') || '10', 10);
      emit(await skill.searchEmails(query, limit, mailboxArg(args)));
      return 0;
    }

    case 'read': {
      const messageId = args[1];
      if (!messageId) {
        throw new UsageError('read requires a message ID');
      }
      const email = await skill.readEmail(messageId, mailboxArg(args));

      const wanted = getArg(args, 'attachment');
      if (wanted) {
        // Raw bytes on stdout, so the caller redirects them to a file.
        const hit = pickAttachment(email.attachments, wanted);
        process.stdout.write(hit.content);
        return 0;
      }

      emit({
        from: email.from?.text,
        to: addressText(email.to),
        subject: email.subject,
        date: email.date,
        text: email.text,
        html: email.html,
        attachments: summariseAttachments(email.attachments),
      });
      return 0;
    }

    case 'send': {
      const to = getArg(args, 'to');
      const subject = getArg(args, 'subject');
      const body = getArg(args, 'body');

      if (!to || !subject || !body) {
        throw new UsageError('send requires --to, --subject, and --body');
      }

      emit(
        await skill.sendEmail(to, subject, body, {
          cc: optionalArg(args, 'cc'),
          bcc: optionalArg(args, 'bcc'),
          attachments,
        }),
      );
      return 0;
    }

    case 'reply': {
      const messageId = args[1];
      const body = getArg(args, 'body');

      if (!messageId || !body) {
        throw new UsageError('reply requires <message-id> and --body');
      }

      emit(await skill.replyToEmail(messageId, body, { attachments }, mailboxArg(args)));
      return 0;
    }

    case 'list-folders': {
      const kind = getArg(args, 'kind') || 'all';
      if (!isKindFilter(kind)) {
        throw new UsageError(`--kind must be one of ${KIND_FILTERS.join(', ')}`);
      }

      const boxes: MailboxInfo[] = await skill.listMailboxes();
      emit(kind === 'all' ? boxes : boxes.filter((b) => b.kind === kind));
      return 0;
    }

    case 'create-folder': {
      const name = args[1];
      if (!name) {
        throw new UsageError(
          'create-folder requires a name\nCreates a folder; pass --label to create a label instead.',
        );
      }

      emit(await skill.createMailbox(name, mailboxKind(args)));
      return 0;
    }

    case 'delete-folder': {
      const name = args[1];
      if (!name) {
        throw new UsageError(
          'delete-folder requires a name\nDeletes a folder; pass --label to delete a label instead.',
        );
      }

      emit(await skill.deleteMailbox(name, mailboxKind(args)));
      return 0;
    }

    case 'thread': {
      const uid = requireUid(args, command);
      const body = getArg(args, 'body');
      if (!body) {
        throw new UsageError('thread requires <uid> and --body');
      }

      emit(
        await skill.continueThread(
          uid,
          body,
          {
            to: optionalArg(args, 'to'),
            cc: optionalArg(args, 'cc'),
            bcc: optionalArg(args, 'bcc'),
            attachments,
          },
          mailboxArg(args),
        ),
      );
      return 0;
    }

    case 'mark-read':
    case 'mark-unread': {
      const uid = requireUid(args, command);
      emit(await skill.markRead(uid, command === 'mark-read', mailboxArg(args)));
      return 0;
    }

    case 'star': {
      const uid = requireUid(args, command);
      emit(await skill.starEmail(uid, mailboxArg(args)));
      return 0;
    }

    case 'unstar': {
      const uid = requireUid(args, command);
      emit(await skill.unstarEmail(uid, mailboxArg(args)));
      return 0;
    }

    case 'move': {
      const uid = requireUid(args, command);
      const target = args[2];
      if (!target) {
        throw new UsageError('move requires <uid> and a destination mailbox');
      }

      emit(await skill.moveEmail(uid, target, mailboxArg(args)));
      return 0;
    }

    case 'delete': {
      const uid = requireUid(args, command);
      // Trash is recoverable; expunging is not, so it is opt-in.
      const permanent = args.includes('--permanent');
      emit(await skill.deleteEmail(uid, permanent, mailboxArg(args)));
      return 0;
    }

    default:
      console.error(`Unknown command: ${command}`);
      console.error(COMMANDS);
      return 1;
  }
}

/**
 * Run the CLI.
 *
 * @param args - Arguments after the program name, i.e. `process.argv.slice(2)`
 * @returns The process exit code: 0 on success, 1 on any reported failure
 *
 * @remarks
 * Nothing here calls `process.exit()`. The Bridge connection is closed in a
 * `finally`, so a usage error raised half way through a command logs out
 * rather than leaving the session open — which is what the previous version,
 * exiting from inside the switch, did.
 */
export async function run(args: string[]): Promise<number> {
  const command = args[0];

  if (!command) {
    console.error('Usage: protonmail <command> [options]');
    console.error(COMMANDS);
    return 1;
  }

  let skill: ProtonMailSkill | undefined;

  try {
    // Attachments are resolved before any connection is opened, so a mistyped
    // path fails on its own message rather than after a session has been
    // established.
    const attachments = resolveAttachments(getArgs(args, 'attach'));

    skill = new ProtonMailSkill();
    await skill.initialize();

    return await dispatch(skill, command, args, attachments);
  } catch (error) {
    console.error('Error:', messageOf(error));
    return 1;
  } finally {
    // A failure to log out must not mask the result of the command that ran.
    await skill?.cleanup().catch((error: unknown) => {
      console.error('Warning: could not close the Bridge connection:', messageOf(error));
    });
  }
}
