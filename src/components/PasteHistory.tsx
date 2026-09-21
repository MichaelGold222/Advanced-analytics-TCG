import { useMemo, useState } from 'react'
import { ClipboardPaste, Link2 } from 'lucide-react'
import { parsePastedSales } from '../lib/pastesales'
import { cardIdFromUrl } from '../lib/providers/cardladder'
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
export function PasteHistory({ name, onAdd, onLink }: {
  name: string
  onAdd: (points: ReturnType<typeof parsePastedSales>['points']) => void
  /** Try a Card Ladder card id first; resolves to whether it worked. */
  onLink?: (cardId: string) => Promise<'fetched' | 'refused' | 'no-key'>
}) {
  const [text, setText] = useState('')
  const [added, setAdded] = useState<number | null>(null)
  const [url, setUrl] = useState('')
  const [linking, setLinking] = useState(false)
  const [linkResult, setLinkResult] = useState<'fetched' | 'refused' | 'no-key' | null>(null)
  const cardId = useMemo(() => cardIdFromUrl(url), [url])
  const result = useMemo(() => parsePastedSales(text), [text])

  const band = result.points.length > 0
    ? { low: Math.min(...result.points.map((p) => p.price)), high: Math.max(...result.points.map((p) => p.price)) }
    : null

  return (
    <div className="space-y-2">
      {onLink && (
        <div className="pb-3 mb-1" style={{ borderBottom: '1px solid var(--border)' }}>
          <h3 className="text-xs font-semibold uppercase tracking-wide secondary flex items-center gap-2 mb-2">
            <Link2 size={14} /> Try the Card Ladder link first
          </h3>
          <p className="text-xs muted mb-2">
            Its recent sales were found by certificate; the full history is kept against the
            card, and the certificate does not point at one. Open this card on Card Ladder and
            paste the page URL — the id is in the address, and one credit buys the whole
            history. Far less work than typing sales in.
          </p>
          <div className="flex flex-wrap gap-2 items-center">
            <input
              className="text-sm flex-1 min-w-[16rem]"
              style={{ background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 6, padding: '6px 8px' }}
              placeholder="https://app.cardladder.com/card/…"
              value={url}
              onChange={(e) => { setUrl(e.target.value); setLinkResult(null) }}
              aria-label={`Card Ladder URL for ${name}`}
            />
            <button
              type="button" className="btn"
              disabled={!cardId || linking}
              onClick={async () => {
                if (!cardId || !onLink) return
                setLinking(true)
                try { setLinkResult(await onLink(cardId)) } finally { setLinking(false) }
              }}
            >
              {linking ? 'Fetching…' : 'Fetch history (1 credit)'}
            </button>
          </div>
          {url.trim() !== '' && !cardId && (
            <p className="text-xs mt-1" style={{ color: 'var(--serious)' }}>
              No card id in that. It should look like app.cardladder.com/card/<em>aDzWNhB6…</em> —
              an internal hash will not work.
            </p>
          )}
          {linkResult === 'fetched' && (
            <p className="text-xs mt-1" style={{ color: 'var(--delta-up)' }}>
              Got it. The bands above are rebuilt from the full history — no pasting needed.
            </p>
          )}
          {linkResult === 'refused' && (
            <p className="text-xs mt-1" style={{ color: 'var(--serious)' }}>
              Card Ladder has no catalogue entry for that id, so its history cannot be fetched
              at any price. Paste the sales below instead — that always works.
            </p>
          )}
        </div>
      )}

      <h3 className="text-xs font-semibold uppercase tracking-wide secondary flex items-center gap-2">
        <ClipboardPaste size={14} /> Or paste the sales
      </h3>
      <p className="text-xs muted">
        Always works, costs nothing, and is the only route for a card with no catalogue
        entry. Copy the sales from wherever you can see them: a date and a price per line,
        in any layout. Nothing is saved until you press the button.
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
