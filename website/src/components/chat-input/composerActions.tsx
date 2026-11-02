import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { X } from 'lucide-react'
import AppIcon from '../AppIcon'
import { Btn } from '../ui'
import { OverlayPortal, useCloseWhenCrewHidden } from '../overlayRoot'
import ErrorNotice from '../ErrorNotice'
import { DropdownMenuItem } from '../ui/dropdown-menu'
import { i18nT } from '../../i18n/t'
import { currentTheme } from '../../appFrame/sandboxFrame'
import { ComposerActionHost, type EndReason } from '../../composerActions/composerActionHost'
import type { ComposerActionItem } from '../../composerActions/composerActionRegistry'
import { composerWouldResolve, draftUnchanged, insertAt as spliceInsert, insertWouldResolve, snapshotDraft, type DraftSnapshot } from '../../composerActions/literalInsert'
import type { ComposerControl } from '../composerControl'
import type { PasteBlock } from '../../utils/pasteTokens'

/* App composer actions (`contributes.composerActions`): rows in the "+" menu that
   open the app's sandboxed frame in a popover above the composer. The app is
   handed nothing from the composer; it offers text, which goes in as visible,
   editable text at the caret the click captured (`composerActions/literalInsert.ts`).
   Text with anything the composer would resolve is refused `not_literal`, so
   what goes in is plain text. The person reads it and sends it; the app never
   sends. If the draft changed while
   the app worked, the text is shown with Insert anyway and Discard instead of
   being inserted over the change. */

/** How long one invocation may stay open; each resize or offer resets it. */
export const COMPOSER_ACTION_DEADLINE_MS = 2 * 60_000
const DEFAULT_FRAME_HEIGHT = 160
const MIN_FRAME_HEIGHT = 48

type Phase =
  | { kind: 'running' }
  | { kind: 'conflict'; text: string }
  | { kind: 'ended'; reason: EndReason | 'not_literal' }

interface Open {
  item: ComposerActionItem
  /** The draft at the click: where the text goes when nothing changed since. */
  snapshot: DraftSnapshot
  anchor: DOMRect | null
}

export interface ComposerActionsOptions {
  items: readonly ComposerActionItem[]
  value: string
  onChange: (v: string) => void
  pasteBlocks: readonly PasteBlock[]
  composerControl: () => ComposerControl | null
  /** Changes when the composer starts holding another session's draft: an open
   *  invocation is cancelled then, never answered into the other draft. */
  scopeKey?: string | null
  /** Where the popover hangs from (the "+" trigger). */
  anchor: () => DOMRect | null
}

export function useComposerActions({ items, value, onChange, pasteBlocks, composerControl, scopeKey, anchor }: ComposerActionsOptions) {
  const [open, setOpen] = useState<Open | null>(null)
  const [phase, setPhase] = useState<Phase>({ kind: 'running' })
  const [frameHeight, setFrameHeight] = useState(DEFAULT_FRAME_HEIGHT)
  const frameRef = useRef<ComposerActionHost | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)
  // Read at offer time, after the app worked: the live draft, not the render's.
  const live = useRef({ value, pasteBlocks, onChange, composerControl })
  live.current = { value, pasteBlocks, onChange, composerControl }
  const openRef = useRef(open)
  openRef.current = open

  const insertAt = useCallback((text: string, start: number, end: number) => {
    const { value: v, onChange: change, composerControl: control } = live.current
    // Refused when the text, or what it makes with the draft around it, would resolve.
    if (insertWouldResolve(v, start, end, text)) return false
    const next = spliceInsert(v, start, end, text)
    change(next.value)
    requestAnimationFrame(() => control()?.setSelection(next.caret, next.caret, { focus: true }))
    return true
  }, [])

  const close = useCallback(() => {
    frameRef.current?.cancel('cancelled')
    frameRef.current = null
    setOpen(null)
  }, [])

  const start = useCallback((item: ComposerActionItem) => {
    frameRef.current?.cancel('cancelled')
    const { value: v, pasteBlocks: blocks, composerControl: control } = live.current
    setPhase({ kind: 'running' })
    setFrameHeight(DEFAULT_FRAME_HEIGHT)
    setOpen({ item, snapshot: snapshotDraft(v, blocks, control()?.getSelection() ?? null), anchor: anchor() })
  }, [anchor])

  // The frame is made once its container is in the document.
  useLayoutEffect(() => {
    if (!open || frameRef.current || !containerRef.current) return
    const { item, snapshot } = open
    const frame = new ComposerActionHost({
      appName: item.appName,
      actionId: item.id,
      container: containerRef.current,
      theme: currentTheme,
      maxChars: item.maxChars,
      deadlineMs: COMPOSER_ACTION_DEADLINE_MS,
      onText: (text) => {
        // Only text with nothing to resolve goes in: no command, mention, skill,
        // paste token, marker or image path, so it needs no mark in the draft.
        if (composerWouldResolve(text)) return 'not_literal'
        const now = live.current
        if (draftUnchanged(snapshot, now.value, now.pasteBlocks)) {
          if (!insertAt(text, snapshot.start, snapshot.end)) return 'not_literal'
          frameRef.current = null
          setOpen(null)
          return undefined
        }
        // The app's part is done; the text is never written over a draft that
        // moved on, so the person decides here.
        frameRef.current = null
        setPhase({ kind: 'conflict', text })
        return undefined
      },
      onResize: (h) => setFrameHeight(Math.max(MIN_FRAME_HEIGHT, Math.min(item.maxHeight, Math.round(h)))),
      onEnd: (reason) => {
        frameRef.current = null
        // The person's own close needs no notice; anything else says what happened.
        if (reason === 'cancelled' || reason === 'closed') { setOpen(null); return }
        setPhase({ kind: 'ended', reason })
      },
      onEscape: () => close(),
    })
    frameRef.current = frame
    frame.start()
  }, [open, insertAt, close])

  // Another session's draft in this composer: cancel, never insert into it.
  const scopeRef = useRef(scopeKey)
  useEffect(() => {
    if (scopeRef.current !== scopeKey && openRef.current) close()
    scopeRef.current = scopeKey
  }, [scopeKey, close])

  // An action the owner revoked or an app disabled goes with its row.
  useEffect(() => {
    if (open && !items.some((i) => i.key === open.item.key)) {
      frameRef.current?.cancel('revoked')
      frameRef.current = null
      setOpen(null)
    }
  }, [items, open])

  useEffect(() => () => { frameRef.current?.cancel('cancelled') }, [])

  const insertAnyway = useCallback(() => {
    if (phase.kind !== 'conflict') return
    const sel = live.current.composerControl()?.getSelection()
    const at = sel ?? { start: live.current.value.length, end: live.current.value.length }
    // The app's part is over, so a refusal here is said in the popover.
    if (!insertAt(phase.text, at.start, at.end)) { setPhase({ kind: 'ended', reason: 'not_literal' }); return }
    setOpen(null)
  }, [phase, insertAt])

  const discard = useCallback(() => setOpen(null), [])

  const popover: ReactNode = open ? (
    <ComposerActionPopover
      item={open.item}
      anchor={open.anchor}
      phase={phase}
      frameHeight={frameHeight}
      containerRef={containerRef}
      onClose={close}
      onInsertAnyway={insertAnyway}
      onDiscard={discard}
    />
  ) : null

  return { start, close, popover, openKey: open?.item.key ?? null }
}

function endedMessage(reason: EndReason | 'not_literal', app: string): string {
  switch (reason) {
    case 'not_literal': return i18nT('components.chatInput.composer_action_not_literal', { app })
    case 'deadline': return i18nT('components.chatInput.composer_action_timed_out', { app })
    case 'app_error': return i18nT('components.chatInput.composer_action_app_error', { app })
    case 'revoked': return i18nT('components.chatInput.composer_action_revoked', { app })
    default: return i18nT('components.chatInput.composer_action_failed', { app })
  }
}

function ComposerActionPopover({ item, anchor, phase, frameHeight, containerRef, onClose, onInsertAnyway, onDiscard }: {
  item: ComposerActionItem
  anchor: DOMRect | null
  phase: Phase
  frameHeight: number
  containerRef: React.MutableRefObject<HTMLDivElement | null>
  onClose: () => void
  onInsertAnyway: () => void
  onDiscard: () => void
}) {
  const width = Math.min(item.width, window.innerWidth - 16)
  const left = Math.max(8, Math.min(anchor?.left ?? 8, window.innerWidth - width - 8))
  const bottom = anchor ? window.innerHeight - anchor.top + 8 : 96
  // Never taller than the room above its anchor, so the header and close stay on screen.
  const maxHeight = Math.max(MIN_FRAME_HEIGHT, window.innerHeight - bottom - 8)
  const title = i18nT('components.chatInput.composer_action_dialog', { title: item.title, app: item.appLabel })
  // Escape from the dashboard closes it; Escape inside the frame arrives as `escape`.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  // A switch to a remote Crew cancels the invocation, so that Crew's Escape
  // never reaches this listener.
  useCloseWhenCrewHidden(true, onClose)
  return (
    <OverlayPortal>
      <div
        role="dialog"
        aria-label={title}
        data-composer-action={item.key}
        className="fixed rounded-xl bg-bg-elevated border border-border shadow-xl z-[60] flex flex-col overflow-y-auto animate-slide-up"
        style={{ left, bottom, width, maxHeight }}
      >
        <div className="flex items-center gap-2 px-3 py-2 border-b border-border">
          {item.icon ? <AppIcon icon={item.icon} size={14} /> : null}
          <div className="min-w-0 flex-1">
            <div className="text-[12px] font-medium text-text truncate">{item.title}</div>
            <div className="text-[11px] text-muted truncate">{item.appLabel}</div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={i18nT('components.chatInput.composer_action_close')}
            title={i18nT('components.chatInput.composer_action_close')}
            className="w-6 h-6 rounded-md flex items-center justify-center bg-transparent border-none cursor-pointer text-muted hover:text-text hover:bg-bg-hover"
          >
            <X size={14} />
          </button>
        </div>
        {/* The frame stays in the document while the person decides a held
            offer, so its answer reaches it; it just takes no room then. */}
        {phase.kind !== 'ended' && (
          <div ref={containerRef} style={{ height: phase.kind === 'running' ? frameHeight : 0 }} className="w-full overflow-hidden" />
        )}
        {phase.kind === 'conflict' && (
          <div className="px-3 py-2 flex flex-col gap-2">
            <div className="text-[12px] text-text">{i18nT('components.chatInput.composer_action_draft_changed', { app: item.appLabel })}</div>
            <pre className="m-0 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-bg px-2 py-1.5 text-[12px] text-text font-sans">{phase.text}</pre>
            <div className="flex justify-end gap-2">
              <Btn type="button" onClick={onDiscard}>{i18nT('components.chatInput.composer_action_discard')}</Btn>
              <Btn type="button" primary onClick={onInsertAnyway}>{i18nT('components.chatInput.composer_action_insert_anyway')}</Btn>
            </div>
          </div>
        )}
        {phase.kind === 'ended' && (
          // No hand-off: the composer draft below is unsaved.
          <ErrorNotice message={endedMessage(phase.reason, item.appLabel)} variant="inline" className="px-3 py-2" testId="composer-action-ended" />
        )}
        <div className="px-3 py-1.5 border-t border-border text-[11px] text-muted">
          {i18nT('components.chatInput.composer_action_footer', { app: item.appLabel })}
        </div>
      </div>
    </OverlayPortal>
  )
}

/** The "+" menu rows, one per action, each naming its app. */
export function ComposerActionRows({ items, onPick }: { items: readonly ComposerActionItem[]; onPick: (item: ComposerActionItem) => void }) {
  if (!items.length) return null
  return (
    <div className="mt-2 pt-2 border-t border-border flex flex-col gap-0.5">
      {items.map((item) => (
        <button
          key={item.key}
          type="button"
          onClick={() => onPick(item)}
          data-composer-action-row={item.key}
          className="w-full flex items-center gap-2.5 px-2 py-1.5 rounded-lg bg-transparent hover:bg-bg-hover transition-colors cursor-pointer text-left"
        >
          <span className="w-4 shrink-0 flex items-center justify-center text-muted"><AppIcon icon={item.icon} size={14} /></span>
          <div className="min-w-0 flex items-baseline gap-1.5">
            <span className="text-[12px] font-medium text-text truncate">{item.title}</span>
            {/* Attribution: the row is the app's, so it says whose. */}
            <span className="text-[11px] text-muted truncate">{item.appLabel}</span>
          </div>
        </button>
      ))}
    </div>
  )
}

/** The same rows as items of the touch overflow menu (ChatInput's
 *  `composer-more-trigger`), which stands in for the "+" menu on a phone. */
export function ComposerActionMenuItems({ items, onPick }: { items: readonly ComposerActionItem[]; onPick: (item: ComposerActionItem) => void }) {
  if (!items.length) return null
  return (
    <div className="mt-1 pt-1 border-t border-border">
      {items.map((item) => (
        <DropdownMenuItem key={item.key} asChild onSelect={() => onPick(item)}>
          <div data-composer-action-row={item.key} className="w-full flex items-center gap-2.5 px-2 py-1.5 rounded-lg cursor-pointer text-left">
            <span className="w-4 shrink-0 flex items-center justify-center text-muted"><AppIcon icon={item.icon} size={14} /></span>
            <div className="min-w-0 flex items-baseline gap-1.5">
              <span className="text-[12px] font-medium text-text truncate">{item.title}</span>
              <span className="text-[11px] text-muted truncate">{item.appLabel}</span>
            </div>
          </div>
        </DropdownMenuItem>
      ))}
    </div>
  )
}

const NO_ACTIONS: readonly ComposerActionItem[] = []

/** ChatInput's whole wiring: the "+" menu rows and the popover. */
export function useComposerActionMenu({ items, plusBtnRef, closeMenu, ...rest }: Omit<ComposerActionsOptions, 'items' | 'anchor'> & {
  items: readonly ComposerActionItem[] | undefined
  plusBtnRef: React.RefObject<HTMLButtonElement | null>
  closeMenu: () => void
}) {
  const offered = items?.length ? items : NO_ACTIONS
  const actions = useComposerActions({
    ...rest,
    items: offered,
    anchor: () => plusBtnRef.current?.getBoundingClientRect() ?? null,
  })
  const rows = offered.length
    ? <ComposerActionRows items={offered} onPick={(item) => { closeMenu(); actions.start(item) }} />
    : null
  return { rows, items: offered, start: actions.start, popover: actions.popover }
}
