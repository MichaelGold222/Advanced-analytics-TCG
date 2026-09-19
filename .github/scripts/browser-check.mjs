/**
 * Reproduce the dashboard's graded fetch in a real browser.
 *
 * The key is read from the environment and put straight into the page's
 * localStorage, exactly where the app keeps it. It is never printed: only the
 * status codes, headers and errors the page sees are.
 */
import { chromium } from 'playwright'

const KEY = process.env.KEY
const CERTS = (process.env.CERTS || '93083876').split(/[,\s]+/).filter(Boolean)
const redact = (s) => (KEY ? String(s).replaceAll(KEY, '«key»') : String(s))

const browser = await chromium.launch()
const page = await browser.newPage()

page.on('console', (m) => console.log(`  console.${m.type()}: ${redact(m.text())}`))
page.on('pageerror', (e) => console.log(`  pageerror: ${redact(e.message)}`))
page.on('requestfailed', (r) => {
  if (!r.url().includes('parse.bot')) return
  console.log(`  REQUEST FAILED ${r.method()} ${new URL(r.url()).pathname} — ${r.failure()?.errorText}`)
})
page.on('response', async (res) => {
  if (!res.url().includes('parse.bot')) return
  const h = res.headers()
  const interesting = Object.entries(h)
    .filter(([k]) => /^(access-control-allow-origin|x-credits|x-ratelimit-(daily-)?(limit|remaining))/.test(k))
    .map(([k, v]) => `${k}=${v}`)
    .join(' ')
  console.log(`  ${res.status()} ${res.request().method()} ${new URL(res.url()).pathname}  ${interesting}`)
  if (!res.ok()) console.log(`    body: ${redact((await res.text().catch(() => '')).slice(0, 400))}`)
})

await page.goto('http://localhost:4173/', { waitUntil: 'networkidle' })
await page.evaluate(([key]) => localStorage.setItem('aa-tcg.parseKey', key), [KEY])

// Seed holdings the same way an upload would, then fetch.
const csv =
  'Card Name,Set,Condition,Cert Number,Qty,Cost Basis\n' +
  CERTS.map((c, i) => `Test Card ${i + 1},Base Set,PSA 10,${c},1,100`).join('\n')
await page.reload({ waitUntil: 'networkidle' })
await page.setInputFiles('input[type=file]', {
  name: 'certs.csv',
  mimeType: 'text/csv',
  buffer: Buffer.from(csv),
})
await page.waitForTimeout(1500)

await page.getByRole('button', { name: 'Data & settings' }).click()
console.log(`\n--- pressing fetch for ${CERTS.length} cert(s) ---`)
await page.getByRole('button', { name: /Fetch sold comps/ }).click()
await page.waitForTimeout(25000)

const banner = await page.locator('[role=alert], .error, [class*=error]').allTextContents()
console.log('\n--- what the page shows ---')
console.log('  banner:', banner.filter(Boolean).map(redact).join(' | ') || '(none)')
const stored = await page.evaluate(() => {
  const raw = localStorage.getItem('aa-tcg.parseScraperId')
  return { scraperCached: !!raw }
})
console.log('  scraper id cached:', stored.scraperCached)
const body = await page.locator('main').innerText()
console.log('  fetch section:', redact(body.split('Graded cards')[1]?.slice(0, 400) ?? '(not found)'))

await browser.close()
