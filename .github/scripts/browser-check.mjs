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
// The endpoint scrapes; give it room. The button stays in its fetching state
// until the pictures are in too, so this waits for the whole errand — reading
// the page the moment prices land measured a call still in flight.
for (let i = 0; i < 36; i++) {
  await page.waitForTimeout(5000)
  const running = await page.getByRole('button', { name: /Fetching/ }).count()
  if (running === 0 && i > 1) break
}
await page.waitForTimeout(3000)

const banner = await page.locator('[role=alert], .error, [class*=error]').allTextContents()
console.log('\n--- what the page shows ---')
console.log('  banner:', banner.filter(Boolean).map(redact).join(' | ') || '(none)')
const cached = await page.evaluate(() => !!localStorage.getItem('aa-tcg.parseScraperId'))
console.log('  scraper id cached:', cached)
const body = await page.locator('main').innerText()
console.log('  fetch section:', redact(body.split('Graded cards')[1]?.slice(0, 500) ?? '(not found)'))

// What actually landed in the store, which is the question.
const stored = await page.evaluate(async () => {
  const open = indexedDB.open('keyval-store')
  const db = await new Promise((res, rej) => {
    open.onsuccess = () => res(open.result)
    open.onerror = () => rej(open.error)
  })
  const val = await new Promise((res, rej) => {
    const r = db.transaction('keyval').objectStore('keyval').get('advanced-analytics-tcg/v1')
    r.onsuccess = () => res(r.result)
    r.onerror = () => rej(r.error)
  })
  return {
    certSales: Object.keys(val?.certSales ?? {}).length,
    certImages: Object.keys(val?.certImages ?? {}).length,
    sampleImage: Object.values(val?.certImages ?? {})[0] ?? null,
  }
})
console.log('\n--- what reached storage ---')
console.log('  certs with sales :', stored.certSales)
console.log('  certs with photos:', stored.certImages)
console.log('  sample photo     :', JSON.stringify(stored.sampleImage))

// And did any <img> actually render?
const imgs = await page.evaluate(() => {
  const list = [...document.querySelectorAll('img')]
  return list.map((i) => ({ src: i.src.slice(0, 80), w: i.naturalWidth }))
})
console.log('  <img> on page    :', JSON.stringify(imgs.slice(0, 5)))

await browser.close()
