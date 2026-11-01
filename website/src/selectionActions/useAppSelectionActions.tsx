/**
 * The app items a selection toolbar offers for one typed source.
 *
 * Up to two approved items are their own buttons, labelled with the item's title
 * and attributed to the app in the hint. More than two collapse into one **Apps**
 * button that opens the host's menu. A click hands the text the toolbar already
 * snapshotted to the layer; nothing here reads the document's selection. The
 * items come from the store the mounted `SelectionActionLayer` keeps current.
 *
 * @module selectionActions/useAppSelectionActions
 */
import { Blocks } from 'lucide-react'
import AppIcon from '../components/AppIcon'
import type { SelectionAction } from '../components/SelectionToolbar'
import { i18nT } from '../i18n/t'
import type { ResolvedSelectionAction } from './selectionActionRegistry'
import { openSelectionItem, openSelectionMenu, useSelectionActionItems } from './selectionActionStore'
import type { SelectionSourceKind } from './selectionSources'

/** At most this many items get their own button; more share one Apps button. */
export const MAX_INLINE_ITEMS = 2

export function itemIcon(item: ResolvedSelectionAction) {
  return item.icon ? <AppIcon icon={item.icon} size={12} /> : <Blocks size={12} />
}

/** Toolbar actions for the approved app items on `source` (empty when there are none). */
export function useAppSelectionActions(source: SelectionSourceKind): SelectionAction[] {
  const all = useSelectionActionItems()
  const items = all.filter((i) => i.sources.has(source))
  if (!items.length) return []
  if (items.length > MAX_INLINE_ITEMS) {
    return [{
      id: 'app-items',
      icon: <Blocks size={12} />,
      label: i18nT('components.selectionActions.apps'),
      hint: i18nT('components.selectionActions.apps_hint'),
      onClick: (text, rect) => openSelectionMenu(items, source, text, rect),
    }]
  }
  return items.map((item) => ({
    id: `app:${item.key}`,
    icon: itemIcon(item),
    label: item.title,
    hint: i18nT('components.selectionActions.item_hint', { app: item.appLabel }),
    onClick: (text, rect) => openSelectionItem(item, source, text, rect),
  }))
}
