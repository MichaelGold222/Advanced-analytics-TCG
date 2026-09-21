import { AlertTriangle, Clock, History } from 'lucide-react'
import type { HistoryGap } from '../lib/historygaps'

/**
 * Which cards' numbers cannot be trusted yet, worst first.
 *
 * The owner asked a simple thing — "I just want the numbers to be accurate" —
 * and had no way to find out which ones were not. The honest answer has two
 * halves that need different work, so they are labelled apart rather than
 * merged into one warning:
 *
 *   thin    the record does not reach back a year, so the "yearly" high is
 *           the high of however many days it does reach. Fixed once, by
 *           getting history in.
 *   fast    the card sells more often than a fetch can carry, so sales are
 *           being lost for good between refreshes. Backfilling does nothing
 *           for this one; only refreshing more often does, and a card can be
 *           perfectly covered today and drifting from tomorrow.
 *
 * Ordered by severity because the point is to turn "thirty-two cards, unknown
 * effort" into a short list with the worst at the top. A card that is fine is
 * simply absent.
 */
export function HistoryGapsPanel({ gaps, total }: { gaps: HistoryGap[]; total: number }) {
  if (total === 0) return null

  if (gaps.length === 0) {
    return (
      <section className="card p-4">
        <h2 className="text-sm font-semibold mb-2 flex items-center gap-2">
          <History size={15} /> History coverage
        </h2>
        <p className="text-sm secondary">
          All {total} card{total === 1 ? '' : 's'} have sales reaching back far enough to
          read a yearly high from, and none is trading faster than it is being refreshed.
        </p>
      </section>
    )
  }

  const thin = gaps.filter((g) => g.kind === 'shallow' || g.kind === 'both').length
  const fast = gaps.filter((g) => g.kind === 'outpaced' || g.kind === 'both').length

  return (
    <section className="card p-4">
      <h2 className="text-sm font-semibold mb-1 flex items-center gap-2">
        <AlertTriangle size={15} /> Cards whose numbers are not trustworthy yet
      </h2>
      <p className="text-sm secondary mb-3">
        {gaps.length} of {total}. {thin > 0 && (
          <><strong>{thin}</strong> {thin === 1 ? 'has' : 'have'} too little history to
          have a real yearly high — that is fixed once, by getting the sales in. </>
        )}
        {fast > 0 && (
          <><strong>{fast}</strong> {fast === 1 ? 'trades' : 'trade'} faster than a fetch
          can keep up with, so sales are being lost between refreshes — that is fixed by
          refreshing more often, and backfilling will not help it.</>
        )}
      </p>

      <ul className="space-y-2">
        {gaps.map((g) => (
          <li key={g.key} className="text-sm border-t pt-2" style={{ borderColor: 'var(--border)' }}>
            <div className="flex items-baseline justify-between gap-3">
              <span className="font-medium">{g.name}</span>
              <span className="text-[11px] tabular muted whitespace-nowrap flex items-center gap-2">
                {(g.kind === 'shallow' || g.kind === 'both') && (
                  <span>{Math.round(g.reachDays)}d of history</span>
                )}
                {(g.kind === 'outpaced' || g.kind === 'both') && g.safeRefreshDays != null && (
                  <span className="flex items-center gap-1">
                    <Clock size={11} /> refresh every {Math.max(1, Math.round(g.safeRefreshDays))}d
                  </span>
                )}
              </span>
            </div>
            <p className="text-xs secondary mt-0.5">{g.reason}</p>
          </li>
        ))}
      </ul>

      <p className="text-xs muted mt-3">
        Sales lost between refreshes cannot be recovered later — the feed returns only the
        newest few per slab, so anything that scrolled off is gone. A refresh costs about
        three credits for the whole collection, however many cards are in it.
      </p>
    </section>
  )
}
