import { AsyncLocalStorage } from 'async_hooks'
import type { CmdLogEntry } from '../shared/types'
import { broadcast } from './events'

// Registo global dos comandos de container (podman/docker) corridos pela app, para a "consola" comum a todas as páginas.
const MAX = 400
const buf: CmdLogEntry[] = []
let seq = 0

// Pedidos de fundo (pollers de estado) correm em "silêncio" para não inundar a consola comum.
const silent = new AsyncLocalStorage<boolean>()
export function withSilent<T>(fn: () => T): T {
  return silent.run(true, fn)
}
function isSilent(): boolean {
  return silent.getStore() === true
}

/** Regista um comando executado (ou o seu resultado) e emite-o por SSE para a consola comum. */
export function logCmd(text: string, kind: CmdLogEntry['kind']): void {
  if (isSilent()) return
  const entry: CmdLogEntry = { seq: ++seq, time: Date.now(), text, kind }
  buf.push(entry)
  if (buf.length > MAX) buf.splice(0, buf.length - MAX)
  broadcast('cmd:log', entry)
}

export function recentCmds(): CmdLogEntry[] {
  return [...buf]
}
