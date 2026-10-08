import { useState } from 'react'
import { Loader2, Plus } from 'lucide-react'

/**
 * Add a slab to holdings by typing its certificate number.
 *
 * The spreadsheet was the only way in, so buying a card meant editing a file
 * and re-importing it — and a re-import is a replace, so it also meant
 * re-exporting everything else. The certificate is the one thing printed on
 * the slab and the one key Alt indexes by, which makes it enough on its own:
 * the name, set, number, grade, population, photograph and the whole sale
 * history all come back from it in a single call.
 *
 * What it costs is on the button rather than in a footnote. A lookup is one
 * Alt call whatever else is going on, and a number nobody warned about is the
 * reason this project emptied its credit balance once already.
 */
export function AddBySlab({
  onAdd, busy, empty,
}: {
  onAdd: (input: { cert: string; quantity: number; costBasis: number; purchaseDate?: string }) => void
  busy: boolean
  empty: boolean
}) {
  const [cert, setCert] = useState('')
  const [paid, setPaid] = useState('')
  const [qty, setQty] = useState('1')
  const [bought, setBought] = useState('')

  function submit(e: React.FormEvent) {
    e.preventDefault()
    const number = cert.trim().replace(/\s+/g, '')
    if (!number || busy) return
    onAdd({
      cert: number,
      quantity: Math.max(1, Math.round(Number(qty) || 1)),
      costBasis: Number(paid.replace(/[^0-9.]/g, '')) || 0,
      purchaseDate: bought || undefined,
    })
    setCert('')
    setPaid('')
    setQty('1')
    setBought('')
  }

  return (
    <details className="card p-4" open={empty}>
      <summary className="text-sm font-semibold cursor-pointer select-none">
        Add a slab you own
        <span className="muted font-normal"> — the cert number is enough</span>
      </summary>
      <form onSubmit={submit} className="grid gap-2 sm:grid-cols-2 lg:grid-cols-6 mt-3">
        <input
          className="input lg:col-span-2" placeholder="Cert number *" required
          inputMode="numeric" value={cert}
          onChange={(e) => setCert(e.target.value)} aria-label="Certificate number"
        />
        <input
          className="input" type="number" step="0.01" min="0" placeholder="What you paid $"
          value={paid} onChange={(e) => setPaid(e.target.value)} aria-label="What you paid"
        />
        <input
          className="input" type="number" min="1" step="1" placeholder="Qty"
          value={qty} onChange={(e) => setQty(e.target.value)} aria-label="Quantity"
        />
        <input
          className="input" type="date" value={bought}
          onChange={(e) => setBought(e.target.value)} aria-label="Purchase date"
        />
        <button type="submit" className="btn btn-primary justify-center" disabled={busy || !cert.trim()}>
          {busy
            ? <><Loader2 className="size-4 animate-spin" aria-hidden /> Looking up…</>
            : <><Plus className="size-4" aria-hidden /> Add · 3 credits</>}
        </button>
      </form>
      <p className="text-xs muted mt-3">
        The grader, grade, set, number, population, photograph and every sale on record come back from
        the certificate, so the card lands already valued. Leave <strong>what you paid</strong> blank and
        the position still shows its market value — only the return needs a cost.
      </p>
    </details>
  )
}
