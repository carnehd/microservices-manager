import type { CmdLogEntry } from '../shared/types'
import { broadcast } from './events'

// Terminal comum da UI: todos os comandos corridos (e o resultado), com buffer para quem liga mais tarde.
const MAX = 500
const buf: CmdLogEntry[] = []

export function logCmd(text: string, kind: CmdLogEntry['kind']): void {
  const e: CmdLogEntry = { ts: Date.now(), text, kind }
  buf.push(e)
  if (buf.length > MAX) buf.splice(0, buf.length - MAX)
  broadcast('cmd:log', e)
}

export const recentCmds = (): CmdLogEntry[] => buf.slice()
