/** @vitest-environment happy-dom */
import { StrictMode, act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ImportResultBanner } from './ImportResultBanner'
import type { ImportLogEntry } from '../lib/store'

const render = (node: React.ReactNode) => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  act(() => { createRoot(host).render(<StrictMode>{node}</StrictMode>) })
  return host
}

afterEach(() => { document.body.innerHTML = '' })

/** A 90-row portfolio import, as the owner's actually was. */
const entry = (over: Partial<ImportLogEntry> = {}): ImportLogEntry => ({
  at: '2026-10-08T12:00:00Z',
  file: 'pokemon portfolio.xlsx',
  kind: 'portfolio',
  imported: 90,
  sheets: ['Portfolio'],
  mapped: {},
  unmappedHeaders: [],
  ignoredHeaders: [],
  routed: [{ sheet: 'Portfolio', to: 'holdings' }],
  issues: [],
  historyPoints: 0,
  placed: { holdings: Array.from({ length: 90 }, (_, i) => `h${i}`), watchlist: [] },
  totalAfter: { holdings: 90, watchlist: 0 },
  ...over,
})

const ids = (n: number) => Array.from({ length: n }, (_, i) => `h${i}`)

const banner = (e: ImportLogEntry, holdingIds: string[], watchCount = 0, onMove = vi.fn()) => ({
  host: render(
    <ImportResultBanner
      entry={e} holdingIds={holdingIds} watchCount={watchCount}
      onGoToWatchlist={() => {}} onGoToHoldings={() => {}}
      onMoveHoldingsToWatchlist={onMove}
    />,
  ),
  onMove,
})

describe('the import banner stops talking once it is out of date', () => {
  it('says where the rows went while the lists still match', () => {
    const { host } = banner(entry(), ids(90))
    expect(host.textContent).toContain('90 rows')
    expect(host.textContent).toContain('count toward portfolio value')
  })

  it('goes away once a slab is added by cert', () => {
    // Reported: "90 rows ... went to your holdings ... even though there's now
    // 91 in there". A true sentence about the import, read as a claim about
    // the list, with nothing to retire it.
    const { host } = banner(entry(), ids(91))
    expect(host.textContent).toBe('')
  })

  it('goes away once a row is deleted', () => {
    const { host } = banner(entry(), ids(89))
    expect(host.textContent).toBe('')
  })

  it('goes away once the watchlist changes', () => {
    const { host } = banner(entry(), ids(90), 3)
    expect(host.textContent).toBe('')
  })

  it('offers to move only the rows that import placed', () => {
    // The button moved every holding there was, so a row from an earlier
    // import — or a slab typed in since — went with them.
    const e = entry({
      imported: 3,
      placed: { holdings: ['h0', 'h1', 'h2'], watchlist: [] },
      totalAfter: { holdings: 3, watchlist: 0 },
    })
    const { host, onMove } = banner(e, ['h0', 'h1', 'h2'])
    const move = [...host.querySelectorAll('button')]
      .find((b) => b.textContent?.includes('move'))
    expect(move).toBeDefined()
    act(() => { move!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(onMove).toHaveBeenCalledWith(['h0', 'h1', 'h2'])
  })

  it('shows nothing for an entry saved before ids were recorded', () => {
    // migrate() gives those an empty list rather than leaving it absent, so
    // the banner treats them as having nothing to act on, not everything.
    const { host } = banner(entry({ placed: { holdings: [], watchlist: [] } }), ids(90))
    expect(host.textContent).toBe('')
  })
})
