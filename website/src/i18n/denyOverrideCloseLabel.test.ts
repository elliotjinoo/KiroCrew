/**
 * "Allow for this session" names its end by the session menu's own Close label.
 *
 * Every `components.denyOverride.session.*` row ends "until you close this chat
 * (<Close session>) or {{productName}} restarts", where the parenthesised text
 * is the `components.sessionActionsMenu.close_session` label the person clicks
 * to end the session. If either string is reworded alone, the row would point
 * at a control that is not on screen; this guard keeps the two in step in every
 * authored locale.
 */
import { describe, it, expect } from 'vitest'

import { CATALOGS } from './catalogs'

function resolve(catalog: Record<string, unknown>, dotted: string): unknown {
  let node: unknown = catalog
  for (const part of dotted.split('.')) {
    if (typeof node !== 'object' || node === null) return undefined
    node = (node as Record<string, unknown>)[part]
  }
  return node
}

describe('deny override session rows quote the Close session label', () => {
  it('every session row in every locale contains the menu label once, in parentheses', () => {
    for (const [lang, catalog] of Object.entries(CATALOGS)) {
      if (lang === 'en-XA') continue
      const label = resolve(catalog.translation, 'components.sessionActionsMenu.close_session')
      expect(typeof label, `${lang} close_session`).toBe('string')
      const rows = resolve(catalog.translation, 'components.denyOverride.session') as Record<string, string>
      expect(Object.keys(rows).length, `${lang} session rows`).toBe(13)
      for (const [key, value] of Object.entries(rows)) {
        const quoted = new RegExp(`[(（]${(label as string).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[)）]`, 'g')
        expect(value.match(quoted)?.length ?? 0, `${lang} session.${key}: ${value}`).toBe(1)
      }
    }
  })
})
