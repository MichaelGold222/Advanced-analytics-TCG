/**
 * Inline the built bundle into one standalone .html.
 *
 * Run after `SINGLE_FILE=1 vite build`, which emits a single JS and CSS file.
 * The result opens straight from a filesystem or any static host with nothing
 * to resolve — no asset paths, no chunk loading.
 */
import { readFile, writeFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

const dist = 'dist'
const assets = await readdir(join(dist, 'assets'))
const js = assets.filter((f) => f.endsWith('.js'))
const css = assets.filter((f) => f.endsWith('.css'))

if (js.length !== 1) throw new Error(`expected exactly one JS bundle, found ${js.length}: ${js.join(', ')}`)
if (css.length > 1) throw new Error(`expected at most one stylesheet, found ${css.join(', ')}`)

const jsSource = await readFile(join(dist, 'assets', js[0]), 'utf8')
const cssSource = css.length ? await readFile(join(dist, 'assets', css[0]), 'utf8') : ''
let html = await readFile(join(dist, 'index.html'), 'utf8')

// A literal </script> inside the bundle would close the tag early.
const guard = (s) => s.replace(/<\/script/gi, '<\\/script')

html = html
  .replace(/\s*<script[^>]*src="[^"]*"[^>]*><\/script>/g, '')
  .replace(/\s*<link[^>]*rel="modulepreload"[^>]*>/g, '')
  .replace(/\s*<link[^>]*rel="stylesheet"[^>]*>/g, '')
  // Replacer functions, not strings: `$&` and `` $` `` in a replacement string
  // are substitution patterns, and a minified bundle is full of both.
  .replace('</head>', () => `  <style>\n${cssSource}\n  </style>\n  </head>`)
  .replace('</body>', () => `  <script type="module">\n${guard(jsSource)}\n  </script>\n  </body>`)

const out = 'dist/pokemon-portfolio-analytics.html'
await writeFile(out, html)
console.log(`${out} — ${(Buffer.byteLength(html) / 1024 / 1024).toFixed(2)} MB, self-contained`)
