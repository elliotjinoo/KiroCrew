import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createElement } from 'react'
import { render, waitFor, act, fireEvent, renderHook, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { APP_FRAME_TAG as FRAME_TAG, MAX_OFFER_CHARS as MAX_COPY_CHARS, displaySafe as showableText } from '../appFrame/frameProtocol'
import { FRAME_SANDBOX } from '../appFrame/sandboxFrame'
import { installFrameWindows, postFrom, sentTo, type Sent } from '../test/LinkPreviewFramesTestUtils'
import { resolveSelectionActions, selectionGrantEntry, type ResolvedSelectionAction } from './selectionActionRegistry'
import { selectedTextFor } from './selectionSources'
import { closeSelectionLayer, openSelectionItem, setSelectionActionItems } from './selectionActionStore'
import { READY_TIMEOUT_MS, SELECTION_DEADLINE_MS as INVOCATION_DEADLINE_MS, SelectionInvocation, type InvocationView } from './selectionInvocation'

const listApps = vi.fn()
vi.mock('../api/client', () => ({ api: { listApps: () => listApps() } }))
const copyToClipboard = vi.fn(async (_text: string) => true)
vi.mock('../utils/clipboard', () => ({ copyToClipboard: (t: string) => copyToClipboard(t) }))
let touch = false
vi.mock('../utils/isTouchDevice', () => ({ isTouchDevice: () => touch }))

installFrameWindows()

const ITEM = { id: 'save', title: 'Save to notes', entry: 'dist/sel.mjs', effects: ['copy', 'open'] }
function app(over: Record<string, unknown> = {}, items: unknown[] = [ITEM], approved: unknown = ['save']) {
  return {
    name: 'notes-app',
    displayName: 'Notes',
    enabled: true,
    selectionActionGrant: { approved },
    manifest: { contributes: { selectionActions: items } },
    ...over,
  }
}
const item = (over: Record<string, unknown> = {}): ResolvedSelectionAction => resolveSelectionActions([app({}, [{ ...ITEM, ...over }])])[0]

const mint = vi.fn(async (..._args: unknown[]) => ({ frame: '/app-frame/notes-app/selectionActions/save/f/0-1.ab', frameId: 'f'.repeat(16), capability: 'cap', ttl: 3600 }))

/** A message from `el`'s frame. */
function from(el: HTMLIFrameElement, type: string, data: Record<string, unknown> = {}) {
  postFrom({ [FRAME_TAG]: 1, type, ...data }, el.contentWindow)
}
const types = (sent: Sent[]) => sent.map((m) => m.type)

function invocation(over: Partial<{ text: string; it: ResolvedSelectionAction }> = {}) {
  const box = document.createElement('div')
  document.body.append(box)
  const views: InvocationView[] = []
  const onClose = vi.fn()
  const it = over.it ?? item()
  const inv = new SelectionInvocation({
    item: it,
    selected: { source: 'chat', text: over.text ?? 'the selected words', truncated: false },
    box,
    mint,
    theme: () => 'light',
    onView: (v) => views.push(v),
    onClose,
  })
  return { inv, box, views, onClose, sent: sentTo(inv.el) }
}
async function opened(over: Parameters<typeof invocation>[0] = {}) {
  const h = invocation(over)
  h.inv.start()
  await act(async () => { await vi.advanceTimersByTimeAsync(0) })
  from(h.inv.el, 'ready')
  const invoke = h.sent.find((m) => m.type === 'selection.invoke') as Sent
  return { ...h, invoke, id: invoke.invocationId as string }
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  touch = false
})
afterEach(() => {
  act(() => closeSelectionLayer())
  act(() => setSelectionActionItems([]))
  listApps.mockReset()
  mint.mockClear()
  copyToClipboard.mockClear()
  document.body.replaceChildren()
  vi.useRealTimers()
})

describe('selection actions: discovery', () => {
  it('offers only approved items of enabled apps, and mirrors the grant entry', () => {
    expect(resolveSelectionActions([app()]).map((i) => i.key)).toEqual(['notes-app:save'])
    expect(resolveSelectionActions([app({}, [ITEM], [])])).toEqual([])
    // No grant key on the row: nothing is offered.
    expect(resolveSelectionActions([{ ...app(), selectionActionGrant: undefined }])).toEqual([])
    expect(resolveSelectionActions([app({ enabled: false })])).toEqual([])
    expect(selectionGrantEntry({ id: 's', sources: ['chat'], minLength: 3, maxLength: 9, effects: ['open', 'copy'] })).toBe('s:chat:3-9:copy,open')
  })

  it('drops an item whose fields are out of bounds or of the wrong type', () => {
    for (const bad of [{ maxLength: 9000 }, { minLength: '1' }, { sources: ['dom'] }, { effects: ['clipboard'] }, { entry: '../x.mjs' }, { title: 'x'.repeat(41) }, { minLength: 9, maxLength: 3 }]) {
      expect(resolveSelectionActions([app({}, [{ ...ITEM, ...bad }])])).toEqual([])
    }
  })
})

describe('selection actions: the typed chat source', () => {
  it('hands at most maxLength, never splits a surrogate pair, and refuses short or foreign selections', () => {
    const it2 = item({ minLength: 3, maxLength: 4 })
    expect(selectedTextFor('chat', ' ab ', it2)).toBeNull()
    expect(selectedTextFor('chat', 'abcdef', it2)).toEqual({ source: 'chat', text: 'abcd', truncated: true })
    expect(selectedTextFor('chat', 'abc😀z', it2)).toEqual({ source: 'chat', text: 'abc', truncated: true })
    expect(selectedTextFor('chat', 'abcd', it2)?.truncated).toBe(false)
  })
})

describe('selection actions: one invocation', () => {
  it('runs in the shared sandbox, and the frame gets the selected text and nothing else', async () => {
    const { inv, invoke, box } = await opened()
    expect(inv.el.getAttribute('sandbox')).toBe(FRAME_SANDBOX)
    expect(inv.el.hasAttribute('credentialless')).toBe(true)
    expect(inv.el.getAttribute('referrerpolicy')).toBe('no-referrer')
    expect(box.contains(inv.el)).toBe(true)
    expect(mint).toHaveBeenCalledWith('notes-app', 'selectionActions', 'save')
    expect(Object.keys(invoke).sort()).toEqual([FRAME_TAG, 'deadlineMs', 'invocationId', 'source', 'text', 'theme', 'truncated', 'type'].sort())
    expect(invoke.text).toBe('the selected words')
    expect(typeof invoke.invocationId).toBe('string')
  })

  it('accepts a declared offer once per seq and answers every effect', async () => {
    const { inv, sent, id, views } = await opened()
    from(inv.el, 'result.offer', { invocationId: id, seq: 1, kind: 'copy', value: 'note link' })
    expect(sent.at(-1)).toMatchObject({ type: 'result.ack', invocationId: id, seq: 1 })
    expect(views.at(-1)?.copy).toBe('note link')
    from(inv.el, 'result.offer', { invocationId: id, seq: 1, kind: 'copy', value: 'again' })
    expect(sent.at(-1)).toMatchObject({ type: 'result.error', seq: 1, code: 'stale' })
    from(inv.el, 'result.offer', { invocationId: 'not-it', seq: 5, kind: 'copy', value: 'x' })
    expect(sent.at(-1)).toMatchObject({ type: 'result.error', invocationId: 'not-it', code: 'stale' })
    from(inv.el, 'result.offer', { invocationId: id, seq: 2, kind: 'copy', value: 'x'.repeat(MAX_COPY_CHARS + 1) })
    expect(sent.at(-1)).toMatchObject({ code: 'too_large' })
    from(inv.el, 'result.offer', { invocationId: id, seq: 3, kind: 'open', value: 'http://example.com/' })
    expect(sent.at(-1)).toMatchObject({ code: 'not_allowed' })
    from(inv.el, 'result.offer', { invocationId: id, seq: 4, kind: 'open', value: 'https://notes.example.com/n/1' })
    expect(views.at(-1)?.open?.hostname).toBe('notes.example.com')
    expect(views.at(-1)?.copy).toBe('note link')
  })

  it('refuses an effect the item did not declare', async () => {
    const { inv, sent, id, views } = await opened({ it: item({ effects: [] }) })
    from(inv.el, 'result.offer', { invocationId: id, seq: 1, kind: 'copy', value: 'x' })
    expect(sent.at(-1)).toMatchObject({ type: 'result.error', code: 'not_allowed' })
    expect(views.at(-1)?.copy).toBeNull()
  })

  it('cancels at the deadline, and a resize or offer restarts it', async () => {
    const { inv, sent, id, onClose } = await opened()
    await act(async () => { await vi.advanceTimersByTimeAsync(INVOCATION_DEADLINE_MS - 1000) })
    from(inv.el, 'invocation.resize', { invocationId: id, height: 9999 })
    await act(async () => { await vi.advanceTimersByTimeAsync(INVOCATION_DEADLINE_MS - 1000) })
    expect(onClose).not.toHaveBeenCalled()
    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
    expect(sent.at(-1)).toMatchObject({ type: 'invoke.cancel', invocationId: id, reason: 'deadline' })
    expect(onClose).toHaveBeenCalled()
    expect(inv.el.isConnected).toBe(false)
  })

  it('clamps a resize to the item maxHeight', async () => {
    const { inv, id, views } = await opened({ it: item({ popover: { maxHeight: 200 } }) })
    from(inv.el, 'invocation.resize', { invocationId: id, height: 9999 })
    expect(views.at(-1)?.height).toBe(200)
  })

  it('closing the surface cancels the open invocation and disposes the frame', async () => {
    const { inv, sent, id } = await opened()
    inv.dispose()
    expect(types(sent).slice(-2)).toEqual(['invoke.cancel', 'dispose'])
    expect(sent.at(-2)).toMatchObject({ invocationId: id, reason: 'closed' })
    expect(inv.el.isConnected).toBe(false)
  })

  it('a frame that never says ready, or navigates away, fails without an invocation', async () => {
    const a = invocation()
    a.inv.start()
    await act(async () => { await vi.advanceTimersByTimeAsync(READY_TIMEOUT_MS + 10) })
    expect(a.views.at(-1)).toMatchObject({ phase: 'failed', notice: { kind: 'no_response' } })
    expect(types(a.sent)).not.toContain('selection.invoke')
    const b = invocation()
    b.inv.start()
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    b.inv.el.dispatchEvent(new Event('load'))
    b.inv.el.dispatchEvent(new Event('load'))
    expect(b.views.at(-1)?.phase).toBe('failed')
  })

  it('ignores a message from any other window', async () => {
    const { inv, id, views } = await opened()
    const before = views.length
    postFrom({ [FRAME_TAG]: 1, type: 'result.offer', invocationId: id, seq: 1, kind: 'copy', value: 'x' }, window)
    expect(views.length).toBe(before)
    expect(inv.current().copy).toBeNull()
  })

  it('an app error is shown as plain text without controls or direction overrides', async () => {
    const { inv, id, views } = await opened()
    from(inv.el, 'invocation.error', { invocationId: id, message: 'bad\u202e thing\u0007' })
    expect(views.at(-1)?.notice).toEqual({ kind: 'error', message: 'bad thing' })
    expect(showableText('a\nb')).toBe('a\nb')
  })
})

describe('selection actions: the layer', () => {
  async function mountLayer() {
    const mod = await import('./SelectionActionLayer')
    mod.setSelectionActionMintForTest(mint)
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(createElement(QueryClientProvider, { client: qc }, createElement(mod.default)))
    return mod
  }
  const rect = { left: 100, top: 50, bottom: 70 }

  it('attributes the popover to the app and draws Copy only once the frame offered it', async () => {
    listApps.mockResolvedValue([app()])
    await mountLayer()
    act(() => openSelectionItem(item(), 'chat', 'the selected words', rect))
    const dialog = await screen.findByTestId('selection-action-popover')
    expect(dialog.textContent).toContain('Save to notes')
    expect(dialog.textContent).toContain('Notes')
    expect(screen.queryByText('Copy')).toBeNull()
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    const el = dialog.querySelector('iframe') as HTMLIFrameElement
    act(() => from(el, 'ready'))
    const id = sentTo(el).find((m) => m.type === 'selection.invoke')?.invocationId
    act(() => from(el, 'result.offer', { invocationId: id, seq: 1, kind: 'copy', value: 'note link' }))
    fireEvent.click(await screen.findByText('Copy'))
    await waitFor(() => expect(copyToClipboard).toHaveBeenCalledWith('note link'))
  })

  it('Escape closes the popover and cancels its invocation', async () => {
    listApps.mockResolvedValue([app()])
    await mountLayer()
    act(() => openSelectionItem(item(), 'chat', 'words', rect))
    const dialog = await screen.findByTestId('selection-action-popover')
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    const el = dialog.querySelector('iframe') as HTMLIFrameElement
    act(() => from(el, 'ready'))
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByTestId('selection-action-popover')).toBeNull())
    expect(sentTo(el).map((m) => m.type)).toContain('invoke.cancel')
  })

  it('an item that is no longer approved closes its popover', async () => {
    listApps.mockResolvedValue([app({}, [ITEM], [])])
    await mountLayer()
    act(() => openSelectionItem(item(), 'chat', 'words', rect))
    await waitFor(() => expect(listApps).toHaveBeenCalled())
    await waitFor(() => expect(screen.queryByTestId('selection-action-popover')).toBeNull())
  })

  it('a selection shorter than the item needs opens no frame', async () => {
    listApps.mockResolvedValue([app()])
    await mountLayer()
    act(() => openSelectionItem(item({ minLength: 10 }), 'chat', 'short', rect))
    const dialog = await screen.findByTestId('selection-action-popover')
    expect(dialog.querySelector('iframe')).toBeNull()
    expect(mint).not.toHaveBeenCalled()
  })

  it('on touch it is a bottom sheet, away from the native selection handles', async () => {
    touch = true
    listApps.mockResolvedValue([app()])
    await mountLayer()
    act(() => openSelectionItem(item(), 'chat', 'words', rect))
    const dialog = await screen.findByTestId('selection-action-popover')
    expect(dialog.className).toContain('bottom-')
    expect(dialog.style.top).toBe('')
  })
})

describe('selection actions: toolbar items', () => {
  async function hook(apps: unknown[]) {
    const { useAppSelectionActions } = await import('./useAppSelectionActions')
    // No query provider: a chat reply reads the store the layer publishes.
    act(() => setSelectionActionItems(resolveSelectionActions(apps as never[])))
    return renderHook(() => useAppSelectionActions('chat'))
  }

  it('up to two items are their own buttons; more share one Apps button', async () => {
    const two = await hook([app({}, [ITEM, { ...ITEM, id: 'tag', title: 'Tag it' }], ['save', 'tag'])])
    await waitFor(() => expect(two.result.current.map((a) => a.label)).toEqual(['Save to notes', 'Tag it']))
    const many = await hook([
      app({}, [ITEM, { ...ITEM, id: 'tag', title: 'Tag it' }], ['save', 'tag']),
      app({ name: 'other', displayName: 'Other' }, [ITEM], ['save']),
    ])
    await waitFor(() => expect(many.result.current.map((a) => a.id)).toEqual(['app-items']))
  })
})
