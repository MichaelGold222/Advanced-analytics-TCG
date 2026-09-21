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
  onGoToWatchlist,
  onGoToHoldings,
  onMoveHoldingsToWatchlist,
}: {
  entry?: ImportLogEntry
  onGoToWatchlist: () => void
  onGoToHoldings: () => void
  /** Move everything that import put in holdings over to the watchlist. */
  onMoveHoldingsToWatchlist: () => void
}) {
  const [dismissed, setDismissed] = useState<string | null>(null)

  if (!entry || dismissed === entry.at) return null
  const routed = entry.routed ?? []
  if (routed.length === 0) return null

  const toHoldings = routed.filter((r) => r.to === 'holdings')
  const toWatchlist = routed.filter((r) => r.to === 'watchlist')

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

      {toHoldings.length > 0 && (
        <button type="button" className="btn" onClick={onMoveHoldingsToWatchlist}>
          Not owned — move to the watchlist <ArrowRight className="size-3.5" aria-hidden />
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
