import { useEffect, useState } from 'react'
import { Download, FileSpreadsheet, KeyRound, Layers, Plug, Trash2 } from 'lucide-react'
import { UploadZone } from './UploadZone'
import {
  getApiBaseOverride, getApiKey, isFileOrigin, pokemonTcgIo, setApiBaseOverride, setApiKey,
  type ConnectionResult,
} from '../lib/pricing'
import { relativeTime } from '../lib/format'
import { getParseKey, setParseKey } from '../lib/providers/cardladder-client'
import { estimateFetch } from '../lib/providers/cardladder'
import type { UsageInfo } from '../lib/providers/cardladder-client'
import type { ImportLogEntry, ImportMode, RefreshState } from '../lib/store'

interface Props {
  importLog: ImportLogEntry[]
  refresh: RefreshState
  gradedRefresh: { running: boolean; done: number; total: number; unmatched: string[]; failed: string[]; startedAt: number | null }
  certLastFetched: string | null
  certCount: number
  /** Slabs with a cert but still no sold comps. */
  missingCerts: number
  /** Slabs that have a photograph. */
  photoCount: number
  usage: UsageInfo | null
  onRefreshGraded: (opts?: { onlyMissing?: boolean }) => void
  onImport: (file: File, kind: 'portfolio' | 'watchlist', mode?: ImportMode) => Promise<void>
  onTemplate: () => void
  onExport: () => void
  onClear: () => void
  onClearList: (kind: 'portfolio' | 'watchlist') => void
  holdingCount: number
  watchCount: number
}

/**
 * A destructive button that asks first, and says what it will destroy.
 *
 * The count goes in the confirmation rather than the label, because "Empty
 * holdings" is what you look for and "remove all 94 holdings" is what you
 * need to read before agreeing to it.
 */
function ConfirmButton({
  label, confirm, onConfirm, disabled,
}: { label: string; confirm: string; onConfirm: () => void; disabled?: boolean }) {
  const [armed, setArmed] = useState(false)
  if (!armed) {
    return (
      <button type="button" className="btn" disabled={disabled} onClick={() => setArmed(true)}>
        <Trash2 className="size-4" aria-hidden /> {label}
      </button>
    )
  }
  return (
    <span className="flex gap-2">
      <button
        type="button" className="btn"
        style={{ borderColor: 'var(--critical)', color: 'var(--critical)' }}
        onClick={() => { onConfirm(); setArmed(false) }}
      >
        {confirm}
      </button>
      <button type="button" className="btn" onClick={() => setArmed(false)}>Cancel</button>
    </span>
  )
}

export function DataPanel({
  importLog, refresh, gradedRefresh, certLastFetched, certCount, missingCerts, photoCount, usage,
  onImport, onTemplate, onExport, onClear, onClearList, onRefreshGraded,
  holdingCount, watchCount,
}: Props) {
  const [key, setKey] = useState(getApiKey())
  const [saved, setSaved] = useState(false)
  const [confirmClear, setConfirmClear] = useState(false)
  const [testing, setTesting] = useState(false)
  const [test, setTest] = useState<ConnectionResult | null>(null)
  const [apiBase, setApiBase] = useState(getApiBaseOverride())
  const [baseSaved, setBaseSaved] = useState(false)
  const [parseKey, setParseKeyField] = useState(getParseKey())
  const [parseSaved, setParseSaved] = useState(false)
  const [addMode, setAddMode] = useState(false)

  async function runTest() {
    setTesting(true)
    setTest(null)
    try {
      setTest(await pokemonTcgIo.test())
    } catch (err) {
      setTest({ status: 'blocked', message: err instanceof Error ? err.message : String(err) })
    } finally {
      setTesting(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-2 items-start">
        <section className="card p-4">
          <h2 className="text-sm font-semibold mb-3">Import</h2>
          <div className="space-y-3">
            <UploadZone compact label="Upload portfolio" hint="Sheets named Portfolio, Watchlist and Price History are each routed to the right place. Everything else is read as holdings." onFile={(f) => onImport(f, 'portfolio', addMode ? 'add' : 'replace')} />
            <UploadZone compact label="Upload watchlist" hint="What you are considering buying, with an asking price where you have one." onFile={(f) => onImport(f, 'watchlist', addMode ? 'add' : 'replace')} />
          </div>
          <label className="flex items-start gap-2 mt-3 text-xs secondary leading-relaxed cursor-pointer">
            <input
              type="checkbox" className="mt-0.5" checked={addMode}
              onChange={(e) => setAddMode(e.target.checked)}
            />
            <span>
              <span className="font-medium">Add to what is already here</span> instead of replacing it. Leave this
              off to re-upload a corrected sheet; turn it on to combine separate sheets into one portfolio.
            </span>
          </label>
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
            <Layers className="size-4" aria-hidden /> Graded cards — Card Ladder
          </h2>
          <p className="text-xs secondary leading-relaxed mb-3">
            Prices PSA, BGS, CGC and SGC slabs from their own completed sales, matched by certificate
            number. Paste your key from <span className="font-medium">parse.bot/settings</span>; it stays in
            this browser and is sent only to Parse.
          </p>
          <div className="flex gap-2">
            <input
              className="input" type="password" placeholder="Parse API key" value={parseKey}
              aria-label="Card Ladder API key"
              onChange={(e) => { setParseKeyField(e.target.value); setParseSaved(false) }}
            />
            <button
              type="button" className="btn"
              onClick={() => { setParseKey(parseKey.trim()); setParseSaved(true) }}
            >
              {parseSaved ? 'Saved' : 'Save'}
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-2 mt-3">
            <button type="button" className="btn btn-primary" onClick={() => onRefreshGraded()} disabled={gradedRefresh.running || certCount === 0}>
              {gradedRefresh.running
                ? `Fetching ${gradedRefresh.done}/${gradedRefresh.total}…`
                : `Fetch sold comps for ${certCount} slab${certCount === 1 ? '' : 's'}`}
            </button>
            {missingCerts > 0 && certLastFetched && (
              <button
                type="button" className="btn" onClick={() => onRefreshGraded({ onlyMissing: true })}
                disabled={gradedRefresh.running}
              >
                Retry the {missingCerts} still missing
              </button>
            )}
            <span className="text-xs muted">
              {certLastFetched ? `updated ${relativeTime(certLastFetched)}` : 'not fetched yet'}
            </span>
          </div>

          {gradedRefresh.running && <GradedProgress gradedRefresh={gradedRefresh} />}

          {!gradedRefresh.running && certCount > 0 && (() => {
            const { ms, credits } = estimateFetch(certCount)
            const short = usage?.creditsRemaining != null && credits > usage.creditsRemaining
            return (
              <p className="text-xs muted mt-2 leading-relaxed">
                Card Ladder prices each slab when asked rather than reading a stored number, so expect
                about <span className="tabular">{formatDuration(ms)}</span> for {certCount} and about{' '}
                <span className="tabular">{credits}</span> credits.
                {short && (
                  <span style={{ color: 'var(--serious)' }}>
                    {' '}That is more than the {usage.creditsRemaining?.toLocaleString()} you have left, so it
                    will stop partway.
                  </span>
                )}
              </p>
            )
          })()}

          {certCount === 0 && (
            <p className="text-xs mt-2 leading-relaxed" style={{ color: 'var(--serious)' }}>
              No certificate numbers in your sheet yet. Add a <strong>Cert Number</strong> column — that is how a
              slab is matched to its own sales.
            </p>
          )}
          {certCount > 0 && certLastFetched && (
            <p className="text-xs muted mt-2 leading-relaxed">
              {photoCount === 0
                ? 'No photographs yet. They come with the next fetch, and are kept once they arrive.'
                : `Photographs for ${photoCount} of ${certCount} slab${certCount === 1 ? '' : 's'}${
                    photoCount < certCount ? ' — the rest have none on record' : ''
                  }.`}
            </p>
          )}
          {usage && (usage.creditsRemaining != null || usage.creditsCharged != null) && (
            <p className="text-xs muted mt-2 tabular">
              {usage.creditsCharged != null && `${usage.creditsCharged} credit${usage.creditsCharged === 1 ? '' : 's'} charged`}
              {usage.creditsRemaining != null && `${usage.creditsCharged != null ? ' · ' : ''}${usage.creditsRemaining.toLocaleString()} remaining`}
              {usage.creditsLimit != null && ` of ${usage.creditsLimit.toLocaleString()}`}
            </p>
          )}
          {/* The allowance that actually runs out first, and the one a refresh
              was failing on with nothing on screen to explain it. */}
          {usage?.dailyRemaining != null && (
            <p
              className="text-xs mt-1 tabular"
              style={{ color: usage.dailyRemaining <= 10 ? 'var(--serious)' : undefined }}
            >
              {usage.dailyRemaining} request{usage.dailyRemaining === 1 ? '' : 's'} left today
              {usage.dailyRemaining <= 10 && ' — a full refresh needs about 6'}
            </p>
          )}
          {gradedRefresh.failed.length > 0 && (
            <p className="text-xs mt-2 leading-relaxed" style={{ color: 'var(--serious)' }}>
              {gradedRefresh.failed.length} slab{gradedRefresh.failed.length === 1 ? '' : 's'} could not be
              reached — Card Ladder was unavailable, which says nothing about those certificate numbers.
              Press fetch again to pick them up.
            </p>
          )}
          {gradedRefresh.unmatched.length > 0 && (
            <details className="mt-2">
              <summary className="text-xs cursor-pointer" style={{ color: 'var(--serious)' }}>
                {gradedRefresh.unmatched.length} cert{gradedRefresh.unmatched.length === 1 ? '' : 's'} had no match
              </summary>
              <p className="text-xs muted mt-1 leading-relaxed">
                Card Ladder has no verified sales for {gradedRefresh.unmatched.slice(0, 8).join(', ')}
                {gradedRefresh.unmatched.length > 8 ? ', and others' : ''}. Check the digits against the slab label.
              </p>
            </details>
          )}
        </section>

        <section className="card p-4">
          <details>
            <summary className="text-sm font-semibold flex items-center gap-2 cursor-pointer list-none">
              <KeyRound className="size-4" aria-hidden /> Ungraded singles
              <span className="text-xs font-normal muted">— optional, raw cards only</span>
            </summary>
            <div className="mt-3">
          <p className="text-xs secondary leading-relaxed mb-3">
            Nothing here is needed for graded slabs or sealed product. It prices <strong>raw</strong> singles
            from the free Pokémon TCG API, which fails roughly half its requests — so treat anything it
            returns as a rough reference, not a valuation. Graded cards are priced from their own sold comps
            in the section above.
          </p>
          <p className="text-xs secondary leading-relaxed mb-3">
            A free key from <span className="font-medium">dev.pokemontcg.io</span> raises the rate limit. It is
            stored in this browser only and sent to that API alone.
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

          {isFileOrigin() && (
            <p
              className="text-xs mt-4 mb-1 leading-relaxed rounded-md p-2"
              style={{ background: 'color-mix(in oklab, var(--serious) 14%, transparent)' }}
            >
              <strong>Live prices will not work here.</strong> This page was opened straight from a file, and
              browsers do not let a page opened that way call an outside service. Everything else works —
              imports, valuations from your own comps, the whole dashboard. For live prices, open the hosted
              copy of this page instead of the downloaded file.
            </p>
          )}

          <h3 className="text-sm font-semibold mt-5 mb-2">Connection</h3>
          <p className="text-xs secondary leading-relaxed mb-2">
            Makes one small request, so you can tell “this page cannot reach the price API” apart from
            “that card name did not match”.
          </p>
          <button type="button" className="btn" onClick={() => void runTest()} disabled={testing}>
            <Plug className="size-4" aria-hidden /> {testing ? 'Testing…' : 'Test connection'}
          </button>
          {test && (
            <p
              className="text-xs mt-2 leading-relaxed"
              role="status"
              style={{ color: test.status === 'ok' ? 'var(--delta-up)' : 'var(--serious)' }}
            >
              {test.status === 'ok' ? '\u2713 ' : '\u26a0 '}{test.message}
              {test.status === 'blocked' && !isFileOrigin() && (
                <>
                  {' '}This affects raw singles only — graded slabs are priced through Card Ladder, which is
                  reached separately and is unaffected.
                </>
              )}
            </p>
          )}

          <h3 className="text-sm font-semibold mt-5 mb-2">Price API address</h3>
          <p className="text-xs secondary leading-relaxed mb-2">
            Leave this blank. It exists so that anyone running their own mirror or proxy of the Pokémon TCG
            API can point the raw-singles lookup at it instead.
          </p>
          <div className="flex gap-2">
            <input
              className="input" placeholder="https://api.pokemontcg.io" value={apiBase}
              aria-label="Price API base URL"
              onChange={(e) => { setApiBase(e.target.value); setBaseSaved(false) }}
            />
            <button
              type="button" className="btn"
              onClick={() => { setApiBaseOverride(apiBase.trim().replace(/\/$/, '')); setBaseSaved(true); setTest(null) }}
            >
              {baseSaved ? 'Saved' : 'Save'}
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

            </div>
          </details>
        </section>

        <section className="card p-4">
          <h3 className="text-sm font-semibold mb-2">Empty one list</h3>
          <p className="text-xs secondary mb-2">
            Removes the rows and nothing else. Prices you have fetched and slab photographs are kept —
            they are stored against the card, not against the list — so re-uploading the right sheet
            brings them straight back.
          </p>
          <div className="flex flex-wrap gap-2">
            <ConfirmButton
              label="Empty holdings"
              confirm={`Yes, remove all ${holdingCount} holdings`}
              onConfirm={() => onClearList('portfolio')}
              disabled={holdingCount === 0}
            />
            <ConfirmButton
              label="Empty watchlist"
              confirm={`Yes, remove all ${watchCount} watch items`}
              onConfirm={() => onClearList('watchlist')}
              disabled={watchCount === 0}
            />
          </div>
        </section>

        <section className="card p-4">
          <h3 className="text-sm font-semibold mb-2">Reset</h3>
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
                  Mapped: {Object.entries(e.mapped ?? {}).map(([f, h]) => `${f} ← "${h}"`).join(', ') || 'nothing'}
                </div>
                {e.historyPoints > 0 && <div className="text-xs secondary mt-1">{e.historyPoints} historical price points read.</div>}
                {(e.ignoredHeaders ?? []).length > 0 && (
                  <div className="text-xs secondary mt-1">
                    Set aside: {(e.ignoredHeaders ?? []).join(', ')} —{' '}
                    {e.kind === 'watchlist'
                      ? 'a watchlist is things not bought yet, so what they cost and what they might make do not apply.'
                      : 'gain is worked out from cost and today\u2019s value rather than read from the sheet.'}
                  </div>
                )}
                {(e.unmappedHeaders ?? []).length > 0 && (
                  <div className="text-xs mt-1" style={{ color: 'var(--serious)' }}>
                    Not recognised: {(e.unmappedHeaders ?? []).join(', ')}
                  </div>
                )}
                {(e.issues ?? []).length > 0 && (
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

/** "2m 30s" — an estimate is useless if it needs arithmetic to read. */
function formatDuration(ms: number): string {
  const total = Math.max(1, Math.round(ms / 1000))
  if (total < 60) return `${total}s`
  const m = Math.floor(total / 60)
  const sec = total % 60
  return sec === 0 ? `${m}m` : `${m}m ${sec}s`
}

/**
 * Progress for a fetch that genuinely takes minutes.
 *
 * A bare spinner on a two-minute wait is indistinguishable from a hang, so
 * this shows how far along it is and how long is left, re-estimated from the
 * rate actually achieved rather than an assumed one.
 */
function GradedProgress({
  gradedRefresh,
}: {
  gradedRefresh: { done: number; total: number; startedAt: number | null }
}) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(id)
  }, [])

  const { done, total, startedAt } = gradedRefresh
  const elapsed = startedAt ? now - startedAt : 0
  const pct = total > 0 ? Math.round((done / total) * 100) : 0
  // Before anything lands there is no measured rate; fall back to the modelled one.
  const perCert = done > 0 ? elapsed / done : estimateFetch(total).ms / Math.max(1, total)
  const remaining = Math.max(0, total - done) * perCert

  return (
    <div className="mt-2">
      <div
        className="h-1.5 rounded-full overflow-hidden"
        style={{ background: 'var(--border)' }}
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Fetching sold comps"
      >
        <div
          className="h-full transition-all duration-500"
          style={{ width: `${Math.max(pct, 2)}%`, background: 'var(--accent)' }}
        />
      </div>
      <p className="text-xs muted mt-1 tabular">
        {formatDuration(elapsed)} elapsed
        {done > 0 && remaining > 0 && ` · about ${formatDuration(remaining)} left`}
        {done === 0 && ' · waiting on the first batch'}
      </p>
    </div>
  )
}
