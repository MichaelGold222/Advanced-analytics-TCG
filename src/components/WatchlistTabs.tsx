import { useState } from 'react'
import { Check, Pencil, Plus, Trash2, X } from 'lucide-react'
import { ALL_VIEW, type ListView } from '../lib/watchlists'

interface Props {
  names: string[]
  /** Cards per list name, plus '' for those on none. */
  counts: Map<string, number>
  total: number
  view: ListView
  onView: (v: ListView) => void
  onCreate: (name: string) => string | null
  onRename: (from: string, to: string) => string | null
  onDelete: (name: string, withCards: boolean) => void
}

/**
 * The row of lists above the watchlist.
 *
 * "All" stays first because the ranking is most useful across everything
 * being considered; a list narrows it. "Unsorted" appears only once there are
 * lists to be unsorted from, so someone who never makes one sees no change.
 */
export function WatchlistTabs({ names, counts, total, view, onView, onCreate, onRename, onDelete }: Props) {
  const [creating, setCreating] = useState(false)
  const [draft, setDraft] = useState('')
  const [renaming, setRenaming] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const unsorted = counts.get('') ?? 0
  const active = view.kind === 'list' ? view.name : null

  function create() {
    const made = onCreate(draft)
    if (made) onView({ kind: 'list', name: made })
    setDraft('')
    setCreating(false)
  }

  function rename(from: string) {
    const to = onRename(from, draft)
    if (to) onView({ kind: 'list', name: to })
    setDraft('')
    setRenaming(null)
  }

  const pill = (label: string, n: number, on: boolean, click: () => void) => (
    <button
      key={label} type="button" onClick={click} aria-pressed={on}
      className="btn py-1"
      style={on ? { borderColor: 'var(--seq-450)', background: 'var(--surface-2)', fontWeight: 600 } : undefined}
    >
      {label} <span className="muted tabular font-normal">{n}</span>
    </button>
  )

  return (
    <div className="card p-3 space-y-2">
      <div className="flex flex-wrap items-center gap-2" role="toolbar" aria-label="Watchlists">
        {pill('All', total, view.kind === 'all', () => onView(ALL_VIEW))}
        {names.map((n) => pill(n, counts.get(n) ?? 0, active === n, () => onView({ kind: 'list', name: n })))}
        {names.length > 0 && unsorted > 0 &&
          pill('Unsorted', unsorted, view.kind === 'unsorted', () => onView({ kind: 'unsorted' }))}
        {creating ? (
          <form className="flex gap-1" onSubmit={(e) => { e.preventDefault(); create() }}>
            <input
              className="input py-1 w-44" autoFocus placeholder="List name, e.g. Vintage grails"
              value={draft} onChange={(e) => setDraft(e.target.value)} aria-label="New list name"
            />
            <button type="submit" className="btn py-1 px-2" aria-label="Create list" disabled={!draft.trim()}>
              <Check className="size-3.5" aria-hidden />
            </button>
            <button type="button" className="btn py-1 px-2" aria-label="Cancel" onClick={() => { setCreating(false); setDraft('') }}>
              <X className="size-3.5" aria-hidden />
            </button>
          </form>
        ) : (
          <button type="button" className="btn py-1" onClick={() => { setCreating(true); setDraft('') }}>
            <Plus className="size-3.5" aria-hidden /> New list
          </button>
        )}
      </div>

      {active && (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          {renaming === active ? (
            <form className="flex gap-1" onSubmit={(e) => { e.preventDefault(); rename(active) }}>
              <input
                className="input py-1 w-44" autoFocus value={draft}
                onChange={(e) => setDraft(e.target.value)} aria-label="New name for this list"
              />
              <button type="submit" className="btn py-1 px-2" aria-label="Save name" disabled={!draft.trim()}>
                <Check className="size-3.5" aria-hidden />
              </button>
              <button type="button" className="btn py-1 px-2" aria-label="Cancel" onClick={() => setRenaming(null)}>
                <X className="size-3.5" aria-hidden />
              </button>
            </form>
          ) : confirmDelete === active ? (
            <>
              <span className="secondary">Delete &ldquo;{active}&rdquo;?</span>
              <button type="button" className="btn py-1" onClick={() => { onDelete(active, false); setConfirmDelete(null); onView(ALL_VIEW) }}>
                Delete the list, keep its {counts.get(active) ?? 0} cards
              </button>
              {(counts.get(active) ?? 0) > 0 && (
                <button
                  type="button" className="btn py-1"
                  style={{ borderColor: 'var(--critical)', color: 'var(--critical)' }}
                  onClick={() => { onDelete(active, true); setConfirmDelete(null); onView(ALL_VIEW) }}
                >
                  Delete the list and its cards
                </button>
              )}
              <button type="button" className="btn py-1" onClick={() => setConfirmDelete(null)}>Cancel</button>
            </>
          ) : (
            <>
              <span className="muted">New cards and uploads here go on &ldquo;{active}&rdquo;.</span>
              <button type="button" className="btn py-1" onClick={() => { setRenaming(active); setDraft(active) }}>
                <Pencil className="size-3" aria-hidden /> Rename
              </button>
              <button type="button" className="btn py-1" onClick={() => setConfirmDelete(active)}>
                <Trash2 className="size-3" aria-hidden /> Delete list
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}

/** The "Move to…" control for the selection bar. */
export function MoveToList({ names, onMove }: { names: string[]; onMove: (list: string | null) => void }) {
  return (
    <select
      className="input py-1 w-auto" value="" aria-label="Move the selected cards to a list"
      onChange={(e) => {
        const v = e.target.value
        if (!v) return
        if (v === '\u0000new') {
          const name = window.prompt('Name for the new list')?.trim()
          if (name) onMove(name)
        } else onMove(v === '\u0000none' ? null : v)
      }}
    >
      <option value="">Move to list…</option>
      {names.map((n) => <option key={n} value={n}>{n}</option>)}
      <option value={'\u0000new'}>New list…</option>
      {names.length > 0 && <option value={'\u0000none'}>No list (unsorted)</option>}
    </select>
  )
}
