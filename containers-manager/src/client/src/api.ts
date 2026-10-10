import type { AppSettings, CmdLogEntry, ContainerRow, EngineInfo, ExecResult, ImageLayer, ImageRow, InspectSummary, NetworkRow, RunSpec, StatsRow, StreamEnd, StreamLine, VolumeRow } from '../../shared/types'

async function req<T>(method: string, url: string, body?: unknown): Promise<T> {
  const r = await fetch(url, { method, headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined, body: body !== undefined ? JSON.stringify(body) : undefined })
  const text = await r.text()
  const data = text ? (JSON.parse(text) as T & { error?: string }) : ({} as T & { error?: string })
  if (!r.ok) throw new Error((data as { error?: string }).error ?? `${r.status} ${r.statusText}`)
  return data
}
const enc = encodeURIComponent
/** ?quiet=1: pedidos em background (poller) não aparecem no Terminal */
const q = (quiet?: boolean): string => (quiet ? '?quiet=1' : '')

export const api = {
  settings: () => req<AppSettings>('GET', '/api/settings'),
  saveSettings: (p: Partial<AppSettings>) => req<AppSettings>('PUT', '/api/settings', p),
  engine: () => req<EngineInfo>('GET', '/api/engine'),
  machine: (name: string, action: 'start' | 'stop' | 'restart') => req<string>('POST', `/api/machine/${enc(name)}/${action}`),
  systemDf: () => req<ExecResult>('GET', '/api/system/df'),
  systemPrune: (volumes: boolean) => req<ExecResult>('POST', '/api/system/prune', { volumes }),
  consoleLog: () => req<CmdLogEntry[]>('GET', '/api/console/log'),
  console: (args: string[]) => req<ExecResult>('POST', '/api/console', { args }),
  stopStream: (id: string) => req<void>('POST', `/api/streams/${enc(id)}/stop`),

  containers: {
    list: (quiet?: boolean) => req<ContainerRow[]>('GET', `/api/containers${q(quiet)}`),
    stats: () => req<StatsRow[]>('GET', '/api/containers/stats'),
    action: (id: string, action: string, force = false) => req<{ output: string }>('POST', `/api/containers/${enc(id)}/${action}`, { force }),
    batch: (ids: string[], action: string, force = false) => req<Record<string, string>>('POST', '/api/containers/batch', { ids, action, force }),
    prune: () => req<ExecResult>('POST', '/api/containers/prune'),
    run: (spec: RunSpec) => req<{ command: string; output: string }>('POST', '/api/containers/run', { spec }),
    inspect: (id: string) => req<InspectSummary>('GET', `/api/containers/${enc(id)}/inspect`),
    exec: (id: string, command: string, o: { cwd?: string; user?: string; shell?: string } = {}) => req<ExecResult>('POST', `/api/containers/${enc(id)}/exec`, { command, ...o }),
    logs: (id: string, tail?: number, since?: string) => req<{ stream: string }>('POST', `/api/containers/${enc(id)}/logs`, { tail, since }),
    cp: (id: string, direction: 'in' | 'out', from: string, to: string) => req<ExecResult>('POST', `/api/containers/${enc(id)}/cp`, { direction, from, to }),
    commit: (id: string, tag: string) => req<ExecResult>('POST', `/api/containers/${enc(id)}/commit`, { tag }),
    export: (id: string, file?: string) => req<ExecResult>('POST', `/api/containers/${enc(id)}/export`, { file })
  },
  images: {
    list: (quiet?: boolean) => req<ImageRow[]>('GET', `/api/images${q(quiet)}`),
    pull: (ref: string) => req<{ stream: string }>('POST', '/api/images/pull', { ref }),
    build: (context: string, tag: string, dockerfile?: string) => req<{ stream: string }>('POST', '/api/images/build', { context, tag, dockerfile }),
    load: (file: string) => req<ExecResult>('POST', '/api/images/load', { file }),
    prune: (all: boolean) => req<ExecResult>('POST', '/api/images/prune', { all }),
    history: (id: string) => req<ImageLayer[]>('GET', `/api/images/${enc(id)}/history`),
    tag: (id: string, tag: string) => req<ExecResult>('POST', `/api/images/${enc(id)}/tag`, { tag }),
    save: (id: string, ref?: string, file?: string) => req<ExecResult>('POST', `/api/images/${enc(id)}/save`, { ref, file }),
    run: (id: string, ref?: string, name?: string) => req<ExecResult>('POST', `/api/images/${enc(id)}/run`, { ref, name }),
    remove: (id: string, force = false) => req<ExecResult>('DELETE', `/api/images/${enc(id)}`, { force })
  },
  volumes: {
    list: (quiet?: boolean) => req<VolumeRow[]>('GET', `/api/volumes${q(quiet)}`),
    create: (name: string) => req<ExecResult>('POST', '/api/volumes', { name }),
    prune: () => req<ExecResult>('POST', '/api/volumes/prune'),
    remove: (name: string, force = false) => req<ExecResult>('DELETE', `/api/volumes/${enc(name)}`, { force })
  },
  networks: {
    list: (quiet?: boolean) => req<NetworkRow[]>('GET', `/api/networks${q(quiet)}`),
    create: (name: string) => req<ExecResult>('POST', '/api/networks', { name }),
    remove: (name: string, force = false) => req<ExecResult>('DELETE', `/api/networks/${enc(name)}`, { force }),
    connect: (name: string, container: string) => req<ExecResult>('POST', `/api/networks/${enc(name)}/connect`, { container }),
    disconnect: (name: string, container: string) => req<ExecResult>('POST', `/api/networks/${enc(name)}/disconnect`, { container })
  },
  engineEvents: () => req<{ stream: string }>('POST', '/api/engine-events/start')
}

// ---- SSE ----
type Listener<T> = (data: T) => void
const listeners = new Map<string, Set<Listener<unknown>>>()
let es: EventSource | null = null
function ensure(): void {
  if (es) return
  es = new EventSource('/api/events')
  for (const ev of ['cmd:log', 'stream:line', 'stream:end']) {
    es.addEventListener(ev, (e) => {
      const data = JSON.parse((e as MessageEvent).data) as unknown
      for (const l of listeners.get(ev) ?? []) l(data)
    })
  }
}
function on<T>(ev: string, cb: Listener<T>): () => void {
  ensure()
  let set = listeners.get(ev)
  if (!set) { set = new Set(); listeners.set(ev, set) }
  set.add(cb as Listener<unknown>)
  return () => { set!.delete(cb as Listener<unknown>) }
}
export const onCmdLog = (cb: Listener<CmdLogEntry>) => on('cmd:log', cb)
export const onStreamLine = (cb: Listener<StreamLine>) => on('stream:line', cb)
export const onStreamEnd = (cb: Listener<StreamEnd>) => on('stream:end', cb)
