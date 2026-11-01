/**
 * What the selection-action layer shows: nothing, the apps menu, or one item's popover.
 *
 * A selection toolbar writes here (`useAppSelectionActions`); the one mounted
 * `SelectionActionLayer` reads it. Opening anything replaces what was open, so at
 * most one invocation is ever live.
 *
 * @module selectionActions/selectionActionStore
 */
import { useSyncExternalStore } from 'react'
import type { ResolvedSelectionAction } from './selectionActionRegistry'
import type { SelectionSourceKind } from './selectionSources'

export interface Anchor {
  left: number
  top: number
  bottom: number
}

export type SelectionLayerState =
  | { kind: 'none' }
  | { kind: 'menu'; seq: number; items: ResolvedSelectionAction[]; source: SelectionSourceKind; text: string; anchor: Anchor }
  | { kind: 'item'; seq: number; item: ResolvedSelectionAction; source: SelectionSourceKind; text: string; anchor: Anchor }

let state: SelectionLayerState = { kind: 'none' }
let seq = 0
const listeners = new Set<() => void>()

// The approved items, published by the one mounted layer from the app list, so a
// chat reply reads them without a query of its own.
const NO_ITEMS: ResolvedSelectionAction[] = []
let items: ResolvedSelectionAction[] = NO_ITEMS
const itemListeners = new Set<() => void>()

export function setSelectionActionItems(next: ResolvedSelectionAction[]): void {
  if (next === items) return
  items = next.length ? next : NO_ITEMS
  itemListeners.forEach((l) => l())
}

export function useSelectionActionItems(): ResolvedSelectionAction[] {
  return useSyncExternalStore(
    (l) => { itemListeners.add(l); return () => { itemListeners.delete(l) } },
    () => items,
    () => items,
  )
}

function set(next: SelectionLayerState): void {
  state = next
  listeners.forEach((l) => l())
}

const anchorOf = (rect: DOMRect): Anchor => ({ left: rect.left, top: rect.top, bottom: rect.bottom })

export function openSelectionMenu(items: ResolvedSelectionAction[], source: SelectionSourceKind, text: string, rect: DOMRect): void {
  set({ kind: 'menu', seq: ++seq, items, source, text, anchor: anchorOf(rect) })
}

export function openSelectionItem(item: ResolvedSelectionAction, source: SelectionSourceKind, text: string, rect: DOMRect | Anchor): void {
  const anchor = rect instanceof DOMRect ? anchorOf(rect) : rect
  set({ kind: 'item', seq: ++seq, item, source, text, anchor })
}

export function closeSelectionLayer(): void {
  if (state.kind !== 'none') set({ kind: 'none' })
}

export function getSelectionLayerState(): SelectionLayerState {
  return state
}

export function useSelectionLayerState(): SelectionLayerState {
  return useSyncExternalStore(
    (l) => { listeners.add(l); return () => { listeners.delete(l) } },
    () => state,
    () => state,
  )
}
