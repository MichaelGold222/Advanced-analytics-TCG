/**
 * Fetch sold comps for the collection and write them where the dashboard reads.
 *
 * Runs on a schedule in CI, not in the browser: the Parse key must never reach
 * a public page, and a graded collection is priced by certificate number,
 * which the bulk endpoint resolves 200 at a time — one call for most people.
 *
 * The cert list comes from the PORTFOLIO_CERTS secret, not from a file in the
 * repository: this repository is public, and a collection sheet carries cost
 * basis. Secrets are encrypted and never published. The feed this writes is
 * served with the site, so it deliberately holds only certificate numbers and
 * public sale prices — nothing about what anything cost.
 *
 *   PARSE_API_KEY=... PORTFOLIO_CERTS="PSA 12345678, PSA 87654321" \
 *     npx tsx scripts/fetch-prices.ts [out.json]
 *
 * A path may still be passed as a second argument for local use.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import Papa from 'papaparse'
import {
  batchCerts, buildFeed, isSupportedGrader, mergeFeeds, parseBulkResponse,
  type CertPrices, type CertRequest, type PriceFeed, type SupportedGrader,
} from '../src/lib/providers/cardladder'
import { rowsToHoldings, type Cell } from '../src/lib/ingest'

const BASE = process.env.PARSE_BASE_URL ?? 'https://api.parse.bot'
const KEY = process.env.PARSE_API_KEY ?? ''
const SCRAPER = process.env.PARSE_SCRAPER_ID ?? ''
const OUT = process.argv[2] ?? 'public/prices.json'
const PORTFOLIO = process.argv[3] ?? process.env.PORTFOLIO_PATH ?? ''

/** The feed the last run left, or null on a first run or an unreadable file. */
async function readFeed(path: string): Promise<PriceFeed | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
    const feed = parsed as PriceFeed
    return feed && typeof feed === 'object' && feed.byCert ? feed : null
  } catch {
    // Missing on the first run, and a corrupt file must not stop the fetch —
    // but it must not silently become an empty history either, which is why
    // the run prints the before and after counts.
    return null
  }
}

function countSales(feed: PriceFeed | null): number {
  if (!feed?.byCert) return 0
  return Object.values(feed.byCert).reduce((n, e) => n + (e.sales?.length ?? 0), 0)
}

function die(message: string): never {
  console.error(`\n  ${message}\n`)
  process.exit(1)
}

/** Resolve the callable scraper: the task record's id is a different thing. */
async function resolveScraperId(): Promise<string> {
  if (SCRAPER) return SCRAPER
  const res = await fetch(`${BASE}/dispatch/tasks?limit=100`, { headers: { 'X-API-Key': KEY } })
  if (!res.ok) die(`Could not list APIs on this Parse account (HTTP ${res.status}).`)
  const body = (await res.json()) as { tasks?: unknown[] } | unknown[]
  const tasks = (Array.isArray(body) ? body : (body.tasks ?? [])) as Record<string, string>[]
  const task = tasks.find((t) => /cardladder/i.test(`${t.slug ?? ''} ${t.url ?? ''} ${t.name ?? ''}`))
  if (!task) die('No Card Ladder API found on this Parse account.')

  const detail = await fetch(`${BASE}/dispatch/tasks/${task.id}`, { headers: { 'X-API-Key': KEY } })
  if (!detail.ok) die(`Could not read that API's detail (HTTP ${detail.status}).`)
  const d = (await detail.json()) as { result_scraper_id?: string; scraper_id?: string }
  const id = d.result_scraper_id ?? d.scraper_id
  if (!id) die('That API has no callable scraper id yet.')
  return id
}

/**
 * Parse the cert list.
 *
 * Accepts a JSON array of {cert_number, grading_company}, or lines of
 * "PSA 12345678" / "12345678,PSA" / "PSA,12345678" — whichever is easiest to
 * paste into a secret. Comma, semicolon and newline all separate entries.
 */
export function parseCertList(raw: string): { certs: CertRequest[]; rejected: string[] } {
  const text = raw.trim()
  if (!text) return { certs: [], rejected: [] }

  if (text.startsWith('[') || text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text) as unknown
      const list = (Array.isArray(parsed) ? parsed : (parsed as { certs?: unknown[] }).certs ?? []) as Record<string, string>[]
      const certs: CertRequest[] = []
      const rejected: string[] = []
      for (const item of list) {
        const cert = String(item?.cert_number ?? item?.cert ?? '').trim()
        const grader = String(item?.grading_company ?? item?.grader ?? '').toUpperCase().trim()
        if (cert && isSupportedGrader(grader)) certs.push({ cert_number: cert, grading_company: grader })
        else rejected.push(JSON.stringify(item))
      }
      return dedupe(certs, rejected)
    } catch {
      return { certs: [], rejected: ['the value is not valid JSON'] }
    }
  }

  // Scan tokens rather than splitting on a separator: a comma divides entries
  // in "PSA 111, PSA 222" but fields in "111,PSA", and only pairing as the
  // tokens arrive gets both right, in either order.
  const certs: CertRequest[] = []
  const rejected: string[] = []
  const tokens = text
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .join(' ')
    .split(/[\s,;]+/)
    .filter(Boolean)

  let grader: SupportedGrader | null = null
  let cert: string | null = null
  const flush = () => {
    if (grader && cert) certs.push({ cert_number: cert, grading_company: grader })
    else if (grader || cert) rejected.push(grader ?? cert ?? '')
    grader = null
    cert = null
  }
  for (const token of tokens) {
    if (isSupportedGrader(token)) {
      if (grader) flush()
      grader = token.toUpperCase() as SupportedGrader
    } else if (/^[0-9][0-9-]*$/.test(token)) {
      if (cert) flush()
      cert = token
    } else {
      rejected.push(token)
      continue
    }
    if (grader && cert) flush()
  }
  flush()

  return dedupe(certs, rejected)
}

/** One lookup per slab, however many times it is listed. */
function dedupe(certs: CertRequest[], rejected: string[]) {
  const seen = new Set<string>()
  return {
    certs: certs.filter((c) => {
      const k = `${c.grading_company}:${c.cert_number}`
      if (seen.has(k)) return false
      seen.add(k)
      return true
    }),
    rejected,
  }
}

/** Fallback for local runs: pull certs out of a spreadsheet on disk. */
async function certsFromFile(path: string): Promise<{ certs: CertRequest[]; rejected: string[] }> {
  let csv: string
  try {
    csv = await readFile(path, 'utf8')
  } catch {
    die(`No portfolio at ${path}.`)
  }
  const rows = Papa.parse<string[]>(csv, { skipEmptyLines: true }).data as Cell[][]
  const { items } = rowsToHoldings({ name: 'Portfolio', rows })
  const certs: CertRequest[] = []
  const rejected: string[] = []
  for (const h of items) {
    const grader = h.grader?.toUpperCase()
    if (h.cert && isSupportedGrader(grader)) certs.push({ cert_number: h.cert, grading_company: grader })
    else rejected.push(h.name)
  }
  return dedupe(certs, rejected)
}

async function fetchBatch(scraperId: string, certs: CertRequest[]): Promise<CertPrices[]> {
  const res = await fetch(`${BASE}/scraper/${scraperId}/get_cert_values_bulk`, {
    method: 'POST',
    headers: { 'X-API-Key': KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ certs }),
  })
  if (!res.ok) {
    throw new Error(`get_cert_values_bulk returned HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
  }
  return parseBulkResponse(await res.json())
}

async function main() {
  if (!KEY) die('PARSE_API_KEY is not set.')

  const { certs, rejected } = PORTFOLIO
    ? await certsFromFile(PORTFOLIO)
    : parseCertList(process.env.PORTFOLIO_CERTS ?? '')

  console.log(`  ${certs.length} cert${certs.length === 1 ? '' : 's'} to price.`)
  if (rejected.length) {
    console.log(`  ${rejected.length} entr${rejected.length === 1 ? 'y' : 'ies'} skipped (no cert, or a grader other than PSA/BGS/CGC/SGC): ${rejected.slice(0, 5).join(' | ')}${rejected.length > 5 ? ' …' : ''}`)
  }
  if (certs.length === 0) {
    die('No certs to price. Set the PORTFOLIO_CERTS secret to lines like "PSA 12345678".')
  }

  const scraperId = await resolveScraperId()
  const batches = batchCerts(certs)
  console.log(`  ${batches.length} call${batches.length === 1 ? '' : 's'} to make.`)

  const entries: CertPrices[] = []
  const errors: PriceFeed['errors'] = []
  for (const [i, batch] of batches.entries()) {
    try {
      const got = await fetchBatch(scraperId, batch)
      entries.push(...got)
      console.log(`  batch ${i + 1}/${batches.length}: ${got.length} of ${batch.length} priced`)
      // A cert the upstream could not match comes back missing, not flagged.
      const returned = new Set(got.map((g) => g.cert))
      for (const c of batch) {
        if (!returned.has(c.cert_number)) errors.push({ cert: c.cert_number, message: 'No match at Card Ladder' })
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`  batch ${i + 1}/${batches.length} failed: ${message}`)
      for (const c of batch) errors.push({ cert: c.cert_number, message })
    }
  }

  // Merged with whatever the last run wrote, never replacing it. The upstream
  // hands back only the newest few sales per cert, so overwriting would leave
  // a file holding a sliding window of recent weeks — running this weekly for
  // a year would then produce exactly as little history as running it once.
  const previous = await readFeed(OUT)
  const feed = mergeFeeds(previous, buildFeed(entries, errors))
  const withSales = entries.filter((e) => e.points.length > 0).length
  const before = countSales(previous)
  const after = countSales(feed)
  await mkdir(dirname(OUT), { recursive: true })
  await writeFile(OUT, `${JSON.stringify(feed, null, 2)}\n`)

  console.log(`\n  ${OUT}: ${entries.length} certs, ${withSales} with sold comps, ${errors.length} unmatched.`)
  console.log(`  sales on record: ${before} -> ${after} (+${after - before} new)`)
  if (entries.length > 0 && withSales === 0) {
    die('Every cert resolved but none carried sales. Something changed upstream; not overwriting with empty data would be safer — check the output.')
  }
}

// Only run when invoked directly, so the helpers above stay importable by tests.
if (process.argv[1]?.endsWith('fetch-prices.ts')) {
  main().catch((err) => die(err instanceof Error ? err.message : String(err)))
}
