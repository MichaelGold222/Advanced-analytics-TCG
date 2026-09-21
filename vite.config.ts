import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const SINGLE_FILE = process.env.SINGLE_FILE === '1'

// Stamped into the page so a stale copy can be told from a current one
// without guessing — the usual answer to "did my reload take?".
const BUILD_STAMP = new Date().toISOString().slice(0, 16).replace('T', ' ')

export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: './',
  define: { __BUILD_STAMP__: JSON.stringify(BUILD_STAMP) },
  build: {
    // SINGLE_FILE collapses everything into one bundle so `npm run build:single`
    // can inline it into a standalone .html with no assets to resolve. The
    // default build keeps charting split, since it is the bulk of the bytes and
    // changes rarely, so it stays cached across app updates.
    cssCodeSplit: !SINGLE_FILE,
    rolldownOptions: {
      output: SINGLE_FILE
        ? { inlineDynamicImports: true }
        : {
            manualChunks: (id: string) =>
              /node_modules[/\\](recharts|victory-vendor|d3-)/.test(id) ? 'charts' : undefined,
          },
    },
  },
  test: {
    // Default to Node; files needing a DOM declare it with a @vitest-environment
    // docblock, which this version honours where environmentMatchGlobs does not.
    environment: 'node',
    // .tsx as well, so a component can be rendered and asserted on. The error
    // boundary is the reason: what it draws when something throws is the only
    // thing standing between a bad render and a blank page, and that is worth
    // a test rather than a hope.
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'scripts/**/*.test.ts'],
  },
})
