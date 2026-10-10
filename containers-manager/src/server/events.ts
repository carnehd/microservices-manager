import type { Response } from 'express'

// Server-Sent Events: a UI liga-se a /api/events e recebe tudo o que acontece (comandos, linhas de streams, eventos do motor).
const clients = new Set<Response>()

export function addClient(res: Response): void {
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()
  res.write('event: hello\ndata: {}\n\n')
  clients.add(res)
  const ping = setInterval(() => res.write(': ping\n\n'), 25_000)
  res.on('close', () => { clearInterval(ping); clients.delete(res) })
}

export function broadcast(event: string, data: unknown): void {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  for (const c of clients) c.write(payload)
}
