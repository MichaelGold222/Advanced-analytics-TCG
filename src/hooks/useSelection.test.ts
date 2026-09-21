/** @vitest-environment happy-dom */
import { act, renderHook } from './testing'
import { describe, expect, it } from 'vitest'
import { useSelection } from './useSelection'

describe('ticking rows', () => {
  it('starts with nothing ticked', () => {
    const { result } = renderHook(() => useSelection(['a', 'b', 'c']))
    expect(result.current.count).toBe(0)
    expect(result.current.allSelected).toBe(false)
  })

  it('ticks and unticks one row', () => {
    const { result } = renderHook(() => useSelection(['a', 'b', 'c']))
    act(() => result.current.toggle('b'))
    expect(result.current.selected).toEqual(['b'])
    act(() => result.current.toggle('b'))
    expect(result.current.count).toBe(0)
  })

  it('returns them in the order they appear, not the order they were ticked', () => {
    const { result } = renderHook(() => useSelection(['a', 'b', 'c']))
    act(() => result.current.toggle('c'))
    act(() => result.current.toggle('a'))
    expect(result.current.selected).toEqual(['a', 'c'])
  })

  it('selects everything shown, then clears on a second press', () => {
    const { result } = renderHook(() => useSelection(['a', 'b', 'c']))
    act(() => result.current.toggleAll())
    expect(result.current.allSelected).toBe(true)
    act(() => result.current.toggleAll())
    expect(result.current.count).toBe(0)
  })

  it('reports a partial selection as partial, so the header box is not a lie', () => {
    const { result } = renderHook(() => useSelection(['a', 'b', 'c']))
    act(() => result.current.toggle('a'))
    expect(result.current.someSelected).toBe(true)
    expect(result.current.allSelected).toBe(false)
  })
})

describe('when the list underneath changes', () => {
  it('forgets a row that is no longer there', () => {
    // A ticked row can be deleted, filtered out, or replaced by a re-import.
    // Counting it would promise to act on something that no longer exists.
    const { result, rerender } = renderHook(({ ids }) => useSelection(ids), {
      initialProps: { ids: ['a', 'b', 'c'] },
    })
    act(() => result.current.toggleAll())
    expect(result.current.count).toBe(3)
    rerender({ ids: ['a', 'c'] })
    expect(result.current.selected).toEqual(['a', 'c'])
  })

  it('does not call a filtered-down list fully selected by accident', () => {
    const { result, rerender } = renderHook(({ ids }) => useSelection(ids), {
      initialProps: { ids: ['a', 'b', 'c'] },
    })
    act(() => result.current.toggle('a'))
    rerender({ ids: ['a'] })
    // Only 'a' is on screen and only 'a' is ticked, so that really is all of them.
    expect(result.current.allSelected).toBe(true)
    expect(result.current.someSelected).toBe(false)
  })

  it('has nothing selected when the list empties', () => {
    const { result, rerender } = renderHook(({ ids }) => useSelection(ids), {
      initialProps: { ids: ['a', 'b'] },
    })
    act(() => result.current.toggleAll())
    rerender({ ids: [] })
    expect(result.current.count).toBe(0)
    expect(result.current.allSelected).toBe(false)
  })
})
