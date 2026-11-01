/**
 * SelectionActionLayer — runs app items on selected chat text (`contributes.selectionActions`).
 *
 * The host owns everything around the app: the trigger (an item, or the Apps
 * menu, in the selection toolbar of a chat reply), the popover with the app's
 * name and a Close button, and the Copy and Open buttons. Only the popover body
 * is the app's: a sandboxed, opaque-origin frame that is handed the selected text
 * and nothing else (`selectionInvocation.ts`).
 *
 * On a touch device the popover is a sheet at the bottom of the screen, so it
 * never covers the native selection handles and Copy callout; nothing here
 * listens for a long-press.
 *
 * Mounted once, beside `LinkPreviewLayer`.
 *
 * @module selectionActions/SelectionActionLayer
 */
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Check, ExternalLink, X } from 'lucide-react'
import { api } from '../api/client'
import { currentTheme, mintAppFrame } from '../appFrame/sandboxFrame'
import ErrorNotice from '../components/ErrorNotice'
import { OverlayPortal } from '../components/overlayRoot'
import { Btn } from '../components/ui'
import { i18nT } from '../i18n/t'
import { copyToClipboard } from '../utils/clipboard'
import { isTouchDevice } from '../utils/isTouchDevice'
import { closeSelectionLayer, openSelectionItem, setSelectionActionItems, useSelectionLayerState, type Anchor } from './selectionActionStore'
import { resolveSelectionActions, type ResolvedSelectionAction } from './selectionActionRegistry'
import { SelectionInvocation, type InvocationOptions, type InvocationView } from './selectionInvocation'
import { selectedTextFor, type SelectionSourceKind } from './selectionSources'
import { itemIcon } from './useAppSelectionActions'

const MARGIN = 8
const GAP = 8
/** Header and footer of the popover, outside the frame. */
const CHROME_PX = 96

/** Overridable in tests: how an item's frame is minted. */
let mintForItems: InvocationOptions['mint'] = mintAppFrame
export function setSelectionActionMintForTest(mint?: InvocationOptions['mint']): void {
  mintForItems = mint ?? mintAppFrame
}

/** Where a floating surface of `width` x `height` goes for an anchor: below it, else above. */
export function placeBelow(anchor: Anchor, width: number, height: number): { left: number; top: number } {
  const vw = window.innerWidth
  const vh = window.innerHeight
  const left = Math.max(MARGIN, Math.min(anchor.left, vw - width - MARGIN))
  const below = anchor.bottom + GAP
  const top = below + height <= vh - MARGIN ? below : Math.max(MARGIN, anchor.top - GAP - height)
  return { left, top }
}

function useDismiss(ref: React.RefObject<HTMLElement | null>, close: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
    const onDown = (e: PointerEvent) => {
      const el = ref.current
      if (el && e.target instanceof Node && !el.contains(e.target)) close()
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onDown, true)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onDown, true)
    }
  }, [ref, close])
}

function AppsMenu({ items, source, text, anchor }: { items: ResolvedSelectionAction[]; source: SelectionSourceKind; text: string; anchor: Anchor }) {
  const ref = useRef<HTMLDivElement>(null)
  useDismiss(ref, closeSelectionLayer)
  const touch = isTouchDevice()
  const pos = touch ? null : placeBelow(anchor, 240, Math.min(48 + items.length * 36, 360))
  useEffect(() => { ref.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus() }, [])
  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    e.preventDefault()
    const rows = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])
    const at = rows.indexOf(document.activeElement as HTMLButtonElement)
    rows[(at + (e.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length]?.focus()
  }
  return (
    <div
      ref={ref}
      role="menu"
      tabIndex={-1}
      aria-label={i18nT('components.selectionActions.menu_label')}
      onKeyDown={onKeyDown}
      data-testid="selection-apps-menu"
      className={`fixed z-[9999] flex flex-col p-1 rounded-lg bg-bg-elevated border border-border shadow-lg ${touch ? 'inset-x-2 bottom-[calc(env(safe-area-inset-bottom,0px)+8px)]' : 'w-60'}`}
      style={pos ?? undefined}
    >
      {items.map((item) => (
        <button
          key={item.key}
          role="menuitem"
          className={`flex items-center gap-2 rounded-md text-left text-text hover:bg-bg-hover focus-visible:bg-bg-hover ${touch ? 'px-3 min-h-11 text-[14px]' : 'px-2.5 py-1.5 text-[13px]'}`}
          onClick={() => openSelectionItem(item, source, text, anchor)}
        >
          <span className="shrink-0">{itemIcon(item)}</span>
          <span className="min-w-0 flex-1 truncate">{item.title}</span>
          <span className="shrink-0 max-w-[45%] truncate text-[11px] text-muted">{item.appLabel}</span>
        </button>
      ))}
    </div>
  )
}

function ItemPopover({ item, source, text, anchor }: { item: ResolvedSelectionAction; source: SelectionSourceKind; text: string; anchor: Anchor }) {
  const ref = useRef<HTMLDivElement>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const titleId = useId()
  const selected = selectedTextFor(source, text, item)
  const [view, setView] = useState<InvocationView | null>(null)
  const [copied, setCopied] = useState(false)
  const [copyFailed, setCopyFailed] = useState(false)
  const invocationRef = useRef<SelectionInvocation | null>(null)
  const close = useCallback(() => closeSelectionLayer(), [])
  useDismiss(ref, close)

  useLayoutEffect(() => {
    const box = boxRef.current
    if (!box || !selected) return
    const inv = new SelectionInvocation({
      item, selected, box, mint: mintForItems, theme: currentTheme, onView: setView, onClose: close,
    })
    invocationRef.current = inv
    setView(inv.current())
    inv.start()
    const themeWatch = new MutationObserver(() => inv.setTheme(currentTheme()))
    themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme'] })
    return () => {
      themeWatch.disconnect()
      inv.dispose()
      invocationRef.current = null
    }
    // One invocation per opened popover: the layer remounts this for every pick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(() => { closeRef.current?.focus() }, [])

  const touch = isTouchDevice()
  const frameHeight = view?.height ?? 160
  const pos = touch ? null : placeBelow(anchor, item.width, Math.min(item.maxHeight, frameHeight) + CHROME_PX)
  const failed = view?.phase === 'failed'
  const onCopy = async () => {
    if (!view?.copy) return
    const ok = await copyToClipboard(view.copy)
    setCopied(ok)
    setCopyFailed(!ok)
  }

  return (
    <div
      ref={ref}
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      data-testid="selection-action-popover"
      className={`fixed z-[9999] flex flex-col rounded-lg bg-bg-elevated border border-border shadow-lg overflow-hidden ${touch ? 'inset-x-2 bottom-[calc(env(safe-area-inset-bottom,0px)+8px)]' : ''}`}
      style={pos ? { ...pos, width: item.width } : undefined}
    >
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border">
        <span className="shrink-0 text-muted">{itemIcon(item)}</span>
        <span id={titleId} className="min-w-0 flex-1 truncate text-[13px] font-medium text-text">{item.title}</span>
        <span className="shrink-0 max-w-[45%] truncate text-[11px] text-muted">{item.appLabel}</span>
        <button
          ref={closeRef}
          className="shrink-0 p-1 rounded-md text-muted hover:text-text hover:bg-bg-hover"
          aria-label={i18nT('components.selectionActions.close')}
          title={i18nT('components.selectionActions.close')}
          onClick={close}
        >
          <X size={14} />
        </button>
      </div>
      {!selected ? (
        <div className="px-3 py-3 text-[13px] text-muted">{i18nT('components.selectionActions.too_short', { title: item.title })}</div>
      ) : (
        <div
          ref={boxRef}
          className={failed ? 'hidden' : ''}
          style={{ height: Math.min(item.maxHeight, frameHeight) }}
        />
      )}
      {failed && view?.notice && (
        <ErrorNotice
          variant="inline"
          className="mx-3 my-3"
          message={view.notice.kind === 'no_response'
            ? i18nT('components.selectionActions.no_response', { app: item.appLabel })
            : i18nT('components.selectionActions.failed', { app: item.appLabel, message: view.notice.message })}
        />
      )}
      {copyFailed && (
        <ErrorNotice variant="inline" className="mx-3 mb-2" message={i18nT('components.selectionActions.copy_failed')} onDismiss={() => setCopyFailed(false)} />
      )}
      {!failed && (view?.copy || view?.open) && (
        <div className="flex items-center justify-end gap-2 px-3 py-2 border-t border-border">
          {view?.open && (
            <Btn onClick={() => { if (view.open) window.open(view.open.href, '_blank', 'noopener,noreferrer') }}>
              <ExternalLink size={12} className="inline mr-1" />
              {i18nT('components.selectionActions.open', { host: view.open.hostname })}
            </Btn>
          )}
          {view?.copy && (
            <Btn primary onClick={() => { void onCopy() }}>
              {copied && <Check size={12} className="inline mr-1" />}
              {copied ? i18nT('components.selectionActions.copied') : i18nT('components.selectionActions.copy')}
            </Btn>
          )}
        </div>
      )}
    </div>
  )
}

function selectItems(d: unknown): ResolvedSelectionAction[] {
  const apps = Array.isArray(d) ? d : (d as { apps?: unknown[] })?.apps
  return resolveSelectionActions((apps as never[]) || [])
}

export default function SelectionActionLayer() {
  // The app list the link-preview layer reads too (one query, one cache entry).
  const { data } = useQuery({
    queryKey: ['apps'],
    queryFn: () => (typeof api?.listApps === 'function' ? api.listApps() : []),
    select: selectItems,
  })
  useEffect(() => { setSelectionActionItems(data ?? []) }, [data])
  // An app that went away (disabled, uninstalled, grant revoked) closes its open popover.
  const state = useSelectionLayerState()
  useEffect(() => {
    if (state.kind === 'item' && data && !data.some((i) => i.key === state.item.key && i.revision === state.item.revision)) {
      closeSelectionLayer()
    }
  }, [data, state])
  if (state.kind === 'none') return null
  return (
    <OverlayPortal>
      {state.kind === 'menu'
        ? <AppsMenu key={state.seq} items={state.items} source={state.source} text={state.text} anchor={state.anchor} />
        : <ItemPopover key={state.seq} item={state.item} source={state.source} text={state.text} anchor={state.anchor} />}
    </OverlayPortal>
  )
}
