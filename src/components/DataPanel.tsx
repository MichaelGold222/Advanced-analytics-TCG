import { useState } from 'react'
import { Download, FileSpreadsheet, KeyRound, Trash2 } from 'lucide-react'
import { UploadZone } from './UploadZone'
import { getApiKey, setApiKey } from '../lib/pricing'
import { relativeTime } from '../lib/format'
import type { ImportLogEntry, RefreshState } from '../lib/store'

interface Props {
  importLog: ImportLogEntry[]
  refresh: RefreshState
  onImport: (file: File, kind: 'portfolio' | 'watchlist') => Promise<void>
  onTemplate: () => void
  onExport: () => void
  onClear: () => void
}

export function DataPanel({ importLog, refresh, onImport, onTemplate, onExport, onClear }: Props) {
  const [key, setKey] = useState(getApiKey())
  const [saved, setSaved] = useState(false)
  const [confirmClear, setConfirmClear] = useState(false)

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-2">
        <section className="card p-4">
          <h2 className="text-sm font-semibold mb-3">Import</h2>
          <div className="space-y-3">
            <UploadZone compact label="Upload portfolio" hint="Sheets named Portfolio, Watchlist and Price History are each routed to the right place. Everything else is read as holdings." onFile={(f) => onImport(f, 'portfolio')} />
            <UploadZone compact label="Upload watchlist" hint="What you are considering buying, with an asking price where you have one." onFile={(f) => onImport(f, 'watchlist')} />
          </div>
          <div className="flex flex-wrap gap-2 mt-4">
            <button type="button" className="btn" onClick={onTemplate}>
              <FileSpreadsheet className="size-4" aria-hidden /> Download template
            </button>
            <button type="button" className="btn" onClick={onExport}>
              <Download className="size-4" aria-hidden /> Export analysis
            </button>
          </div>
        </section>

        <section className="card p-4">
          <h2 className="text-sm font-semibold mb-1 flex items-center gap-2">
            <KeyRound className="size-4" aria-hidden /> Price API key (optional)
          </h2>
          <p className="text-xs secondary leading-relaxed mb-3">
            Lookups use the free Pokémon TCG API, which works without a key but is rate limited.
            A free key at <span className="font-medium">dev.pokemontcg.io</span> raises the limit. It is stored in this browser only
            and sent to that API alone.
          </p>
          <div className="flex gap-2">
            <input
              className="input" type="password" placeholder="Paste API key" value={key}
              onChange={(e) => { setKey(e.target.value); setSaved(false) }} aria-label="API key"
            />
            <button type="button" className="btn" onClick={() => { setApiKey(key.trim()); setSaved(true) }}>
              {saved ? 'Saved' : 'Save'}
            </button>
          </div>

          <h3 className="text-sm font-semibold mt-5 mb-2">Last price refresh</h3>
          <p className="text-xs secondary">
            {refresh.lastRun ? `Ran ${relativeTime(refresh.lastRun)} · ${refresh.done} looked up` : 'Not run yet in this session.'}
          </p>
          {refresh.skipped.length > 0 && (
            <details className="mt-2">
              <summary className="text-xs cursor-pointer secondary">{refresh.skipped.length} skipped</summary>
              <ul className="text-xs muted mt-1 space-y-1 max-h-32 overflow-auto">
                {refresh.skipped.map((s) => <li key={s.key}>{s.name} — {s.reason}</li>)}
              </ul>
            </details>
          )}
          {refresh.errors.length > 0 && (
            <details className="mt-2">
              <summary className="text-xs cursor-pointer" style={{ color: 'var(--serious)' }}>{refresh.errors.length} not found or failed</summary>
              <ul className="text-xs muted mt-1 space-y-1 max-h-32 overflow-auto">
                {refresh.errors.map((s) => <li key={s.key}>{s.name} — {s.message}</li>)}
              </ul>
            </details>
          )}

          <h3 className="text-sm font-semibold mt-5 mb-2">Reset</h3>
          <p className="text-xs secondary mb-2">Deletes every holding, watch item and captured price snapshot from this browser. It cannot be undone.</p>
          {confirmClear ? (
            <div className="flex gap-2">
              <button type="button" className="btn" style={{ borderColor: 'var(--critical)', color: 'var(--critical)' }} onClick={() => { onClear(); setConfirmClear(false) }}>
                Yes, delete everything
              </button>
              <button type="button" className="btn" onClick={() => setConfirmClear(false)}>Cancel</button>
            </div>
          ) : (
            <button type="button" className="btn" onClick={() => setConfirmClear(true)}>
              <Trash2 className="size-4" aria-hidden /> Clear all data
            </button>
          )}
        </section>
      </div>

      <section className="card p-4">
        <h2 className="text-sm font-semibold mb-3">Import history</h2>
        {importLog.length === 0 ? (
          <p className="text-sm muted">Nothing imported yet.</p>
        ) : (
          <ul className="space-y-3">
            {[...importLog].reverse().map((e, i) => (
              <li key={`${e.at}-${i}`} className="text-sm border-b pb-3 last:border-0" style={{ borderColor: 'var(--border)' }}>
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className="font-medium">{e.file}</span>
                  <span className="text-xs muted">{relativeTime(e.at)} · {e.imported} rows · sheets: {e.sheets.join(', ')}</span>
                </div>
                <div className="text-xs secondary mt-1">
                  Mapped: {Object.entries(e.mapped).map(([f, h]) => `${f} ← "${h}"`).join(', ') || 'nothing'}
                </div>
                {e.historyPoints > 0 && <div className="text-xs secondary mt-1">{e.historyPoints} historical price points read.</div>}
                {e.unmappedHeaders.length > 0 && (
                  <div className="text-xs mt-1" style={{ color: 'var(--serious)' }}>
                    Ignored columns: {e.unmappedHeaders.join(', ')}
                  </div>
                )}
                {e.issues.length > 0 && (
                  <details className="mt-1">
                    <summary className="text-xs cursor-pointer" style={{ color: 'var(--serious)' }}>{e.issues.length} row issue{e.issues.length === 1 ? '' : 's'}</summary>
                    <ul className="text-xs muted mt-1 space-y-0.5 max-h-40 overflow-auto">
                      {e.issues.map((iss, k) => <li key={k}>Row {iss.row}: {iss.message}</li>)}
                    </ul>
                  </details>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
