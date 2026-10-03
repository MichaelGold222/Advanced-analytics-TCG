import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('idb-keyval', () => ({
  get: vi.fn(async () => undefined),
  set: vi.fn(async () => undefined),
  del: vi.fn(async () => undefined),
}))

import { useStore } from './store'
import { inView } from './watchlists'

const csv = (rows: string) => new File([`Name,Asking Price\n${rows}`], 'list.csv', { type: 'text/csv' })
const names = () => useStore.getState().watchlist.map((w) => `${w.name}:${w.list ?? '-'}`).sort()

beforeEach(() => {
  useStore.setState({ watchlist: [], watchlistNames: [], holdings: [] })
})

describe('named watchlists', () => {
  it('creates a list once, whatever the capitalisation', () => {
    const s = useStore.getState()
    expect(s.createWatchlist('  Grails ')).toBe('Grails')
    expect(s.createWatchlist('grails')).toBe('Grails')
    expect(s.createWatchlist('   ')).toBeNull()
    expect(useStore.getState().watchlistNames).toEqual(['Grails'])
  })

  it('adds a typed-in card to the list it was added from', () => {
    useStore.getState().addWatchItem({ name: 'Lugia', list: 'Grails' } as never)
    expect(names()).toEqual(['Lugia:Grails'])
  })

  it('uploads into one list without touching the others', async () => {
    const s = useStore.getState()
    await s.importFile(csv('Old A,10\nOld B,20'), 'watchlist', 'replace', 'Grails')
    await s.importFile(csv('Other,30'), 'watchlist', 'replace', 'Modern')
    await s.importFile(csv('Loose,40'), 'watchlist', 'replace')
    await s.importFile(csv('New A,50'), 'watchlist', 'replace', 'Grails')
    expect(names()).toEqual(['Loose:-', 'New A:Grails', 'Other:Modern'])
  })

  it('moves cards between lists, and off every list', () => {
    const s = useStore.getState()
    s.addWatchItem({ name: 'Mew' } as never)
    const id = useStore.getState().watchlist[0].id
    s.moveWatchItems([id], 'Promos')
    expect(names()).toEqual(['Mew:Promos'])
    expect(useStore.getState().watchlistNames).toEqual(['Promos'])
    s.moveWatchItems([id], null)
    expect(names()).toEqual(['Mew:-'])
  })

  it('renames a list and carries its cards', () => {
    const s = useStore.getState()
    s.createWatchlist('Grails')
    s.createWatchlist('Modern')
    s.addWatchItem({ name: 'Lugia', list: 'Grails' } as never)
    expect(s.renameWatchlist('Grails', 'modern')).toBeNull()
    expect(s.renameWatchlist('Grails', 'Vintage')).toBe('Vintage')
    expect(names()).toEqual(['Lugia:Vintage'])
    expect(useStore.getState().watchlistNames).toEqual(['Vintage', 'Modern'])
  })

  it('deleting a list keeps its cards unless asked otherwise', () => {
    const s = useStore.getState()
    s.addWatchItem({ name: 'Kept', list: 'A' } as never)
    s.addWatchItem({ name: 'Gone', list: 'B' } as never)
    useStore.setState({ watchlistNames: ['A', 'B'] })
    s.deleteWatchlist('A')
    s.deleteWatchlist('B', true)
    expect(names()).toEqual(['Kept:-'])
    expect(useStore.getState().watchlistNames).toEqual([])
  })
})

describe('inView', () => {
  it('filters by list, unsorted, or everything', () => {
    expect(inView('A', { kind: 'all' })).toBe(true)
    expect(inView(undefined, { kind: 'unsorted' })).toBe(true)
    expect(inView('A', { kind: 'unsorted' })).toBe(false)
    expect(inView('A', { kind: 'list', name: 'A' })).toBe(true)
    expect(inView('B', { kind: 'list', name: 'A' })).toBe(false)
  })
})
