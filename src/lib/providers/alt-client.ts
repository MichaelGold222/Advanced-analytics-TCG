/**
 * Calling Alt through Parse, from the browser.
 *
 * A separate API on the same Parse account, so a separate scraper id, its own
 * resolution and its own cache — but the same key and the same credit pool.
 */
import { altCounts, parseAltCerts, type AltCert, type AltCounts } from './alt'

const BASE = 'https://api.parse.bot'
const SCRAPER_STORAGE = 'aa-tcg.altScraperId'

/** Certs per bulk call. Conservative: `lookup_certs` has never been called. */
export const ALT_CERTS_PER_CALL = 25

let cachedScraper: string | null = null

export class AltError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'AltError'
    this.status = status
  }
}

function stored(): string | null {
  try {
    return localStorage.getItem(SCRAPER_STORAGE)
  } catch {
    return null
  }
}

/**
 * Find the Alt API on this account.
 *
 * Listing tasks and reading one are metadata and are charged nothing, so this
 * costs no credits — which is why it is done honestly each session rather than
 * guessed at or hard-coded.
 */
export async function resolveAltScraper(key: string, signal?: AbortSignal): Promise<string> {
  if (cachedScraper) return cachedScraper
  const saved = stored()
  if (saved) { cachedScraper = saved; return saved }

  const res = await fetch(`${BASE}/dispatch/tasks?limit=100`, { headers: { 'X-API-Key': key }, signal })
  if (!res.ok) throw new AltError(res.status, 'Could not list your Parse APIs.')
  const body = await res.json() as { tasks?: unknown[] } | unknown[]
  const tasks = (Array.isArray(body) ? body : body.tasks ?? []) as Record<string, unknown>[]

  const match = tasks.find((t) => /\balt\b|alt\.xyz|alt-xyz/i.test(
    ['slug', 'url', 'name'].map((k) => String(t[k] ?? '')).join(' '),
  ))
  if (!match) {
    throw new AltError(404, 'No Alt API on your Parse account. Subscribe to it at parse.bot, then try again.')
  }

  const detail = await fetch(`${BASE}/dispatch/tasks/${String(match.id)}`, {
    headers: { 'X-API-Key': key }, signal,
  })
  const d = await detail.json() as Record<string, unknown>
  const id = String(d.result_scraper_id ?? '')
  if (!id) throw new AltError(409, 'That Alt API has not finished building yet.')

  cachedScraper = id
  try { localStorage.setItem(SCRAPER_STORAGE, id) } catch { /* private window */ }
  return id
}

export interface AltFetchResult {
  certs: AltCert[]
  /** Certs asked about that came back with nothing. */
  missing: string[]
  creditsCharged: number
  creditsRemaining: number | null
  /**
   * What Alt said it did, totalled across the calls — so "Alt found nothing"
   * can be told apart from "Alt found everything and the reader failed".
   */
  counts: AltCounts
  /** The first response, kept when nothing parsed, so the shape can be seen. */
  unreadSample: string | null
}

/**
 * Sales history for a set of certificates.
 *
 * Measured at 2 credits for a single `lookup_cert`, which returned 1,422 sales
 * spanning six years. `lookup_certs` takes `cert_numbers` and has never been
 * called, so batches start small: a wrong guess about how many it accepts
 * should cost one modest call, not the whole collection's worth.
 */
export async function fetchAltCerts(
  certs: string[],
  opts: { key: string; signal?: AbortSignal; onProgress?: (done: number, total: number) => void },
): Promise<AltFetchResult> {
  const wanted = [...new Set(certs.map((c) => c.trim()).filter(Boolean))]
  if (wanted.length === 0) {
    return {
      certs: [], missing: [], creditsCharged: 0, creditsRemaining: null,
      counts: { requested: null, found: null, notFound: null, errors: null },
      unreadSample: null,
    }
  }

  const scraper = await resolveAltScraper(opts.key, opts.signal)
  const out: AltCert[] = []
  let charged = 0
  let remaining: number | null = null
  let done = 0
  const totals = { requested: 0, found: 0, notFound: 0, errors: 0 }
  let sawCounts = false
  let unreadSample: string | null = null

  for (let i = 0; i < wanted.length; i += ALT_CERTS_PER_CALL) {
    const batch = wanted.slice(i, i + ALT_CERTS_PER_CALL)
    const url = `${BASE}/scraper/${scraper}/lookup_certs?cert_numbers=${encodeURIComponent(batch.join(','))}`
    const res = await fetch(url, { headers: { 'X-API-Key': opts.key }, signal: opts.signal })

    const c = Number(res.headers.get('X-Credits-Charged'))
    if (Number.isFinite(c)) charged += c
    const r = res.headers.get('X-Credits-Remaining')
    if (r != null && r.trim() !== '' && Number.isFinite(Number(r))) remaining = Number(r)

    if (res.status === 401 || res.status === 403) {
      throw new AltError(res.status, 'That API key was refused by Alt.')
    }
    if (res.status === 402 || res.status === 429) {
      // Out of credits or rate limited: keep what came back, stop asking.
      throw new AltError(res.status, 'Out of credits, or asking too fast. What arrived has been kept.')
    }
    if (res.ok) {
      const body: unknown = await res.json()
      const before = out.length
      out.push(...parseAltCerts(body, batch))
      const c = altCounts(body)
      if (c.requested != null || c.found != null) {
        sawCounts = true
        totals.requested += c.requested ?? 0
        totals.found += c.found ?? 0
        totals.notFound += c.notFound ?? 0
        totals.errors += c.errors ?? 0
      }
      // Alt answered for cards this could not read: keep a sample, because
      // that is a bug here rather than a gap there, and the two have looked
      // identical from the outside twice now.
      if (out.length === before && (c.found ?? 0) > 0 && unreadSample == null) {
        unreadSample = JSON.stringify(body).slice(0, 400)
      }
    }

    done += batch.length
    opts.onProgress?.(Math.min(done, wanted.length), wanted.length)
  }

  const got = new Set(out.map((c) => c.cert))
  return {
    certs: out,
    missing: wanted.filter((c) => !got.has(c)),
    creditsCharged: charged,
    creditsRemaining: remaining,
    counts: sawCounts
      ? { requested: totals.requested, found: totals.found, notFound: totals.notFound, errors: totals.errors }
      : { requested: null, found: null, notFound: null, errors: null },
    unreadSample,
  }
}
