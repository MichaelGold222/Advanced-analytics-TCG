import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const SINGLE_FILE = process.env.SINGLE_FILE === '1'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: './',
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
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
