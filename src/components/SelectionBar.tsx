import { type ReactNode, useState } from 'react'
import { Trash2, X } from 'lucide-react'

/**
 * What to do with the rows that are ticked.
 *
 * Appears only when something is selected, and says the count in the button
 * rather than only in the bar, because "Delete" and "Delete 34" are different
 * promises and the second is the one being made.
 *
 * Deleting asks first. It cannot be undone, the rows were typed in or imported
 * by hand, and a mis-click on a select-all would otherwise take a whole
 * collection.
 *
 * What was agreed to is remembered as the selection it was agreed for, not as
 * a flag. A flag reset on the count would leave a confirmation armed when one
 * row was unticked and another ticked in its place — same number, different
 * cards, and an agreement that no longer refers to anything the person looked
 * at.
 */
export function SelectionBar({
  selected,
  noun,
  onDelete,
  onClear,
  children,
}: {
  /** The ids that would be acted on, in the order they appear. */
  selected: string[]
  /** Singular noun for the rows, e.g. "holding". */
  noun: string
  onDelete: () => void
  onClear: () => void
  /** Any other action for the selection, e.g. moving to another list. */
  children?: ReactNode
}) {
  const [armedFor, setArmedFor] = useState<string | null>(null)

  const count = selected.length
  const token = selected.join('|')
  const armed = armedFor === token

  if (count === 0) return null
  const plural = count === 1 ? noun : `${noun}s`

  return (
    <div
      className="card p-3 flex flex-wrap items-center gap-2"
      style={{ borderColor: 'var(--seq-450)' }}
      role="status"
    >
      <span className="text-sm font-medium">{count} {plural} selected</span>
      <span className="flex-1" />
      {children}
      {armed ? (
        <>
          <button
            type="button" className="btn"
            style={{ borderColor: 'var(--critical)', color: 'var(--critical)' }}
            onClick={() => { onDelete(); setArmedFor(null) }}
          >
            Yes, delete {count} {plural}
          </button>
          <button type="button" className="btn" onClick={() => setArmedFor(null)}>Cancel</button>
        </>
      ) : (
        <button type="button" className="btn" onClick={() => setArmedFor(token)}>
          <Trash2 className="size-4" aria-hidden /> Delete {count}
        </button>
      )}
      <button type="button" className="btn px-2" onClick={onClear} aria-label="Clear the selection">
        <X className="size-3.5" aria-hidden />
      </button>
    </div>
  )
}

/**
 * A tick box for one row, or for a whole column at once.
 *
 * The header box shows a dash when only some rows are ticked, so it reads as
 * "some of these" rather than as an unticked box that would clear them.
 */
export function TickBox({
  checked,
  indeterminate,
  onChange,
  label,
}: {
  checked: boolean
  indeterminate?: boolean
  onChange: () => void
  label: string
}) {
  return (
    <input
      type="checkbox"
      className="cursor-pointer"
      checked={checked}
      aria-label={label}
      ref={(el) => { if (el) el.indeterminate = indeterminate === true && !checked }}
      onChange={onChange}
    />
  )
}
