import type { Response } from 'express'

/** Server-Sent Events: canal servidor → browser para logs, estados e scans. */
const clients = new Set<Response>()

export function addSseClient(res: Response): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  })
  res.write(': ligado\n\n')
  clients.add(res)
  const ping = setInterval(() => res.write(': ping\n\n'), 25_000)
  res.on('close', () => {
    clearInterval(ping)
    clients.delete(res)
  })
}

export function broadcast(event: string, data: unknown): void {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  for (const c of clients) c.write(msg)
}
