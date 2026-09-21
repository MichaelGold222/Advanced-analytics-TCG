import { useMemo, useState } from 'react'
import { ClipboardPaste } from 'lucide-react'
import { parsePastedSales } from '../lib/pastesales'
import { money } from '../lib/format'

/**
 * Paste a card's sales in, for the cards no call can reach.
 *
 * Card Ladder keeps promos outside the collection the Parse wrapper reads, so
 * a promo answers "not found" even when given its own Card Ladder id, taken
 * from that site's own URL. For those cards this is not a fallback — it is the
 * only route, and a collection can be mostly promos.
 *
 * Nothing is committed until the person has seen what was read. A parser being
 * forgiving about shape is only safe if it is loud about what it understood,
 * so every line is shown as either a dated price or a reason it was skipped.
 */
export function PasteHistory({ name, onAdd }: { name: string; onAdd: (points: ReturnType<typeof parsePastedSales>['points']) => void }) {
  const [text, setText] = useState('')
  const [added, setAdded] = useState<number | null>(null)
  const result = useMemo(() => parsePastedSales(text), [text])

  const band = result.points.length > 0
    ? { low: Math.min(...result.points.map((p) => p.price)), high: Math.max(...result.points.map((p) => p.price)) }
    : null

  return (
    <div className="space-y-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide secondary flex items-center gap-2">
        <ClipboardPaste size={14} /> Paste sales history
      </h3>
      <p className="text-xs muted">
        For a card the API cannot reach — promos are not in the catalogue it reads, so no
        certificate, name or id will fetch them. Copy the sales from wherever you can see
        them and paste below: a date and a price per line, in any layout. Nothing is saved
        until you press the button.
      </p>
      <textarea
        className="w-full text-sm font-mono"
        rows={6}
        style={{ background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 6, padding: 8 }}
        placeholder={'Sep 19, 2026\t$525.00\nSep 18, 2026\t$568.00\n2026-09-16\t$462'}
        value={text}
        onChange={(e) => { setText(e.target.value); setAdded(null) }}
        aria-label={`Sales history to paste for ${name}`}
      />

      {text.trim() !== '' && (
        <div className="text-xs">
          <p className={result.accepted > 0 ? 'secondary' : ''} style={result.accepted === 0 ? { color: 'var(--serious)' } : undefined}>
            <strong>{result.accepted}</strong> dated price{result.accepted === 1 ? '' : 's'} read
            {result.rejected > 0 && <>, {result.rejected} line{result.rejected === 1 ? '' : 's'} skipped</>}
            {band && <> — {money(band.low)} to {money(band.high)}</>}
          </p>
          <ul className="mt-1 space-y-0.5 max-h-40 overflow-auto">
            {result.lines.map((l, i) => (
              <li key={i} className="tabular flex gap-2">
                {l.problem == null ? (
                  <><span className="secondary">{l.date}</span><span>{money(l.price!)}</span></>
                ) : (
                  <span className="muted">
                    skipped: {l.problem} — <span className="font-mono">{l.line.slice(0, 60)}</span>
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex items-center gap-2">
        <button
          type="button" className="btn btn-primary"
          disabled={result.accepted === 0}
          onClick={() => { onAdd(result.points); setAdded(result.accepted); setText('') }}
        >
          Add {result.accepted > 0 ? `${result.accepted} price${result.accepted === 1 ? '' : 's'}` : 'history'}
        </button>
        {added != null && (
          <span className="text-xs" style={{ color: 'var(--delta-up)' }}>
            {added} added — they count toward the high and low straight away.
          </span>
        )}
      </div>
    </div>
  )
}
