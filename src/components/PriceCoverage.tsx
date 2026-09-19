import { Info } from 'lucide-react'
import { holdingKey } from '../lib/portfolio'
import { itemKey } from '../lib/key'
import type { Holding, ItemAnalysis, WatchItem } from '../lib/types'
import type { RefreshState } from '../lib/store'

interface Props {
  holdings: Holding[]
  watchlist: WatchItem[]
  holdingAnalyses: Map<string, ItemAnalysis>
  watchAnalyses: Map<string, ItemAnalysis>
  lastRefresh: string | null
  /** True when the site shipped a sold-comp feed. */
  hasFeed: boolean
  refresh: RefreshState
  onRefresh: () => void
  onGoToData: () => void
}

/**
 * Says why items have no value, in specifics.
 *
 * "No data" on a row is not an explanation. Each cause has a different fix, so
 * each one is counted separately and named with the action that resolves it.
 */
export function PriceCoverage({
  holdings, watchlist, holdingAnalyses, watchAnalyses, lastRefresh, hasFeed, refresh, onRefresh, onGoToData,
}: Props) {
  const items: { graded: boolean; sealed: boolean; a?: ItemAnalysis }[] = [
    ...holdings.map((h) => ({ graded: h.grade != null, sealed: h.segment === 'sealed', a: holdingAnalyses.get(holdingKey(h)) })),
    ...watchlist.map((w) => ({ graded: w.grade != null, sealed: w.segment === 'sealed', a: watchAnalyses.get(itemKey(w)) })),
  ]

  const unvalued = items.filter((i) => i.a?.fmv.fmv == null)
  if (unvalued.length === 0) return null

  const gradedRaw = unvalued.filter((i) => i.graded && i.a?.quoteExcluded).length
  const gradedNoQuote = unvalued.filter((i) => i.graded && !i.a?.quoteExcluded).length
  const sealed = unvalued.filter((i) => i.sealed && !i.graded).length
  const other = unvalued.length - gradedRaw - gradedNoQuote - sealed

  const causes: { text: string; fix: string }[] = []

  // A refresh prices raw singles. Suggesting one is only useful when something
  // unvalued is actually a raw single — not when the rest is sealed product,
  // which that lookup has never been able to price.
  const fixableByRefresh = unvalued.filter((i) => !i.sealed && !i.graded).length
  if (!lastRefresh && !refresh.running && fixableByRefresh > 0) {
    causes.push({
      text: `${fixableByRefresh} ungraded single${fixableByRefresh === 1 ? '' : 's'} ${fixableByRefresh === 1 ? 'has' : 'have'} no price yet.`,
      fix: 'Click Refresh prices above. If nothing changes, the network call is being blocked — see the note below.',
    })
  }
  if (gradedRaw > 0) {
    causes.push({
      text: `${gradedRaw} graded ${gradedRaw === 1 ? 'card is' : 'cards are'} showing a raw-card price only.`,
      fix: 'The price API quotes ungraded copies, and a slab is worth a different amount. Add your own sold comps at that grade — a Price History sheet, or date-headed columns — and these value properly.',
    })
  }
  if (gradedNoQuote > 0) {
    causes.push({
      text: `${gradedNoQuote} graded ${gradedNoQuote === 1 ? 'card has' : 'cards have'} no sold comps.`,
      fix: hasFeed
        ? 'Add their certificate numbers to your sheet and to the PORTFOLIO_CERTS secret, and the daily fetch will price them.'
        : 'Graded cards are priced from sold comps. Import your own, or set up the automatic feed.',
    })
  }
  if (sealed > 0) {
    causes.push({
      text: `${sealed} sealed ${sealed === 1 ? 'product' : 'products'} cannot be priced.`,
      fix: 'The price API covers singles only. Sealed needs your own comps, or a provider that covers it.',
    })
  }
  if (other > 0) {
    causes.push({
      text: `${other} other ${other === 1 ? 'item has' : 'items have'} no price on record.`,
      fix: 'Add a Market Value column, a Price History sheet, or refresh prices.',
    })
  }
  if (refresh.errors.length > 0) {
    causes.push({
      text: `${refresh.errors.length} lookup${refresh.errors.length === 1 ? '' : 's'} failed on the last refresh.`,
      fix: 'Open Data & settings to see each one. Repeated failures usually mean the price API is unreachable from here.',
    })
  }

  return (
    <section className="card p-4" style={{ borderColor: 'var(--border-strong)' }}>
      <h2 className="text-sm font-semibold flex items-center gap-2">
        <Info className="size-4 shrink-0" style={{ color: 'var(--serious)' }} aria-hidden />
        {unvalued.length} of {items.length} items have no fair market value yet
      </h2>
      <ul className="mt-3 space-y-2.5">
        {causes.map((c) => (
          <li key={c.text} className="text-sm leading-relaxed">
            <span className="font-medium">{c.text}</span>{' '}
            <span className="secondary">{c.fix}</span>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-2 mt-4">
        <button type="button" className="btn" onClick={onRefresh} disabled={refresh.running}>
          {refresh.running ? `Refreshing ${refresh.done}/${refresh.total}…` : 'Refresh prices'}
        </button>
        <button type="button" className="btn" onClick={onGoToData}>Import comps or a template</button>
      </div>
      <p className="text-xs muted mt-3 leading-relaxed">
        {hasFeed
          ? 'Graded cards are priced from sold comps fetched daily and published with this site. Refreshing prices covers ungraded singles only, from your browser.'
          : 'Price lookups go from your browser straight to the Pokémon TCG API. If every lookup fails, that page is being blocked from reaching it — running the app from a downloaded copy of the .html file avoids that.'}
      </p>
    </section>
  )
}
