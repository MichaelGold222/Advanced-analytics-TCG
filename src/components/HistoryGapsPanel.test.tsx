/** @vitest-environment happy-dom */
import { StrictMode, act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { HistoryGapsPanel } from './HistoryGapsPanel'
import { assessHistory } from '../lib/historygaps'
import type { PricePoint } from '../lib/types'

const NOW = new Date('2026-09-21T00:00:00Z')
const back = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString().slice(0, 10)
const sale = (d: number): PricePoint => ({ date: back(d), price: 1000, source: 'sale' })

const gap = (name: string, days: number[], fetched = back(30)) =>
  assessHistory(name, name, days.map(sale), undefined, fetched, NOW)

const render = (node: React.ReactNode) => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  act(() => { createRoot(host).render(<StrictMode>{node}</StrictMode>) })
  return host
}

afterEach(() => { document.body.innerHTML = '' })

describe('what the panel tells someone with 32 cards', () => {
  it('names the two problems apart, because they need different work', () => {
    const thin = gap('Thin', [200, 150, 100, 50])
    const fast = gap('Fast', [360, 200, 100, 4, 3, 2, 1, 0])
    const host = render(<HistoryGapsPanel gaps={[thin, fast]} total={32} />)
    expect(host.textContent).toContain('2 of 32')
    expect(host.textContent).toContain('too little history')
    expect(host.textContent).toContain('backfilling will not help it')
  })

  it('says how often a fast card has to be refreshed', () => {
    const host = render(<HistoryGapsPanel gaps={[gap('Pikachu', [6, 5, 3, 2, 0])]} total={32} />)
    expect(host.textContent).toMatch(/refresh every \d+d/)
  })

  it('stays quiet and says so when every card is fine', () => {
    const host = render(<HistoryGapsPanel gaps={[]} total={32} />)
    expect(host.textContent).toContain('All 32 cards have sales reaching back')
  })

  it('draws nothing at all before anything is imported', () => {
    const host = render(<HistoryGapsPanel gaps={[]} total={0} />)
    expect(host.innerHTML).toBe('')
  })

  it('warns that lost sales do not come back', () => {
    const host = render(<HistoryGapsPanel gaps={[gap('Pikachu', [6, 5, 3, 2, 0])]} total={32} />)
    expect(host.textContent).toContain('cannot be recovered later')
  })

  it('names the card, so the list can be worked through', () => {
    const host = render(<HistoryGapsPanel gaps={[gap('Playing in the Sea Pikachu', [6, 5, 3, 2, 0])]} total={32} />)
    expect(host.textContent).toContain('Playing in the Sea Pikachu')
  })
})
