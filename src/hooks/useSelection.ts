import { useCallback, useMemo, useState } from 'react'

/**
 * Ticked rows, kept honest as the list beneath them changes.
 *
 * The selection is derived against the ids currently on screen rather than
 * trusted as stored. A row can leave while ticked — deleted, filtered out,
 * replaced by a re-import — and a set holding ids that no longer exist makes
 * the count lie and an action operate on nothing. Intersecting on read means
 * the number on the bar is always the number of rows that would actually go.
 */
export function useSelection(ids: string[]) {
  const [ticked, setTicked] = useState<Set<string>>(new Set())

  const present = useMemo(() => new Set(ids), [ids])
  const selected = useMemo(
    () => ids.filter((id) => ticked.has(id)),
    [ids, ticked],
  )

  const toggle = useCallback((id: string) => {
    setTicked((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const clear = useCallback(() => setTicked(new Set()), [])

  /** Tick everything on screen, or clear if it is all ticked already. */
  const toggleAll = useCallback(() => {
    setTicked((prev) => {
      const all = ids.every((id) => prev.has(id))
      if (all) return new Set<string>()
      return new Set(ids)
    })
  }, [ids])

  // Dropping absent ids as they go keeps the set from growing without limit
  // across a long session of imports and deletions.
  const isSelected = useCallback((id: string) => ticked.has(id) && present.has(id), [ticked, present])

  return {
    selected,
    count: selected.length,
    allSelected: ids.length > 0 && selected.length === ids.length,
    someSelected: selected.length > 0 && selected.length < ids.length,
    isSelected,
    toggle,
    toggleAll,
    clear,
  }
}
