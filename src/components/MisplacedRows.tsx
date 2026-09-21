import { useState } from 'react'
import { ArrowRight, X } from 'lucide-react'
import { money } from '../lib/format'
import type { Holding } from '../lib/types'

/**
 * An offer to move holdings that look like they belong on the watchlist.
 *
 * Every one of these rows counts toward the portfolio total, so leaving them
 * in place quietly overstates what the collection is worth. But a genuine
 * holding whose sheet simply had no cost column is indistinguishable from a
 * watch item from here, so nothing moves on its own: the rows are listed by
 * name, each one can be unticked, and the button says how many will go.
 *
 * It is dismissable and stays dismissed for the session, because a collection
 * really can contain cards whose cost was never recorded, and a banner that
 * cannot be silenced would follow that person forever.
 */
export function MisplacedRows({
  candidates,
  onMove,
}: {
  candidates: Holding[]
  onMove: (ids: string[]) => void
}) {
  const [dismissed, setDismissed] = useState(false)
  const [excluded, setExcluded] = useState<Set<string>>(new Set())

  if (dismissed || candidates.length === 0) return null

  const chosen = candidates.filter((h) => !excluded.has(h.id))
  const toggle = (id: string) => setExcluded((prev) => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })

  return (
    <section className="card p-4" style={{ borderColor: 'var(--warning)' }}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">
            {candidates.length} holding{candidates.length === 1 ? '' : 's'} with nothing paid and no purchase date
          </h2>
          <p className="text-xs secondary mt-1 leading-relaxed max-w-2xl">
            These count toward the portfolio total as though they were owned. If they were meant for the
            watchlist, move them — prices already fetched are keyed by card, not by tab, so nothing fetched
            is lost. If any of them are genuinely owned and their sheet just had no cost column, untick
            those and add the cost instead.
          </p>
        </div>
        <button
          type="button" className="btn px-2 py-1" onClick={() => setDismissed(true)}
          aria-label="Dismiss this notice"
        >
          <X className="size-3.5" aria-hidden />
        </button>
      </div>

      <ul className="mt-3 grid gap-1 sm:grid-cols-2 lg:grid-cols-3">
        {candidates.map((h) => (
          <li key={h.id}>
            <label className="flex items-baseline gap-2 text-sm cursor-pointer">
              <input
                type="checkbox" className="mt-0.5" checked={!excluded.has(h.id)}
                onChange={() => toggle(h.id)}
                aria-label={`Move ${h.name} to the watchlist`}
              />
              <span className="min-w-0">
                <span className="block truncate">{h.name}</span>
                <span className="block text-xs muted truncate">
                  {[h.set, h.condition, h.userPrice ? money(h.userPrice) : null].filter(Boolean).join(' · ') || '—'}
                </span>
              </span>
            </label>
          </li>
        ))}
      </ul>

      <div className="mt-3 flex items-center gap-2">
        <button
          type="button" className="btn btn-primary" disabled={chosen.length === 0}
          onClick={() => onMove(chosen.map((h) => h.id))}
        >
          Move {chosen.length} to the watchlist <ArrowRight className="size-3.5" aria-hidden />
        </button>
        {excluded.size > 0 && (
          <span className="text-xs muted">{excluded.size} kept in holdings</span>
        )}
      </div>
    </section>
  )
}
