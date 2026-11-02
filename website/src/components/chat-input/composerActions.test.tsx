import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import type { ComposerActionHostOptions as InvocationFrameOptions } from '../../composerActions/composerActionHost'
import type { ComposerActionItem } from '../../composerActions/composerActionRegistry'
import type { PasteBlock } from '../../utils/pasteTokens'
import { ComposerActionMenuItems, useComposerActions } from './composerActions'
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '../ui/dropdown-menu'

// The frame host is tested in composerActions/composerActionHost.test.ts; here it is a
// stand-in that records its options so the test can answer as the app.
const frames: Array<{ opts: InvocationFrameOptions; accept: ReturnType<typeof vi.fn>; refuse: ReturnType<typeof vi.fn>; cancel: ReturnType<typeof vi.fn> }> = []
vi.mock('../../composerActions/composerActionHost', () => ({
  ComposerActionHost: class {
    accept = vi.fn()
    refuse = vi.fn()
    cancel = vi.fn()
    constructor(opts: InvocationFrameOptions) { frames.push({ opts, accept: this.accept, refuse: this.refuse, cancel: this.cancel }) }
    start() {}
  },
}))

// The icon needs the theme provider; the rows' own text is what these tests read.
vi.mock('../AppIcon', () => ({ default: () => null }))

const item: ComposerActionItem = { key: 'snip:insert', appName: 'snip', appLabel: 'Snippets', id: 'insert', title: 'Insert snippet', icon: '', maxChars: 100, width: 360, maxHeight: 320 }

let api: { start: (i: ComposerActionItem) => void; value: string; blocks: PasteBlock[]; setValue: (v: string) => void } | null = null
let selection = { start: 2, end: 2 }

function Host({ items = [item], scope = 's1' }: { items?: ComposerActionItem[]; scope?: string }) {
  const [value, setValue] = useState('hello')
  const [blocks] = useState<PasteBlock[]>([])
  const actions = useComposerActions({
    items, value, onChange: setValue, pasteBlocks: blocks,
    composerControl: () => ({ focus() {}, getRootElement: () => null, getSelection: () => selection, setSelection() {} }),
    scopeKey: scope, anchor: () => null,
  })
  api = { start: actions.start, value, blocks, setValue }
  return <>{actions.popover}<output data-testid="draft">{value}</output></>
}

beforeEach(() => { frames.length = 0; selection = { start: 2, end: 2 } })
afterEach(() => { cleanup(); api = null })

describe('useComposerActions', () => {
  it('hands the app nothing from the composer', () => {
    render(<Host />)
    act(() => api!.start(item))
    expect(frames).toHaveLength(1)
    expect(Object.keys(frames[0].opts).sort()).toEqual(['actionId', 'appName', 'container', 'deadlineMs', 'maxChars', 'onEnd', 'onEscape', 'onResize', 'onText', 'theme'])
    expect(frames[0].opts.maxChars).toBe(100)
  })

  it('inserts plain text at the captured caret when the draft did not change', () => {
    render(<Host />)
    act(() => api!.start(item))
    let verdict: string | undefined
    act(() => { verdict = frames[0].opts.onText('APP') })
    expect(verdict).toBeUndefined()
    expect(api!.blocks).toEqual([])
    expect(api!.value).toBe('he APP llo')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it.each([
    ['a slash command', '/goal clear'],
    ['an @prompt', '@prompt standup'],
    ['an image path', 'see /tmp/shot.png'],
    ['a staged-paste token', 'see [ Paste #1 · 3 lines ] here'],
  ])('refuses %s as not_literal and inserts nothing', (_name, text) => {
    render(<Host />)
    act(() => api!.start(item))
    let verdict: string | undefined
    act(() => { verdict = frames[0].opts.onText(text) })
    expect(verdict).toBe('not_literal')
    expect(api!.value).toBe('hello')
  })

  it('never writes over a draft that changed: it asks, and Discard leaves it alone', () => {
    render(<Host />)
    act(() => api!.start(item))
    act(() => api!.setValue('hello, edited'))
    let verdict: string | undefined
    act(() => { verdict = frames[0].opts.onText('APP') })
    expect(verdict).toBeUndefined()
    expect(api!.value).toBe('hello, edited')
    expect(screen.getByRole('dialog').textContent).toContain('APP')
    act(() => screen.getByText(/Discard/).click())
    expect(api!.value).toBe('hello, edited')
    expect(api!.blocks).toEqual([])
  })

  it('Insert anyway puts the text at the caret now', () => {
    render(<Host />)
    act(() => api!.start(item))
    act(() => api!.setValue('changed'))
    act(() => { frames[0].opts.onText('APP') })
    selection = { start: 7, end: 7 }
    act(() => screen.getByText(/Insert anyway/).click())
    expect(api!.value).toBe('changed APP')
  })

  it('refuses text that would complete an image path in the draft', () => {
    render(<Host />)
    act(() => api!.setValue('Look at /tmp/My'))
    selection = { start: 15, end: 15 }
    act(() => api!.start(item))
    let verdict: string | undefined
    act(() => { verdict = frames[0].opts.onText('Photo.png') })
    expect(verdict).toBe('not_literal')
    expect(api!.value).toBe('Look at /tmp/My')
  })

  it('refuses resolvable text to the app even when the draft changed meanwhile', () => {
    render(<Host />)
    act(() => api!.start(item))
    act(() => api!.setValue('hello, edited'))
    let verdict: string | undefined
    act(() => { verdict = frames[0].opts.onText('/goal clear') })
    expect(verdict).toBe('not_literal')
    // No Insert anyway offer for text that can never go in.
    expect(screen.queryByText(/Insert anyway/)).toBeNull()
    expect(api!.value).toBe('hello, edited')
  })

  it('Insert anyway refuses, in the popover, text that would resolve where the caret is now', () => {
    render(<Host />)
    act(() => api!.start(item))
    act(() => api!.setValue('Look at /tmp/My'))
    act(() => { frames[0].opts.onText('Photo.png') })
    selection = { start: 15, end: 15 }
    act(() => screen.getByText(/Insert anyway/).click())
    expect(api!.value).toBe('Look at /tmp/My')
    expect(screen.getByTestId('composer-action-ended').textContent).toMatch(/Snippets's text would be read as a command, mention or file here/)
  })

  it('cancels when the composer moves to another session', () => {
    const { rerender } = render(<Host scope="s1" />)
    act(() => api!.start(item))
    rerender(<Host scope="s2" />)
    expect(frames[0].cancel).toHaveBeenCalledWith('cancelled')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('cancels when the action is revoked', () => {
    const { rerender } = render(<Host items={[item]} />)
    act(() => api!.start(item))
    rerender(<Host items={[]} />)
    expect(frames[0].cancel).toHaveBeenCalledWith('revoked')
  })

  it('never grows taller than the room above its anchor', () => {
    render(<Host />)
    act(() => api!.start(item))
    act(() => frames[0].opts.onResize(600))
    // No anchor: the popover sits 96px from the bottom, 8px from the top.
    expect(screen.getByRole('dialog').style.maxHeight).toBe(`${window.innerHeight - 104}px`)
  })

  it('says what happened when the app fails', () => {
    render(<Host />)
    act(() => api!.start(item))
    act(() => frames[0].opts.onEnd('deadline'))
    expect(screen.getByRole('dialog').textContent).toMatch(/Snippets took too long/)
    // Through the shared error surface, as an alert, not a plain status line.
    expect(screen.getByTestId('composer-action-ended').textContent).toMatch(/Snippets took too long/)
    expect(screen.getByRole('alert').textContent).toMatch(/Snippets took too long/)
  })
})

describe('ComposerActionMenuItems', () => {
  it('lists each action as an item of the touch overflow menu and starts it on select', async () => {
    const onPick = vi.fn()
    render(
      <DropdownMenu open>
        <DropdownMenuTrigger>more</DropdownMenuTrigger>
        <DropdownMenuContent><ComposerActionMenuItems items={[item]} onPick={onPick} /></DropdownMenuContent>
      </DropdownMenu>,
    )
    const row = screen.getByRole('menuitem', { name: /Insert snippet/ })
    expect(row.textContent).toContain('Snippets')
    act(() => { fireEvent.click(row) })
    expect(onPick).toHaveBeenCalledWith(item)
  })

  it('items carry no restyle classes on the menu primitive itself', () => {
    render(
      <DropdownMenu open>
        <DropdownMenuTrigger>more</DropdownMenuTrigger>
        <DropdownMenuContent><ComposerActionMenuItems items={[item]} onPick={() => {}} /></DropdownMenuContent>
      </DropdownMenu>,
    )
    expect(screen.getByRole('menuitem').getAttribute('data-composer-action-row')).toBe(item.key)
  })

  it('renders nothing without actions', () => {
    render(
      <DropdownMenu open>
        <DropdownMenuTrigger>more</DropdownMenuTrigger>
        <DropdownMenuContent><ComposerActionMenuItems items={[]} onPick={() => {}} /></DropdownMenuContent>
      </DropdownMenu>,
    )
    expect(screen.queryByRole('menuitem')).toBeNull()
  })
})
