import { useEffect, useMemo, useState } from 'react'
import { AlertCircle, Monitor, Moon, RefreshCw, Sun, X } from 'lucide-react'
import { DataPanel } from './components/DataPanel'
import { HoldingsTable } from './components/HoldingsTable'
import { SegmentAllocation } from './components/SegmentAllocation'
import { SegmentPerformance } from './components/SegmentPerformance'
import { PriceCoverage } from './components/PriceCoverage'
import { StatTile } from './components/StatTile'
import { TrendingSection, type TrendRow } from './components/TrendingSection'
import { SegmentBreakdown } from './components/SegmentBreakdown'
import { TopHoldings, type HoldingBar } from './components/TopHoldings'
import { UploadZone } from './components/UploadZone'
import { ValueTrend } from './components/ValueTrend'
import { ErrorBoundary } from './components/ErrorBoundary'
import { ImportResultBanner } from './components/ImportResultBanner'
import { MisplacedRows } from './components/MisplacedRows'
import { WatchlistPanel } from './components/WatchlistPanel'
import { useTheme } from './hooks/useTheme'
import { analyzeItem, computeTrend } from './lib/analytics'
import { money, pct, relativeTime } from './lib/format'
import { itemKey } from './lib/key'
import { assessHistory, rankGaps } from './lib/historygaps'
import { estimateRefresh } from './lib/refreshcost'
import { buildRepeatSalesIndex } from './lib/marketindex'
import {
  analyzeHoldings, buildValueTrend, computePortfolioStats, holdingKey, suspectedWatchItems, unitValue,
} from './lib/portfolio'
import { getParseKey } from './lib/providers/cardladder-client'
import { selectSeries, useStore } from './lib/store'
import { downloadTemplate, exportAnalysis } from './lib/workbook-out'
import type { ItemAnalysis } from './lib/types'

type Tab = 'dashboard' | 'holdings' | 'watchlist' | 'data'

const TABS: { id: Tab; label: string }[] = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'holdings', label: 'Holdings' },
  { id: 'watchlist', label: 'Watchlist' },
  { id: 'data', label: 'Data & settings' },
]

export default function App() {
  const store = useStore()
  const { choice, cycle } = useTheme()
  const [tab, setTab] = useState<Tab>('dashboard')

  useEffect(() => {
    void store.hydrate()
    void store.loadFeed()
    // Hydration runs once; the store is a stable singleton.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const { holdings, watchlist, uploadedHistory, snapshots, quotes, feed } = store

  const series = useMemo(
    () => selectSeries(store),
    // Rebuilt whenever any price input or item list changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [holdings, watchlist, uploadedHistory, snapshots, quotes, feed],
  )

  // One index for the whole collection, built once from every repeat sale in
  // it. Holdings and watchlist both measure against the same market, which is
  // the only way their betas mean the same thing.
  const marketIndex = useMemo(() => buildRepeatSalesIndex(series), [series])

  const holdingAnalyses = useMemo(
    () => analyzeHoldings(holdings, series, new Date(), marketIndex),
    [holdings, series, marketIndex],
  )

  const watchAnalyses = useMemo(() => {
    const out = new Map<string, ItemAnalysis>()
    for (const w of watchlist) {
      const key = itemKey(w)
      const s = series.get(key) ?? { key, points: [] }
      out.set(key, analyzeItem(s, w.askingPrice ?? null, new Date(), { index: marketIndex }))
    }
    return out
  }, [watchlist, series, marketIndex])

  // Which cards' numbers cannot be trusted yet, and why. Covers holdings and
  // watchlist together: the thin-record problem is about the certificate, not
  // about which list the card is sitting in.
  const assessed = useMemo(() => {
    const out = []
    for (const item of [...holdings, ...watchlist]) {
      const key = itemKey(item)
      const points = series.get(key)?.points ?? []
      const analysis = holdingAnalyses.get(key) ?? watchAnalyses.get(key)
      out.push(assessHistory(key, item.name, points, analysis, store.certLastFetched, new Date(), {
        cardId: item.cert ? store.certCardIds[item.cert] : undefined,
        fetched: item.cert ? store.certDeepFetched[item.cert] : undefined,
      }))
    }
    return out
  }, [holdings, watchlist, series, holdingAnalyses, watchAnalyses, store.certLastFetched,
      store.certCardIds, store.certDeepFetched])
  const historyGaps = useMemo(() => rankGaps(assessed), [assessed])
  const refreshCost = useMemo(() => estimateRefresh({
    certs: [...holdings, ...watchlist].map((i) => i.cert).filter((c): c is string => !!c),
    certSales: store.certSales,
    certCardIds: store.certCardIds,
    certDeepFetched: store.certDeepFetched,
  }), [holdings, watchlist, store.certSales, store.certCardIds, store.certDeepFetched])
  const gapTotal = assessed.length

  const stats = useMemo(() => computePortfolioStats(holdings, holdingAnalyses), [holdings, holdingAnalyses])
  // Rows counting toward the portfolio total with nothing to say they were
  // ever bought. Offered for moving rather than moved.
  const misplaced = useMemo(() => suspectedWatchItems(holdings), [holdings])

  // The most recent import, so the banner can say where its rows landed. Kept
  // until dismissed or superseded, since the answer matters most right after.
  const lastImport = store.importLog[store.importLog.length - 1]
  // Stored holdings keep whatever they were parsed as, so an importer fix only
  // reaches a sheet that is uploaded again. Say so rather than showing zeros.
  const costMissing = holdings.length > 0 && stats.costBasis === 0
  const trend = useMemo(() => buildValueTrend(holdings, series), [holdings, series])
  const trendRows = useMemo<TrendRow[]>(() => holdings.flatMap((h) => {
    const key = holdingKey(h)
    const s = series.get(key)
    if (!s) return []
    const uv = unitValue(holdingAnalyses.get(key), h.userPrice)
    return [{
      key: h.id,
      name: h.name,
      detail: [h.set, h.condition].filter(Boolean).join(' · ') || '—',
      value: uv == null ? null : uv * h.quantity,
      trend: computeTrend(s),
    }]
  }), [holdings, series, holdingAnalyses])

  const topHoldings = useMemo<HoldingBar[]>(() => {
    const byName = new Map<string, HoldingBar>()
    for (const h of holdings) {
      const uv = unitValue(holdingAnalyses.get(holdingKey(h)), h.userPrice)
      if (uv == null) continue
      const value = uv * h.quantity
      const label = h.set ? `${h.name} · ${h.set}` : h.name
      const existing = byName.get(label)
      if (existing) existing.value += value
      else byName.set(label, { name: label, value, weight: 0, segment: h.segment })
    }
    const rows = [...byName.values()].sort((a, b) => b.value - a.value)
    for (const r of rows) r.weight = stats.marketValue > 0 ? r.value / stats.marketValue : 0
    return rows
  }, [holdings, holdingAnalyses, stats.marketValue])

  const isEmpty = holdings.length === 0 && watchlist.length === 0
  const busy = store.refresh.running || store.gradedRefresh.running

  /**
   * Price everything in one gesture: graded slabs by certificate from Card
   * Ladder, then ungraded singles from the free quote API. Graded goes first
   * because it is the accurate half and the one people are waiting on.
   */
  /**
   * Graded first: those are the valuations worth having. Singles follow only
   * if anything is left that a raw-card quote can actually price.
   */
  async function refreshEverything() {
    const all = [...holdings, ...watchlist]
    const graded = all.filter((i) => i.grade != null)
    const hasCerts = all.some((i) => i.cert)

    if (hasCerts && getParseKey()) {
      await store.refreshGraded()
    } else if (graded.length > 0) {
      // Saying nothing here sends the refresh off to price slabs against a
      // raw-card API, which discards the answer — minutes spent for nothing.
      store.reportError(
        getParseKey()
          ? `${graded.length} graded card${graded.length === 1 ? '' : 's'} have no certificate number, so their sold comps cannot be looked up. Add a Cert Number column to your sheet.`
          : 'Add your Card Ladder API key in Data & settings to price graded cards. Without it there is nothing to value them from.',
      )
    }

    // Everything graded, and sealed product, is skipped by the singles pass.
    const raw = all.filter((i) => i.grade == null && i.segment !== 'sealed')
    if (raw.length > 0) await store.refreshPrices()
  }
  const ThemeIcon = choice === 'light' ? Sun : choice === 'dark' ? Moon : Monitor

  /** Saves can fail in a viewer that mediates downloads; never fail silently. */
  function runSave(save: () => Promise<unknown>) {
    save().catch((err: unknown) => {
      store.reportError(err instanceof Error ? err.message : String(err))
    })
  }

  const handleTemplate = () => runSave(downloadTemplate)
  const handleExport = () =>
    runSave(() => exportAnalysis(holdings, watchlist, new Map([...holdingAnalyses, ...watchAnalyses]), itemKey))

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-20 border-b" style={{ background: 'var(--surface-1)', borderColor: 'var(--border)' }}>
        <div className="max-w-[1400px] mx-auto px-4 py-3 flex flex-wrap items-center gap-3">
          <div className="mr-auto">
            <h1 className="text-base font-semibold leading-tight">Pokémon Portfolio Analytics</h1>
            <p className="text-xs muted">
              {holdings.length} position{holdings.length === 1 ? '' : 's'} · {watchlist.length} watched ·
              {' '}{store.lastRefresh ? `prices ${relativeTime(store.lastRefresh)}` : 'no price refresh yet'}
            </p>
          </div>

          <button
            type="button" className="btn btn-primary"
            onClick={() => void refreshEverything()}
            disabled={busy || isEmpty}
          >
            <RefreshCw className={`size-4 ${busy ? 'animate-spin' : ''}`} aria-hidden />
            {store.gradedRefresh.running
              ? `Graded ${store.gradedRefresh.done}/${store.gradedRefresh.total}`
              : store.refresh.running
                ? `Singles ${store.refresh.done}/${store.refresh.total}`
                : 'Refresh prices'}
          </button>

          <button type="button" className="btn" onClick={cycle} aria-label={`Theme: ${choice}. Click to change.`} title={`Theme: ${choice}`}>
            <ThemeIcon className="size-4" aria-hidden />
          </button>
        </div>

        <nav className="max-w-[1400px] mx-auto px-4 flex gap-1" aria-label="Sections">
          {TABS.map((t) => (
            <button
              key={t.id} type="button" onClick={() => setTab(t.id)}
              aria-current={tab === t.id ? 'page' : undefined}
              className="px-3 py-2 text-sm font-medium border-b-2 -mb-px"
              style={{
                borderColor: tab === t.id ? 'var(--seq-450)' : 'transparent',
                color: tab === t.id ? 'var(--text-primary)' : 'var(--text-secondary)',
              }}
            >
              {t.label}
            </button>
          ))}
        </nav>
      </header>

      <main className="max-w-[1400px] mx-auto px-4 py-5">
        {store.error && (
          <div
            className="card p-3 mb-4 flex items-start gap-2 text-sm"
            style={{ borderColor: 'var(--critical)' }}
            role="alert"
          >
            <AlertCircle className="size-4 mt-0.5 shrink-0" style={{ color: 'var(--critical)' }} aria-hidden />
            <span className="flex-1">{store.error}</span>
            <button type="button" className="btn px-2 py-1" onClick={store.dismissError} aria-label="Dismiss">
              <X className="size-3.5" aria-hidden />
            </button>
          </div>
        )}

        {costMissing && (
          <div
            className="card p-3 mb-4 flex items-start gap-2 text-sm"
            style={{ borderColor: 'var(--serious)' }}
            role="status"
          >
            <AlertCircle className="size-4 mt-0.5 shrink-0" style={{ color: 'var(--serious)' }} aria-hidden />
            <span className="flex-1 leading-relaxed">
              <strong>Every position has a cost of 0</strong>, so returns are meaningless. Holdings are stored
              exactly as they were read, so a sheet imported before a column was understood keeps its zeros —
              re-upload it in <button type="button" className="underline" onClick={() => setTab('data')}>Data &amp; settings</button>{' '}
              and the cost column will be picked up. If it still reads 0 afterwards, the import history there
              names the columns that were ignored.
            </span>
          </div>
        )}

        <ImportResultBanner
          entry={lastImport}
          onGoToWatchlist={() => setTab('watchlist')}
          onGoToHoldings={() => setTab('holdings')}
          onMoveHoldingsToWatchlist={() => {
            store.moveToWatchlist(holdings.map((h) => h.id))
            setTab('watchlist')
          }}
        />

        {/* A crash while drawing one tab must not black out the whole app. Keyed
            by tab so moving to another gives the broken one a fresh start. */}
        <ErrorBoundary key={tab} label={TABS.find((t) => t.id === tab)?.label}>
        {/* The empty state stands in for every tab while both lists are bare, so
            it has to upload into the tab it is standing in for. Hard-coding it
            to the portfolio meant the Watchlist tab offered a box that quietly
            filed the file under holdings — and emptying holdings to fix that
            brought the empty state straight back, so it happened again. */}
        {isEmpty && tab !== 'data' ? (
          <div className="card p-8 max-w-3xl mx-auto mt-6">
            <h2 className="text-xl font-semibold mb-2">
              {tab === 'watchlist' ? 'Start with what you are watching' : 'Start with your collection sheet'}
            </h2>
            <p className="text-sm secondary mb-6 leading-relaxed">
              {tab === 'watchlist'
                ? 'Drop in an Excel or CSV of the cards you are considering. This goes to the watchlist — nothing here is counted as owned or added to your portfolio value.'
                : 'Drop in an Excel or CSV export and it is broken down into sealed, vintage, modern and Pikachu promos.'}
              {' '}Nothing is uploaded anywhere — the file is read in this browser and stored on this device.
            </p>
            <UploadZone
              label={tab === 'watchlist' ? 'Choose a watchlist file' : 'Choose a file'}
              hint={tab === 'watchlist'
                ? 'Any .xlsx or .csv with a header row. An asking price column is read if you have one.'
                : 'Any .xlsx or .csv with a header row. Column names are matched for you, so “Paid”, “Purchase Price” and “Cost Basis” all work.'}
              onFile={(f) => store.importFile(f, tab === 'watchlist' ? 'watchlist' : 'portfolio')}
            />
            <div className="flex flex-wrap gap-2 mt-5 justify-center">
              <button type="button" className="btn" onClick={handleTemplate}>Download a template</button>
              {tab === 'watchlist' ? (
                <button type="button" className="btn" onClick={() => setTab('holdings')}>Or upload what you own</button>
              ) : (
                <button type="button" className="btn" onClick={() => setTab('watchlist')}>Or add a card you are watching</button>
              )}
            </div>
          </div>
        ) : tab === 'dashboard' ? (
          <div className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <StatTile
                hero label="Portfolio value"
                value={stats.roi == null && stats.marketValue === 0 ? '—' : money(stats.marketValue, { compact: stats.marketValue >= 100_000 })}
                delta={stats.roi == null ? undefined : {
                  value: `${money(stats.unrealized)} (${pct(stats.roi)})`,
                  direction: stats.unrealized > 0 ? 'up' : stats.unrealized < 0 ? 'down' : 'flat',
                }}
                sub={stats.unvalued > 0
                  ? `Valued at last sold · ${stats.unvalued} position${stats.unvalued === 1 ? '' : 's'} not valued`
                  : 'Valued at what each card last sold for'}
              />
              <StatTile
                label="Return"
                value={stats.roi == null ? '—' : pct(stats.roi)}
                delta={stats.roi == null ? undefined : {
                  value: money(stats.unrealized, { compact: Math.abs(stats.unrealized) >= 100_000 }),
                  direction: stats.unrealized > 0 ? 'up' : stats.unrealized < 0 ? 'down' : 'flat',
                }}
                sub={stats.roi == null
                  ? 'Nothing valued yet, so there is no return to measure.'
                  : stats.unvalued > 0 ? 'Measured over valued positions only' : 'Market value against what you put in'}
              />
              <StatTile
                label="Cost basis" value={money(stats.costBasis, { compact: stats.costBasis >= 100_000 })}
                sub={
                  stats.unvalued > 0 && stats.valuedCostBasis !== stats.costBasis
                    ? `${stats.items} positions · ${money(stats.valuedCostBasis, { compact: true })} of it valued`
                    : `${stats.items} positions · ${stats.units} units`
                }
              />
              <StatTile
                label="Unrealized"
                value={stats.roi == null ? '—' : money(stats.unrealized, { compact: Math.abs(stats.unrealized) >= 100_000 })}
                delta={stats.roi == null ? undefined : { value: pct(stats.roi), direction: stats.unrealized > 0 ? 'up' : stats.unrealized < 0 ? 'down' : 'flat' }}
                sub={stats.roi == null ? 'Nothing valued yet, so there is no return to measure.' : stats.unvalued > 0 ? 'Measured over valued positions only' : undefined}
              />
              <StatTile
                label="Largest position" value={stats.topPosition ? money(stats.topPosition.value, { compact: true }) : '—'}
                sub={stats.topPosition ? `${stats.topPosition.name} — ${(stats.topPosition.weight * 100).toFixed(1)}% of the book` : undefined}
              />
            </div>

            <PriceCoverage
              holdings={holdings} watchlist={watchlist}
              holdingAnalyses={holdingAnalyses} watchAnalyses={watchAnalyses}
              lastRefresh={store.lastRefresh} hasFeed={!!feed || !!store.certLastFetched} refresh={store.refresh}
              onRefresh={() => void refreshEverything()} onGoToData={() => setTab('data')}
            />

            <SegmentBreakdown stats={stats} />

            {trendRows.length > 0 && <TrendingSection rows={trendRows} />}

            <div className="grid gap-4 lg:grid-cols-2">
              <SegmentAllocation stats={stats} />
              <SegmentPerformance stats={stats} />
            </div>

            <ValueTrend data={trend} />
            <TopHoldings rows={topHoldings} concentration={stats.concentration} />
          </div>
        ) : tab === 'holdings' ? (
          <div className="space-y-4">
            <MisplacedRows candidates={misplaced} onMove={store.moveToWatchlist} />
            <HoldingsTable
              holdings={holdings} analyses={holdingAnalyses}
              onOverride={(id, s) => store.setSegmentOverride(id, s, 'holding')}
              onSetValue={(id, v) => store.setHoldingValue(id, v)}
              images={store.certImages}
              onRemove={store.removeHolding}
              onRemoveMany={store.removeHoldings}
              onMoveToWatchlist={store.moveToWatchlist}
            />
          </div>
        ) : tab === 'watchlist' ? (
          <WatchlistPanel
            watchlist={watchlist} analyses={watchAnalyses} series={series} images={store.certImages}
            onAdd={store.addWatchItem} onRemove={store.removeWatchItem}
            onRemoveMany={store.removeWatchItems}
            onOverride={(id, s) => store.setSegmentOverride(id, s, 'watch')}
            onUpdate={store.updateWatchItem}
            onPasteHistory={(item, points) => store.addPastedHistory(itemKey(item), points)}
            onImport={(f) => store.importFile(f, 'watchlist')}
          />
        ) : (
          <DataPanel
            importLog={store.importLog} refresh={store.refresh}
            gradedRefresh={store.gradedRefresh} certLastFetched={store.certLastFetched}
            certCount={new Set([...holdings, ...watchlist].filter((i) => i.cert).map((i) => i.cert)).size}
            missingCerts={
              new Set(
                [...holdings, ...watchlist]
                  .filter((i) => i.cert && (store.certSales[i.cert] ?? []).length === 0)
                  .map((i) => i.cert),
              ).size
            }
            photoCount={
              new Set(
                [...holdings, ...watchlist]
                  .filter((i) => i.cert && store.certImages[i.cert])
                  .map((i) => i.cert),
              ).size
            }
            historyGaps={historyGaps} gapTotal={gapTotal} cost={refreshCost}
            usage={store.usage} onRefreshGraded={(o) => void store.refreshGraded(o)}
            onImport={store.importFile} onTemplate={handleTemplate} onExport={handleExport}
            onClear={() => void store.clearAll()}
            onClearList={store.clearList}
            holdingCount={holdings.length}
            watchCount={watchlist.length}
          />
        )}
        </ErrorBoundary>
      </main>

      <footer className="max-w-[1400px] mx-auto px-4 py-6 text-xs muted leading-relaxed">
        Estimates, not appraisals. Every value carries a confidence level — treat a low-confidence
        number as a starting point for your own research, not a price.
        <span className="block mt-1 tabular">Build {__BUILD_STAMP__} UTC</span>
      </footer>
    </div>
  )
}
