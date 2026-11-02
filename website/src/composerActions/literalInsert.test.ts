import { describe, expect, it } from 'vitest'
import { composerWouldResolve, insertAt, insertWouldResolve } from './literalInsert'

describe('composerWouldResolve', () => {
  it.each([
    ['a slash command', '/goal clear'],
    ['a slash command on a later line', 'notes\n  /clear'],
    ['an @prompt', '@prompt standup'],
    ['a file mention after a word', 'read @notes.txt now'],
    ['a mention after an opener', 'see (@src/)'],
    ['a $skill', 'use $deploy here'],
    ['a POSIX image path', 'look at /tmp/shot.png please'],
    ['a spaced image path', '/Users/John Smith/a b.JPG'],
    ['a Windows image path', 'C:\\Users\\me\\shot.webp'],
    ['an attachment marker', '[attached_file 1] report'],
    ['a folder marker', '[attached_dir 1] src'],
    ['a staged-paste token', '[ Paste #2 · 4 lines ]'],
    // Whitespace the composer's trim() or Python's split() drops before a first word.
    ['a slash after a no-break space', '\u00a0/side hello'],
    ['a slash after an em space', '\u2003/clear'],
    ['a slash after a BOM', '\ufeff/compact'],
    ['a slash after an ideographic space', '\u3000/clear'],
    ['a slash after U+0085', '\u0085/clear'],
    ['an @prompt after U+0085', '\u0085@prompt standup'],
    // The gateway's $skill reader matches after any non-word character.
    ['a $skill after a colon', 'Steps:$deploy'],
    ['a $skill after a dash', 'x-$deploy'],
    ['an @ after punctuation', 'cc:@notes.txt'],
  ])('refuses %s', (_name, text) => {
    expect(composerWouldResolve(text)).toBe(true)
  })

  it.each([
    ['plain text', 'Standup notes for today'],
    ['an email address', 'mail me at a@b.com'],
    ['a price', 'costs 5$ total'],
    ['a fraction mid-line', 'half is 1/2'],
    ['a file name with no path', 'see shot.png'],
  ])('accepts %s', (_name, text) => {
    expect(composerWouldResolve(text)).toBe(false)
  })

  it('reads the same text the same way twice (no regex state carried)', () => {
    expect(composerWouldResolve('[ Paste #1 · 3 lines ]')).toBe(true)
    expect(composerWouldResolve('[ Paste #1 · 3 lines ]')).toBe(true)
  })
})

describe('insertWouldResolve', () => {
  it('refuses text that completes an image path the person started', () => {
    expect(insertWouldResolve('Look at /tmp/My', 15, 15, 'Photo.png')).toBe(true)
    // A second path on the line is counted too, not hidden by the first.
    expect(insertWouldResolve('see /a.png and /tmp/My', 22, 22, 'Photo.png')).toBe(true)
  })

  it('refuses a marker the text would put in front of a path the person typed', () => {
    expect(insertWouldResolve(' /tmp/report.pdf', 0, 0, '[attached_file 1]')).toBe(true)
    expect(insertWouldResolve(' src/', 0, 0, '[attached_dir 1]')).toBe(true)
  })

  it('accepts plain text beside what the person already wrote', () => {
    // The draft's own path is the person's; the insert adds nothing to resolve.
    expect(insertWouldResolve('see /tmp/a.png then ', 20, 20, 'reply soon')).toBe(false)
    expect(insertWouldResolve('Standup: ', 9, 9, 'Yesterday: review. Today: notes.')).toBe(false)
  })

  it('refuses text that would become a command argument on the line it joins', () => {
    expect(insertWouldResolve('/goal ', 6, 6, 'clear')).toBe(true)
    expect(insertWouldResolve('/goal', 5, 5, 'clear')).toBe(true)
    expect(insertWouldResolve('  /agent ', 9, 9, 'helper')).toBe(true)
    expect(insertWouldResolve('\u00a0/side ', 7, 7, 'hello')).toBe(true)
    expect(insertWouldResolve('@prompt ', 8, 8, 'standup')).toBe(true)
    expect(insertWouldResolve('notes\n/goal ', 12, 12, 'clear')).toBe(true)
  })

  it('accepts text on a plain line below a command line', () => {
    expect(insertWouldResolve('/goal set\nthen ', 15, 15, 'clear')).toBe(false)
  })

  it('measures against the draft with the selection removed', () => {
    expect(insertWouldResolve('/tmp/a.png', 0, 10, 'plain')).toBe(false)
  })
})

describe('insertAt', () => {
  it('puts the text at the caret, spaced from words it would touch', () => {
    expect(insertAt('hello', 2, 2, 'APP')).toEqual({ value: 'he APP llo', caret: 6 })
    expect(insertAt('', 0, 0, 'APP')).toEqual({ value: 'APP', caret: 3 })
    expect(insertAt('a b', 0, 3, 'APP')).toEqual({ value: 'APP', caret: 3 })
  })

  it('never joins an app word onto a sigil the person typed', () => {
    expect(insertAt('@', 1, 1, 'prompt').value).toBe('@ prompt')
    expect(insertAt('/', 1, 1, 'clear').value).toBe('/ clear')
  })
})
