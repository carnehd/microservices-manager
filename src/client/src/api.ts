import type {
  AppSettings, ContainerInfo, DeployResult, DirListing, DepsInfo, DiagReport, EngineInfo, JarInfo, GitBranch, GitCommit, GitInfo, GitSummary, ImageInfo, RedisInfo, RedisKeyValue, RedisScan, EnvComposeResult, EnvMix, EnvsInfo, HttpRequest, HttpResponse, KcClient, KcExportResult, KcNewClient, KcNewRealm, KcNewUser, KcRealmPatch, KcProviderInfo, KcRealm, KcUser,
  KeycloakInfo, LogLine, ProcState, ScanResult, StartMode
} from '../../shared/types'

async function req<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  const text = await res.text()
  let data: unknown = undefined
  try {
    data = text ? JSON.parse(text) : undefined
  } catch {
    data = text
  }
  if (!res.ok) {
    const err = data && typeof data === 'object' && 'error' in data ? String((data as { error: unknown }).error) : `${res.status} ${res.statusText}`
    throw new Error(err)
  }
  return data as T
}

const enc = encodeURIComponent

let source: EventSource | null = null
function events(): EventSource {
  if (!source) source = new EventSource('/api/events')
  return source
}
function on<T>(channel: string, cb: (data: T) => void): () => void {
  const listener = (e: Event): void => cb(JSON.parse((e as MessageEvent).data) as T)
  events().addEventListener(channel, listener)
  return () => events().removeEventListener(channel, listener)
}

const admin = <T,>(op: string, ...args: unknown[]): Promise<T> => req<T>('POST', '/api/kc/admin', { op, args })

export const api = {
  getSettings: () => req<AppSettings>('GET', '/api/settings'),
  saveSettings: (patch: Partial<AppSettings>) => req<AppSettings>('PUT', '/api/settings', patch),
  listDirs: (path?: string) => req<DirListing>('GET', `/api/fs/dirs${path ? `?path=${enc(path)}` : ''}`),
  scan: (root?: string) => req<ScanResult>('POST', '/api/scan', { root }),
  lastScan: () => req<ScanResult | null>('GET', '/api/scan'),
  states: () => req<ProcState[]>('GET', '/api/procs'),
  logs: (id: string) => req<LogLine[]>('GET', `/api/procs/${enc(id)}/logs`),
  clearLogs: (id: string) => req<void>('DELETE', `/api/procs/${enc(id)}/logs`),
  stop: (id: string) => req<void>('POST', `/api/procs/${enc(id)}/stop`),
  startService: (id: string, mode: StartMode) => req<ProcState>('POST', `/api/services/${enc(id)}/start`, { mode }),
  defaultDebugPort: (id: string) => req<number>('GET', `/api/services/${enc(id)}/debug-port`),
  envs: (id: string) => req<EnvsInfo>('GET', `/api/services/${enc(id)}/envs`),
  composeEnv: (id: string, body: EnvMix & { force?: boolean; setProfile?: boolean }) => req<EnvComposeResult>('POST', `/api/services/${enc(id)}/envs/compose`, body),
  git: {
    summary: () => req<GitSummary>('GET', '/api/git/summary'),
    info: (id: string) => req<GitInfo>('GET', `/api/services/${enc(id)}/git`),
    branches: (id: string) => req<GitBranch[]>('GET', `/api/services/${enc(id)}/git/branches`),
    log: (id: string) => req<GitCommit[]>('GET', `/api/services/${enc(id)}/git/log`),
    diff: (id: string, path: string, staged: boolean, untracked: boolean) => req<string>('GET', `/api/services/${enc(id)}/git/diff?path=${enc(path)}&staged=${staged ? 1 : 0}&untracked=${untracked ? 1 : 0}`),
    createBranch: (id: string, name: string, from?: string) => req<string>('POST', `/api/services/${enc(id)}/git/branch`, { name, from }),
    checkout: (id: string, branch: string) => req<string>('POST', `/api/services/${enc(id)}/git/checkout`, { branch }),
    stage: (id: string, paths: string[]) => req<void>('POST', `/api/services/${enc(id)}/git/stage`, { paths }),
    unstage: (id: string, paths: string[]) => req<void>('POST', `/api/services/${enc(id)}/git/unstage`, { paths }),
    discard: (id: string, changes: Array<{ repoPath: string; untracked: boolean }>) => req<void>('POST', `/api/services/${enc(id)}/git/discard`, { changes }),
    commit: (id: string, message: string, stageAll: boolean) => req<string>('POST', `/api/services/${enc(id)}/git/commit`, { message, stageAll }),
    fetch: (id: string) => req<string>('POST', `/api/services/${enc(id)}/git/fetch`),
    pull: (id: string) => req<string>('POST', `/api/services/${enc(id)}/git/pull`),
    push: (id: string) => req<string>('POST', `/api/services/${enc(id)}/git/push`)
  },
  diagnostics: () => req<DiagReport>('GET', '/api/diagnostics'),
  deps: (id: string) => req<DepsInfo>('GET', `/api/services/${enc(id)}/deps`),
  depsTree: (id: string) => req<ProcState>('POST', `/api/services/${enc(id)}/deps/tree`),
  redis: {
    info: () => req<RedisInfo>('GET', '/api/redis/info'),
    keys: (pattern: string, cursor = '0', count = 200) => req<RedisScan>('GET', `/api/redis/keys?pattern=${enc(pattern)}&cursor=${enc(cursor)}&count=${count}`),
    get: (key: string) => req<RedisKeyValue>('GET', `/api/redis/key?key=${enc(key)}`),
    set: (key: string, value: string, ttl?: number) => req<void>('PUT', '/api/redis/key', { key, value, ttl }),
    del: (keys: string[]) => req<number>('POST', '/api/redis/delete', { keys }),
    expire: (key: string, ttl: number) => req<void>('POST', '/api/redis/expire', { key, ttl }),
    flush: () => req<void>('POST', '/api/redis/flush'),
    command: (line: string) => req<unknown>('POST', '/api/redis/command', { line }),
    startContainer: () => req<string>('POST', '/api/redis/container/start')
  },
  containers: {
    engine: () => req<EngineInfo>('GET', '/api/containers/engine'),
    list: () => req<ContainerInfo[]>('GET', '/api/containers'),
    images: () => req<ImageInfo[]>('GET', '/api/containers/images'),
    action: (id: string, action: string, force = false) => req<string>('POST', `/api/containers/${enc(id)}/${action}`, { force }),
    logs: (id: string) => req<ProcState>('POST', `/api/containers/${enc(id)}/logs`),
    removeImage: (id: string, force = false) => req<string>('DELETE', `/api/containers/images/${enc(id)}${force ? '?force=1' : ''}`),
    machine: (name: string, action: 'start' | 'stop') => req<string>('POST', `/api/containers/machine/${enc(name || '_default')}/${action}`)
  },
  http: (r: HttpRequest) => req<HttpResponse>('POST', '/api/http', r),
  openExternal: (url: string): Promise<void> => {
    window.open(url, '_blank', 'noopener')
    return Promise.resolve()
  },
  openPath: (p: string) => req<void>('POST', '/api/shell/open-path', { path: p }),
  openTerminal: (p: string) => req<void>('POST', '/api/shell/open-terminal', { path: p }),
  kcInfo: () => req<KeycloakInfo>('GET', '/api/kc/info'),
  kcStart: () => req<ProcState>('POST', '/api/kc/start'),
  kcStop: () => req<void>('POST', '/api/kc/stop'),
  kcRecreate: () => req<ProcState>('POST', '/api/kc/recreate'),
  kcRestart: () => req<ProcState>('POST', '/api/kc/restart'),
  kcDeploySpi: (id: string, opts: { build: boolean; restart: boolean; jar?: string; replaceOthers?: boolean }) => req<DeployResult>('POST', `/api/kc/deploy/${enc(id)}`, opts),
  jarInfo: (id: string) => req<JarInfo>('GET', `/api/services/${enc(id)}/jar`),
  kcRemoveProvider: (name: string) => req<void>('DELETE', `/api/kc/providers/${enc(name)}`),
  kcAdmin: {
    realms: () => admin<KcRealm[]>('realms'),
    createRealm: (r: KcNewRealm) => admin<void>('createRealm', r),
    updateRealm: (realm: string, patch: KcRealmPatch) => admin<void>('updateRealm', realm, patch),
    deleteRealm: (realm: string) => admin<void>('deleteRealm', realm),
    exportRealm: (realm: string) => admin<KcExportResult>('exportRealm', realm),
    realmFiles: () => admin<string[]>('realmFiles'),
    clients: (realm: string) => admin<KcClient[]>('clients', realm),
    createClient: (realm: string, c: KcNewClient) => admin<void>('createClient', realm, c),
    deleteClient: (realm: string, id: string) => admin<void>('deleteClient', realm, id),
    users: (realm: string, search?: string) => admin<KcUser[]>('users', realm, search ?? ''),
    createUser: (realm: string, u: KcNewUser) => admin<void>('createUser', realm, u),
    setUserEnabled: (realm: string, id: string, enabled: boolean) => admin<void>('setUserEnabled', realm, id, enabled),
    resetPassword: (realm: string, id: string, pw: string) => admin<void>('resetPassword', realm, id, pw),
    deleteUser: (realm: string, id: string) => admin<void>('deleteUser', realm, id),
    providers: () => admin<KcProviderInfo[]>('providers')
  },
  onLog: (cb: (id: string, line: LogLine) => void) => on<{ id: string; line: LogLine }>('proc:log', (d) => cb(d.id, d.line)),
  onState: (cb: (st: ProcState) => void) => on<ProcState>('proc:state', cb),
  onScanUpdated: (cb: (r: ScanResult) => void) => on<ScanResult>('scan:updated', cb)
}
