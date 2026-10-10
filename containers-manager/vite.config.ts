import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// UI em src/client; em dev o Vite (5173) faz proxy da API para o servidor Express (3310)
export default defineConfig({
  root: 'src/client',
  plugins: [react()],
  build: { outDir: '../../dist/client', emptyOutDir: true },
  server: { port: 5173, proxy: { '/api': 'http://127.0.0.1:3310' } }
})
