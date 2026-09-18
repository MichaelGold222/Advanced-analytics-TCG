import { useId, useState, type ReactNode } from 'react'

export interface TableView {
  columns: string[]
  rows: (string | number)[][]
}

interface Props {
  title: string
  subtitle?: string
  /** Rendered under the chart; use it to state what the chart does not show. */
  footnote?: ReactNode
  table: TableView
  children: ReactNode
  actions?: ReactNode
}

/**
 * Every chart ships with a table view.
 *
 * Two of the four segment colors sit below 3:1 against the light surface, and
 * the palette rule for that is explicit: provide relief. Direct labels cover
 * the chart itself; this toggle covers everything else, and doubles as the
 * screen-reader path to the same numbers.
 */
export function ChartFrame({ title, subtitle, footnote, table, children, actions }: Props) {
  const [showTable, setShowTable] = useState(false)
  const regionId = useId()

  return (
    <section className="card p-4 flex flex-col" aria-labelledby={`${regionId}-title`}>
      <header className="flex items-start justify-between gap-3 mb-3">
        <div className="min-w-0">
          <h2 id={`${regionId}-title`} className="text-sm font-semibold">{title}</h2>
          {subtitle && <p className="text-xs secondary mt-0.5">{subtitle}</p>}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {actions}
          <button
            type="button"
            className="btn text-xs px-2 py-1"
            aria-pressed={showTable}
            onClick={() => setShowTable((s) => !s)}
          >
            {showTable ? 'Chart' : 'Table'}
          </button>
        </div>
      </header>

      <div className="flex-1 min-h-0">
        {showTable ? (
          <div className="overflow-auto max-h-80">
            <table className="data w-full">
              <thead>
                <tr>
                  {table.columns.map((c, i) => (
                    <th key={c} className={i === 0 ? '' : 'num'}>{c}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {table.rows.map((row, ri) => (
                  <tr key={ri}>
                    {row.map((cell, ci) => (
                      <td key={ci} className={ci === 0 ? '' : 'num'}>{cell}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          children
        )}
      </div>

      {footnote && <p className="text-xs muted mt-3 leading-relaxed">{footnote}</p>}
    </section>
  )
}

/** Shared tooltip shell so every chart's hover layer looks the same. */
export function TooltipCard({ title, rows }: { title: string; rows: { label: string; value: string; color?: string }[] }) {
  return (
    <div
      className="rounded-lg px-3 py-2 text-xs shadow-lg"
      style={{ background: 'var(--surface-1)', border: '1px solid var(--border-strong)', color: 'var(--text-primary)' }}
    >
      <div className="font-semibold mb-1">{title}</div>
      {rows.map((r) => (
        <div key={r.label} className="flex items-center justify-between gap-4 leading-5">
          <span className="flex items-center gap-1.5 secondary">
            {r.color && <span className="inline-block size-2 rounded-sm" style={{ background: r.color }} aria-hidden />}
            {r.label}
          </span>
          <span className="tabular font-medium">{r.value}</span>
        </div>
      ))}
    </div>
  )
}
