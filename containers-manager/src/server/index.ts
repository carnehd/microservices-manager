import { exec } from 'child_process'
import express from 'express'
import { existsSync } from 'fs'
import { join } from 'path'
import { apiRouter, shutdown } from './api'
import { logCmd } from './cmdlog'
import { dataDir } from './settings'

// Nome próprio (não PORT) para não apanhar variáveis PORT definidas por IDEs/terminais
const PORT = Number(process.env.CM_PORT) || 3310
const HOST = '127.0.0.1' // só local: esta API corre comandos na máquina
const noOpen = process.argv.includes('--no-open')
// __dirname é src/server (tsx) ou dist/server (bundle): a raiz do projeto está dois níveis acima
const clientDir = join(__dirname, '..', '..', 'dist', 'client')
const hasUi = existsSync(join(clientDir, 'index.html'))

const app = express()
app.use(express.json({ limit: '1mb' }))
app.use('/api', apiRouter)
if (hasUi) {
  app.use(express.static(clientDir))
  app.use((req, res, next) => {
    if (req.method !== 'GET' || req.path.startsWith('/api')) return next()
    res.sendFile(join(clientDir, 'index.html'))
  })
} else {
  app.get('/', (_req, res) => {
    res.type('text').send('UI not built: run "npm run build" (in development use "npm run dev", which opens Vite at http://localhost:5173).')
  })
}

const server = app.listen(PORT, HOST, () => {
  const url = `http://localhost:${PORT}`
  console.log(`Containers Manager a correr em ${url}`)
  console.log(`Definições em ${dataDir()}`)
  if (!noOpen && hasUi) openBrowser(url)
})
server.on('error', async (err: NodeJS.ErrnoException) => {
  if (err.code !== 'EADDRINUSE') { console.error('Erro ao arrancar o servidor:', err.message); process.exit(1) }
  const url = `http://localhost:${PORT}`
  const ours = await fetch(`http://127.0.0.1:${PORT}/api/settings`).then((r) => r.ok).catch(() => false)
  if (ours) {
    console.log(`A app já está a correr em ${url} — a abrir o browser nessa instância.`)
    if (!noOpen) openBrowser(url)
    process.exit(0)
  }
  console.error(`\nA porta ${PORT} está ocupada por outro programa. Para usar outra porta: CM_PORT=4000 npm start`)
  process.exit(1)
})

function openBrowser(url: string): void {
  const c = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`
  logCmd(c, 'cmd')
  exec(c, () => {})
}

for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => { shutdown(); process.exit(0) })
