/**
 * Serve the built app with a same-origin price proxy.
 *
 * Some hosts forbid a page from calling an outside service, and a browser
 * reports that exactly like being offline, so no amount of client-side work
 * gets past it. Serving the app ourselves and forwarding price requests from
 * this process means the page only ever talks to its own origin — there is no
 * cross-origin request left to block.
 *
 *   npm run serve        → http://localhost:4300
 *   npm run serve -- 8080
 */
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'

const port = Number(process.argv[2]) || 4300
const root = 'dist'
// Overridable so the proxy path can be exercised against a stub in tests.
const UPSTREAM = process.env.PRICE_UPSTREAM || 'https://api.pokemontcg.io'
const PROXY_PREFIX = '/api/pokemontcg'

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
}

/** Point the page at the proxy, so it never attempts a cross-origin call. */
function injectApiBase(html) {
  const meta = `<meta name="price-api-base" content="${PROXY_PREFIX}" />`
  return html.includes('price-api-base') ? html : html.replace('</title>', `</title>\n    ${meta}`)
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${port}`)

  if (url.pathname.startsWith(PROXY_PREFIX)) {
    const target = `${UPSTREAM}${url.pathname.slice(PROXY_PREFIX.length)}${url.search}`
    try {
      const upstream = await fetch(target, {
        headers: req.headers['x-api-key'] ? { 'X-Api-Key': String(req.headers['x-api-key']) } : undefined,
      })
      const body = await upstream.text()
      res.writeHead(upstream.status, { 'content-type': 'application/json; charset=utf-8' })
      res.end(body)
    } catch (err) {
      // The proxy could not reach the provider — say so as the provider, so the
      // page reports a real upstream problem rather than a blocked page.
      res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: { message: `Proxy could not reach ${UPSTREAM}: ${err.message}` } }))
    }
    return
  }

  // Everything else is a static file; unknown paths fall back to the app shell.
  const requested = url.pathname === '/' ? '/index.html' : url.pathname
  const safe = normalize(requested).replace(/^(\.\.[/\\])+/, '')
  try {
    const file = await readFile(join(root, safe))
    const type = TYPES[extname(safe)] ?? 'application/octet-stream'
    res.writeHead(200, { 'content-type': type })
    res.end(extname(safe) === '.html' ? injectApiBase(file.toString()) : file)
  } catch {
    try {
      const shell = await readFile(join(root, 'index.html'), 'utf8')
      res.writeHead(200, { 'content-type': TYPES['.html'] })
      res.end(injectApiBase(shell))
    } catch {
      res.writeHead(404)
      res.end('Not found. Run `npm run build` first.')
    }
  }
})

server.listen(port, () => {
  console.log(`\n  Pokémon Portfolio Analytics → http://localhost:${port}`)
  console.log(`  Price requests proxied through this server, so nothing can block them.\n`)
})
