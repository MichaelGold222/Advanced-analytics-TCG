import { useState } from 'react'
import { ArrowRight, X } from 'lucide-react'
import type { ImportLogEntry } from '../lib/store'

/**
 * Where the last import actually went, said where it happened.
 *
 * Four separate reports of "my watchlist went into holdings" took four rounds
 * to resolve, and every one of them was slow for the same reason: the app made
 * a routing decision and said nothing about it. The rows appeared somewhere,
 * and the only way to find out where was to go looking.
 *
 * So the decision is now stated the moment it is made, in the destination's own
 * words, with the way to correct it right beside it. The fix for a wrong
 * routing should be a button, not a bug report.
 */
export function ImportResultBanner({
  entry,
  holdingIds,
  watchCount,
  onGoToWatchlist,
  onGoToHoldings,
  onMoveHoldingsToWatchlist,
}: {
  entry?: ImportLogEntry
  /** The ids holdings currently carries, to tell what is left of the import. */
  holdingIds: string[]
  /** How many rows the watchlist carries now, for the same reason. */
  watchCount: number
  onGoToWatchlist: () => void
  onGoToHoldings: () => void
  /** Move the rows THIS import put in holdings over to the watchlist. */
  onMoveHoldingsToWatchlist: (ids: string[]) => void
}) {
  const [dismissed, setDismissed] = useState<string | null>(null)

  if (!entry || dismissed === entry.at) return null
  const routed = entry.routed ?? []
  if (routed.length === 0) return null

  const toHoldings = routed.filter((r) => r.to === 'holdings')
  const toWatchlist = routed.filter((r) => r.to === 'watchlist')

  // What is actually left of this import. A row can have been deleted, moved,
  // or replaced by a re-import since, and an offer to move rows that are no
  // longer there is an offer to do nothing.
  const present = new Set(holdingIds)
  const mine = (entry.placed?.holdings ?? []).filter((id) => present.has(id))
  // Reported: "90 rows went to your holdings ... even though there's now 91 in
  // there". The sentence was a true statement about an import being read as a
  // claim about the list, and nothing retired it when the list moved on. Once
  // none of the import's own rows remain in holdings there is nothing left to
  // say or to correct, so it goes.
  if (toHoldings.length > 0 && toWatchlist.length === 0 && mine.length === 0) return null
  // And it goes once either list has changed since, by any route — a slab typed
  // in by cert, a deletion, rows moved to the watchlist. The banner describes
  // the moment after an import; past that moment it is only in the way.
  const after = entry.totalAfter
  if (after && (after.holdings !== holdingIds.length || after.watchlist !== watchCount)) return null

  return (
    <section
      className="card p-3 flex flex-wrap items-center gap-x-3 gap-y-2"
      style={{ borderColor: 'var(--seq-450)' }}
      role="status"
    >
      <span className="text-sm">
        <strong>{entry.imported} row{entry.imported === 1 ? '' : 's'}</strong> from {entry.file} went to{' '}
        {toHoldings.length > 0 && toWatchlist.length > 0
          ? 'both lists'
          : toHoldings.length > 0
            ? 'your holdings, where they count toward portfolio value'
            : 'your watchlist, where nothing is counted as owned'}
        {routed.length > 1 && (
          <span className="muted">
            {' '}({routed.map((r) => `“${r.sheet}” → ${r.to}`).join(', ')})
          </span>
        )}
      </span>

      <span className="flex-1" />

      {toHoldings.length > 0 && mine.length > 0 && (
        <button type="button" className="btn" onClick={() => onMoveHoldingsToWatchlist(mine)}>
          Not owned — move {mine.length === entry.imported ? 'them' : `those ${mine.length}`} to the
          watchlist <ArrowRight className="size-3.5" aria-hidden />
        </button>
      )}
      <button
        type="button" className="btn"
        onClick={toHoldings.length > 0 ? onGoToHoldings : onGoToWatchlist}
      >
        Show me
      </button>
      <button
        type="button" className="btn px-2" onClick={() => setDismissed(entry.at)}
        aria-label="Dismiss"
      >
        <X className="size-3.5" aria-hidden />
      </button>
    </section>
  )
}
