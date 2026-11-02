/**
 * Putting an app's text into the composer as plain, visible text.
 *
 * An app can only insert text with nothing to resolve. Text the composer or the
 * gateway would read as more than text is refused (`composerWouldResolve`) and
 * never reaches the draft. Text that is accepted is ordinary draft text, so it
 * needs no mark: nothing in it resolves, and what the person types next is theirs.
 *
 * @module composerActions/literalInsert
 */
import { IMG_EXT, parseDirs, parseFiles } from '../utils/fileTokens'
import { PASTE_TOKEN_REGEX, type PasteBlock } from '../utils/pasteTokens'
import { spliceDictationText } from '../lib/dictationText'

/* Each rule is a SUPERSET of a reader, so whatever that reader resolves, the
   rule refuses. The gateway's readers are Python, so the client cannot call them;
   each rule names the reader it covers and the wider shape it tests instead. */

/** A line whose first non-blank character is `/`: a slash command or quick prompt
 *  (`chat_turn/slash_commands.py`, `first_word = message.split()[0]`; the client's
 *  `interceptSlashCommand` reads `raw.trim()`). Blank is JS `\s` (what `trim()`
 *  removes) plus U+0085, which Python's `split()` and `strip()` also remove
 *  (`displaySafe` already drops U+001C to U+001F). */
const LINE_SLASH_RE = /^[\s\u0085]*\//gmu
/** A line that is a command or a leading `@prompt`: text added to it would be
 *  read as that command's argument (`/goal clear`, `/agent <name>`, `/side`). */
const COMMAND_LINE_RE = /^[\s\u0085]*[/@]/u
const LINE_BREAK_RE = /\r\n?|\n|\u2028|\u2029/u
/** `@` anywhere but straight after a letter or digit (so `a@b.com` stays text):
 *  file and folder mentions (`fileTokens.leadingMentionBoundary`), a leading
 *  `@prompt` or `@knowledge`. */
const AT_RE = /(?<![\p{L}\p{N}])@/gu
/** `$` before a letter or digit, after anything: the gateway's `$skill` reader
 *  (`skills._DOLLAR_SKILL_PATTERN`, `(?<![\w$])\$[a-z0-9]`) is narrower. */
const DOLLAR_RE = /\$[a-z0-9]/giu
/** A path separator followed on the same line by an image suffix. Every path the
 *  gateway's image upgrade matches (`kiro_crew.image_refs._PATH_RE`, POSIX or
 *  Windows) starts with a separator and ends in one of these suffixes on one line. */
const IMAGE_PATH_RE = new RegExp(`[/\\\\][^\\n\\r\\u2028\\u2029]*?${IMG_EXT.source.replace(/\$$/, '')}`, 'giu')

const count = (re: RegExp, text: string): number => [...text.matchAll(re)].length

/** How many things in `text` the composer or the gateway would read as more than
 *  text: commands, mentions, skills, staged-paste tokens, attachment and folder
 *  markers, image paths. */
function resolvableCounts(text: string): number[] {
  return [
    count(LINE_SLASH_RE, text),
    count(AT_RE, text),
    count(DOLLAR_RE, text),
    count(PASTE_TOKEN_REGEX, text),
    parseFiles(text).length,
    parseDirs(text).length,
    count(IMAGE_PATH_RE, text),
  ]
}

/** Whether any of the app's `text`, on its own, would be read as more than text. */
export function composerWouldResolve(text: string): boolean {
  return resolvableCounts(text).some((n) => n > 0)
}

/** `text` put into `value` at `[start, end)`, replacing the selection, spaced from
 *  a word it would touch: the composer's own splice (`spliceDictationText`). */
export function insertAt(value: string, start: number, end: number, text: string): { value: string; caret: number } {
  const s = Math.max(0, Math.min(start, value.length))
  return spliceDictationText(value, text, { start: s, end: Math.max(s, Math.min(end, value.length)) })
}

/** Whether putting `text` into `value` at `[start, end)` would leave something to
 *  resolve: in the text itself, as the argument of a command line it lands on, or
 *  made across either edge with the draft around it (an image path the text
 *  completes, a marker in front of a path the person typed). Measured against the
 *  draft with the selection removed. */
export function insertWouldResolve(value: string, start: number, end: number, text: string): boolean {
  if (composerWouldResolve(text)) return true
  const s = Math.max(0, Math.min(start, value.length))
  const e = Math.max(s, Math.min(end, value.length))
  // The line the text joins: a command's argument is resolved with it.
  if (COMMAND_LINE_RE.test(value.slice(0, s).split(LINE_BREAK_RE).pop() ?? '')) return true
  const without = value.slice(0, s) + value.slice(e)
  // Per reader, so a construct the insert makes is not hidden by one it moves
  // (a marker in front of `/path` turns a leading slash into an attachment).
  const had = resolvableCounts(without)
  return resolvableCounts(insertAt(value, s, e, text).value).some((n, i) => n > had[i])
}

/** The draft as it stood when the action was clicked. */
export interface DraftSnapshot {
  value: string
  /** Paste block ids, in order: a block added or removed is a change too. */
  blockIds: string[]
  start: number
  end: number
}

export function snapshotDraft(value: string, blocks: readonly PasteBlock[], selection: { start: number; end: number } | null): DraftSnapshot {
  const at = selection ?? { start: value.length, end: value.length }
  const start = Math.max(0, Math.min(at.start, value.length))
  const end = Math.max(start, Math.min(at.end, value.length))
  return { value, blockIds: blocks.map((b) => b.id), start, end }
}

/** Whether the draft is still the one the snapshot captured. */
export function draftUnchanged(at: DraftSnapshot, value: string, blocks: readonly PasteBlock[]): boolean {
  return at.value === value && at.blockIds.length === blocks.length && at.blockIds.every((id, i) => blocks[i]?.id === id)
}
