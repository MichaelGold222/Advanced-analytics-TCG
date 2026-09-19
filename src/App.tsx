import { useEffect, useMemo, useState } from 'react'
import { AlertCircle, Monitor, Moon, RefreshCw, Sun, X } from 'lucide-react'
import { DataPanel } from './components/DataPanel'
import { HoldingsTable } from './components/HoldingsTable'
import { SegmentAllocation } from './components/SegmentAllocation'
import { SegmentPerformance } from './components/SegmentPerformance'
import { PriceCoverage } from './components/PriceCoverage'
import { StatTile } from './components/StatTile'
import { TopHoldings, type HoldingBar } from './components/TopHoldings'
import { UploadZone } from './components/UploadZone'
import { ValueTrend } from './components/ValueTrend'
import { WatchlistPanel } from './components/WatchlistPanel'
import { useTheme } from './hooks/useTheme'
import { analyzeItem } from './lib/analytics'
import { money, pct, relativeTime } from './lib/format'
import { itemKey } from './lib/key'
import { analyzeHoldings, buildValueTrend, computePortfolioStats, holdingKey, unitValue } from './lib/portfolio'
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

  const holdingAnalyses = useMemo(() => analyzeHoldings(holdings, series), [holdings, series])

  const watchAnalyses = useMemo(() => {
    const out = new Map<string, ItemAnalysis>()
    for (const w of watchlist) {
      const key = itemKey(w)
      const s = series.get(key) ?? { key, points: [] }
      out.set(key, analyzeItem(s, w.askingPrice ?? null))
    }
    return out
  }, [watchlist, series])

  const stats = useMemo(() => computePortfolioStats(holdings, holdingAnalyses), [holdings, holdingAnalyses])
  const trend = useMemo(() => buildValueTrend(holdings, series), [holdings, series])

  const topHoldings = useMemo<HoldingBar[]>(() => {
    const byName = new Map<string, HoldingBar>()
    for (const h of holdings) {
      const uv = unitValue(holdingAnalyses.get(holdingKey(h)))
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
            onClick={() => void store.refreshPrices()}
            disabled={store.refresh.running || isEmpty}
          >
            <RefreshCw className={`size-4 ${store.refresh.running ? 'animate-spin' : ''}`} aria-hidden />
            {store.refresh.running ? `${store.refresh.done}/${store.refresh.total}` : 'Refresh prices'}
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

        {isEmpty && tab !== 'data' ? (
          <div className="card p-8 max-w-3xl mx-auto mt-6">
            <h2 className="text-xl font-semibold mb-2">Start with your collection sheet</h2>
            <p className="text-sm secondary mb-6 leading-relaxed">
              Drop in an Excel or CSV export and it is broken down into sealed, vintage, modern and Pikachu promos.
              Nothing is uploaded anywhere — the file is read in this browser and stored on this device.
            </p>
            <UploadZone
              label="Choose a file"
              hint="Any .xlsx or .csv with a header row. Column names are matched for you, so “Paid”, “Purchase Price” and “Cost Basis” all work."
              onFile={(f) => store.importFile(f, 'portfolio')}
            />
            <div className="flex flex-wrap gap-2 mt-5 justify-center">
              <button type="button" className="btn" onClick={handleTemplate}>Download a template</button>
              <button type="button" className="btn" onClick={() => setTab('watchlist')}>Or add a card you are watching</button>
            </div>
          </div>
        ) : tab === 'dashboard' ? (
          <div className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <StatTile
                hero label="Market value"
                value={stats.roi == null && stats.marketValue === 0 ? '—' : money(stats.marketValue, { compact: stats.marketValue >= 100_000 })}
                delta={stats.roi == null ? undefined : {
                  value: `${money(stats.unrealized)} (${pct(stats.roi)})`,
                  direction: stats.unrealized > 0 ? 'up' : stats.unrealized < 0 ? 'down' : 'flat',
                }}
                sub={stats.unvalued > 0 ? `${stats.unvalued} position${stats.unvalued === 1 ? '' : 's'} not valued` : undefined}
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
              lastRefresh={store.lastRefresh} refresh={store.refresh}
              onRefresh={() => void store.refreshPrices()} onGoToData={() => setTab('data')}
            />

            <div className="grid gap-4 lg:grid-cols-2">
              <SegmentAllocation stats={stats} />
              <SegmentPerformance stats={stats} />
            </div>

            <ValueTrend data={trend} />
            <TopHoldings rows={topHoldings} concentration={stats.concentration} />
          </div>
        ) : tab === 'holdings' ? (
          <HoldingsTable
            holdings={holdings} analyses={holdingAnalyses}
            onOverride={(id, s) => store.setSegmentOverride(id, s, 'holding')}
            onRemove={store.removeHolding}
          />
        ) : tab === 'watchlist' ? (
          <WatchlistPanel
            watchlist={watchlist} analyses={watchAnalyses}
            onAdd={store.addWatchItem} onRemove={store.removeWatchItem}
            onOverride={(id, s) => store.setSegmentOverride(id, s, 'watch')}
            onUpdate={store.updateWatchItem}
            onImport={(f) => store.importFile(f, 'watchlist')}
          />
        ) : (
          <DataPanel
            importLog={store.importLog} refresh={store.refresh}
            onImport={store.importFile} onTemplate={handleTemplate} onExport={handleExport}
            onClear={() => void store.clearAll()}
          />
        )}
      </main>

      <footer className="max-w-[1400px] mx-auto px-4 py-6 text-xs muted leading-relaxed">
        Estimates, not appraisals. Every value carries a confidence level — treat a low-confidence
        number as a starting point for your own research, not a price.
      </footer>
    </div>
  )
}
