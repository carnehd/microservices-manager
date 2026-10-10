import { spawn, type ChildProcess } from 'child_process'
import treeKill from 'tree-kill'
import type { StreamEnd, StreamLine } from '../shared/types'
import { logCmd } from './cmdlog'
import { cmd, cmdLine, engineEnv } from './engine'
import { broadcast } from './events'

// Processos longos do motor (logs -f, pull, build, events): cada linha vai por SSE (stream:line) com o id do stream.
const procs = new Map<string, ChildProcess>()
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g

export function startStream(id: string, args: string[], opts: { cwd?: string; replace?: boolean } = {}): void {
  if (procs.has(id)) {
    if (!opts.replace) return
    stopStream(id)
  }
  const line = cmdLine(args)
  logCmd(`${line}   # stream ${id}`, 'cmd')
  const child = spawn(cmd(), args, { cwd: opts.cwd, env: engineEnv(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  procs.set(id, child)
  const t0 = Date.now()
  const emit = (stream: StreamLine['stream'], text: string): void => broadcast('stream:line', { id, stream, text, ts: Date.now() } satisfies StreamLine)
  emit('system', `▶ ${line}`)
  const pipe = (s: NodeJS.ReadableStream | null, name: 'stdout' | 'stderr'): void => {
    if (!s) return
    let buf = ''
    s.setEncoding('utf8')
    s.on('data', (chunk: string) => {
      buf += chunk
      let i: number
      while ((i = buf.indexOf('\n')) >= 0) { emit(name, buf.slice(0, i).replace(/\r$/, '').replace(ANSI, '')); buf = buf.slice(i + 1) }
      // progresso do pull vem com \r sem \n: mostra o último troço
      if (buf.includes('\r')) { const parts = buf.split('\r'); buf = parts.pop() ?? ''; const last = parts.filter(Boolean).pop(); if (last) emit(name, last.replace(ANSI, '')) }
    })
    s.on('end', () => { if (buf.trim()) emit(name, buf.replace(ANSI, '')) })
  }
  pipe(child.stdout, 'stdout')
  pipe(child.stderr, 'stderr')
  child.on('error', (err) => { emit('system', `✖ ${err.message}`); logCmd(err.message, 'err') })
  child.on('close', (code) => {
    procs.delete(id)
    emit('system', `■ ended (exit ${code ?? 'null'})`)
    logCmd(`stream ${id}: exit ${code ?? 'null'} · ${Math.round((Date.now() - t0) / 1000)} s`, code === 0 ? 'ok' : 'err')
    broadcast('stream:end', { id, code } satisfies StreamEnd)
  })
}

export function stopStream(id: string): void {
  const p = procs.get(id)
  if (!p?.pid) return
  treeKill(p.pid, 'SIGTERM', () => {})
}

export function stopAllStreams(): void {
  for (const id of procs.keys()) stopStream(id)
}

export const activeStreams = (): string[] => [...procs.keys()]
