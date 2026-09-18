/** Display formatting. */
import type { Confidence, EntryVerdict } from './types'

export function money(v: number | null | undefined, opts: { compact?: boolean; decimals?: number } = {}): string {
  if (v == null || !Number.isFinite(v)) return '—'
  return v.toLocaleString(undefined, {
    style: 'currency',
    currency: 'USD',
    notation: opts.compact ? 'compact' : 'standard',
    maximumFractionDigits: opts.decimals ?? (opts.compact ? 1 : Math.abs(v) < 100 ? 2 : 0),
    minimumFractionDigits: opts.compact ? 0 : undefined,
  })
}

export function pct(v: number | null | undefined, decimals = 1): string {
  if (v == null || !Number.isFinite(v)) return '—'
  return `${v >= 0 ? '+' : ''}${(v * 100).toFixed(decimals)}%`
}

export function plainPct(v: number | null | undefined, decimals = 0): string {
  if (v == null || !Number.isFinite(v)) return '—'
  return `${(v * 100).toFixed(decimals)}%`
}

export function num(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—'
  return v.toLocaleString()
}

export function shortDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: '2-digit' })
}

export function relativeTime(iso: string | null): string {
  if (!iso) return 'never'
  const ms = Date.now() - Date.parse(iso)
  if (!Number.isFinite(ms)) return 'never'
  const mins = Math.round(ms / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

export const CONFIDENCE_LABEL: Record<Confidence, string> = {
  high: 'High confidence',
  medium: 'Medium confidence',
  low: 'Low confidence',
  none: 'No data',
}

export const VERDICT: Record<EntryVerdict, { label: string; tone: 'good' | 'warning' | 'serious' | 'critical' | 'neutral'; icon: string }> = {
  strong_buy: { label: 'Strong buy', tone: 'good', icon: '▲▲' },
  buy: { label: 'Buy', tone: 'good', icon: '▲' },
  fair: { label: 'Fair', tone: 'warning', icon: '●' },
  rich: { label: 'Rich', tone: 'serious', icon: '▼' },
  overpriced: { label: 'Overpriced', tone: 'critical', icon: '▼▼' },
  unknown: { label: 'No call', tone: 'neutral', icon: '?' },
}

export const TONE_COLOR: Record<string, string> = {
  good: 'var(--good)',
  warning: 'var(--warning)',
  serious: 'var(--serious)',
  critical: 'var(--critical)',
  neutral: 'var(--text-muted)',
}
