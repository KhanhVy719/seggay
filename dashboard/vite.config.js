import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  base: '/dashboard/',
  build: {
    outDir: 'dist',
  },
  server: {
    proxy: {
      '/api': 'http://localhost:30001',
      '/carrier': 'http://localhost:30001',
      '/upload': 'http://localhost:30001',
      '/player': 'http://localhost:30001',
      '/carrier-player.js': 'http://localhost:30001',
      '/carrier-worker.js': 'http://localhost:30001',
    }
  }
})
