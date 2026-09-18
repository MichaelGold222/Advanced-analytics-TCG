import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: './',
  build: {
    rolldownOptions: {
      output: {
        // Charting is the bulk of the bundle and changes rarely; keeping it in
        // its own chunk lets it stay cached across app updates.
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
