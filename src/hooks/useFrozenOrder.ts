import { useCallback, useMemo, useRef, useState } from 'react'
import type { FocusEvent } from 'react'

/**
 * Holds a sorted list still while someone is typing in it.
 *
 * The watchlist is ordered by how good a buy each card looks, and the asking
 * price is one of the things that decides that — so editing an asking price
 * re-ranks the row under the cursor. Typing a single digit moved a row eleven
 * places down the page: the field kept focus, but it was no longer where the
 * person was looking, and the next keystroke went somewhere they had not
 * chosen to be. Sorting a list by a value the list itself lets you edit needs
 * this or it fights whoever is using it.
 *
 * The order is frozen the moment focus lands inside, and released when focus
 * leaves altogether — not when it moves between fields, which would re-sort
 * between two keystrokes of the same edit. Everything else stays live: the
 * scores and verdicts update as they are typed, only the row's position waits.
 */
export function useFrozenOrder<T>(items: T[], idOf: (item: T) => string) {
  const [frozen, setFrozen] = useState<string[] | null>(null)
  const container = useRef<HTMLElement | null>(null)
  const setContainer = useCallback((el: HTMLElement | null) => { container.current = el }, [])

  const order = useMemo(() => {
    if (!frozen) return items
    const at = new Map(frozen.map((id, i) => [id, i]))
    // Anything new since the freeze goes to the back rather than vanishing.
    return [...items].sort((a, b) => (at.get(idOf(a)) ?? Infinity) - (at.get(idOf(b)) ?? Infinity))
  }, [items, frozen, idOf])

  const onFocus = useCallback(() => {
    // Only the first focus freezes; later ones must not re-snapshot an order
    // that is already being held, or a tab between fields would re-sort.
    setFrozen((prev) => prev ?? items.map(idOf))
  }, [items, idOf])

  const onBlur = useCallback((e: FocusEvent<HTMLElement>) => {
    const next = e.relatedTarget as Node | null
    if (next && container.current?.contains(next)) return
    setFrozen(null)
  }, [])

  return {
    order,
    frozen: frozen != null,
    /** Spread onto the element that wraps the sorted rows. */
    holdProps: { ref: setContainer, onFocus, onBlur },
  }
}
