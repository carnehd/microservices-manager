import { exec } from 'child_process'
import express from 'express'
import { existsSync } from 'fs'
import { join } from 'path'
import { apiRouter, shutdown } from './api'
import { dataDir } from './settings'

// Nome próprio (não PORT) para não ser apanhado por variáveis PORT que IDEs/terminais definem por defeito
const PORT = Number(process.env.MSM_PORT) || 3210
const HOST = '127.0.0.1' // só local: esta API lança processos na máquina
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
    res.type('text').send('UI não compilada: corre "npm run build" (em desenvolvimento usa "npm run dev", que abre o Vite em http://localhost:5173).')
  })
}

const server = app.listen(PORT, HOST, () => {
  const url = `http://localhost:${PORT}`
  console.log(`Microservices Manager a correr em ${url}`)
  console.log(`Definições em ${dataDir()}`)
  if (!noOpen && hasUi) openBrowser(url)
})
server.on('error', async (err: NodeJS.ErrnoException) => {
  if (err.code !== 'EADDRINUSE') {
    console.error('Erro ao arrancar o servidor:', err.message)
    process.exit(1)
  }
  const url = `http://localhost:${PORT}`
  // Se quem ocupa a porta é outra instância desta app, não é erro: abre-se o browser nela.
  const ours = await fetch(`http://127.0.0.1:${PORT}/api/settings`).then((r) => r.ok).catch(() => false)
  if (ours) {
    console.log(`A app já está a correr em ${url} (noutra janela/terminal) — a abrir o browser nessa instância.`)
    console.log('Para a parar, faz Ctrl+C na janela onde está a correr.')
    if (!noOpen) openBrowser(url)
    process.exit(0)
  }
  console.error(`\nA porta ${PORT} está ocupada por outro programa. Para usar outra porta: MSM_PORT=4000 npm start`)
  process.exit(1)
})

function openBrowser(url: string): void {
  const cmd = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`
  exec(cmd, () => {})
}

let closing = false
async function stop(signal: string): Promise<void> {
  if (closing) return
  closing = true
  console.log(`\n${signal}: a parar os processos filhos…`)
  // Rede de segurança: sai mesmo que a paragem de um processo filho encrave
  // (sem .unref(): tem de disparar mesmo que o event loop esteja "vazio")
  setTimeout(() => {
    console.error('A paragem demorou demasiado; a sair à força.')
    process.exit(1)
  }, 10_000)
  try {
    await shutdown()
  } catch (e) {
    console.error('Erro ao parar processos filhos:', e instanceof Error ? e.message : e)
  }
  server.close()
  process.exit(0)
}
process.on('SIGINT', () => void stop('SIGINT'))
process.on('SIGTERM', () => void stop('SIGTERM'))
