import { spawn, type ChildProcess } from 'child_process'
import { EventEmitter } from 'events'
import treeKill from 'tree-kill'
import { BUILD_MODES, type LogLine, type ProcState, type StartMode } from '../shared/types'

export interface StartOptions {
  id: string
  /** Linha de comando completa; corre através da shell (cmd.exe no Windows). */
  commandLine: string
  cwd: string
  env?: Record<string, string>
  mode: StartMode
  debugPort?: number
}

const MAX_LINES = 5000
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g
const READY_PATTERNS = [/Started \S+ in [\d.]+ seconds/, /Listening on: https?:\/\//]
const PORT_PATTERNS = [
  /(?:Tomcat|Netty|Jetty|Undertow) started on port(?:\(s\))?:? (\d+)/,
  /Listening on: https?:\/\/[^:\s/]+:(\d+)/
]

interface Managed {
  child: ChildProcess
  state: ProcState
  stopping: boolean
  waiters: Array<(code: number | null) => void>
}

export class ProcessManager extends EventEmitter {
  private procs = new Map<string, Managed>()
  private states = new Map<string, ProcState>()
  private logs = new Map<string, LogLine[]>()

  getState(id: string): ProcState {
    return this.states.get(id) ?? { id, status: 'stopped' }
  }

  getStates(): ProcState[] {
    return [...this.states.values()]
  }

  getLogs(id: string): LogLine[] {
    return this.logs.get(id) ?? []
  }

  clearLogs(id: string): void {
    this.logs.set(id, [])
  }

  isActive(id: string): boolean {
    const s = this.states.get(id)?.status
    return s === 'starting' || s === 'running' || s === 'stopping'
  }

  activeIds(): string[] {
    return [...this.procs.keys()]
  }

  log(id: string, stream: LogLine['stream'], text: string): void {
    let arr = this.logs.get(id)
    if (!arr) {
      arr = []
      this.logs.set(id, arr)
    }
    const line: LogLine = { ts: Date.now(), stream, text }
    arr.push(line)
    if (arr.length > MAX_LINES) arr.splice(0, arr.length - MAX_LINES)
    this.emit('log', id, line)
  }

  waitForExit(id: string): Promise<number | null> {
    const m = this.procs.get(id)
    if (!m) return Promise.resolve(this.states.get(id)?.exitCode ?? null)
    return new Promise((res) => m.waiters.push(res))
  }

  start(opts: StartOptions): ProcState {
    if (this.isActive(opts.id)) throw new Error(`"${opts.id}" já está a correr`)
    const isBuild = BUILD_MODES.has(opts.mode)
    this.log(opts.id, 'system', `▶ ${opts.commandLine}`)
    this.log(opts.id, 'system', `  cwd: ${opts.cwd}`)

    const child = spawn(opts.commandLine, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      shell: true,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const state: ProcState = {
      id: opts.id,
      status: isBuild ? 'running' : 'starting',
      pid: child.pid,
      mode: opts.mode,
      startedAt: Date.now(),
      debugPort: opts.debugPort
    }
    const m: Managed = { child, state, stopping: false, waiters: [] }
    this.procs.set(opts.id, m)
    this.states.set(opts.id, state)
    this.emitState(state)

    this.pipe(opts.id, m, child.stdout!, 'stdout')
    this.pipe(opts.id, m, child.stderr!, 'stderr')
    child.on('error', (err) => this.log(opts.id, 'system', `✖ erro ao lançar: ${err.message}`))
    child.on('close', (code, signal) => {
      state.exitCode = code
      state.endedAt = Date.now()
      state.status = m.stopping || code === 0 ? 'stopped' : 'crashed'
      this.log(opts.id, 'system', `■ terminou (exit=${code ?? 'null'}${signal ? `, signal=${signal}` : ''})`)
      this.procs.delete(opts.id)
      this.emitState(state)
      for (const w of m.waiters) w(code)
    })
    return state
  }

  stop(id: string): Promise<void> {
    const m = this.procs.get(id)
    if (!m?.child.pid) return Promise.resolve()
    m.stopping = true
    m.state.status = 'stopping'
    this.emitState(m.state)
    this.log(id, 'system', '⏹ a parar…')
    return new Promise((res) =>
      treeKill(m.child.pid!, 'SIGTERM', (err) => {
        if (err) this.log(id, 'system', `erro ao parar: ${err.message}`)
        res()
      })
    )
  }

  async stopAll(): Promise<void> {
    const ids = this.activeIds()
    await Promise.all(ids.map((id) => this.stop(id)))
    await Promise.all(
      ids.map((id) => Promise.race([this.waitForExit(id), new Promise((r) => setTimeout(r, 5000))]))
    )
  }

  private pipe(id: string, m: Managed, stream: NodeJS.ReadableStream, name: 'stdout' | 'stderr'): void {
    let buf = ''
    stream.setEncoding('utf8')
    stream.on('data', (chunk: string) => {
      buf += chunk
      let i: number
      while ((i = buf.indexOf('\n')) >= 0) {
        this.handleLine(id, m, name, buf.slice(0, i))
        buf = buf.slice(i + 1)
      }
    })
    stream.on('end', () => {
      if (buf) this.handleLine(id, m, name, buf)
    })
  }

  private handleLine(id: string, m: Managed, stream: 'stdout' | 'stderr', raw: string): void {
    const text = raw.replace(/\r$/, '').replace(ANSI, '')
    this.log(id, stream, text)
    const st = m.state
    let changed = false
    if (st.detectedPort === undefined) {
      for (const re of PORT_PATTERNS) {
        const mm = re.exec(text)
        if (mm) {
          st.detectedPort = Number(mm[1])
          changed = true
          break
        }
      }
    }
    if (st.status === 'starting' && READY_PATTERNS.some((re) => re.test(text))) {
      st.status = 'running'
      changed = true
    }
    if (changed) this.emitState(st)
  }

  private emitState(s: ProcState): void {
    this.emit('state', { ...s })
  }
}
