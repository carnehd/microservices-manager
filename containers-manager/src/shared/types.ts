// Tipos partilhados entre servidor e UI.

export interface ContainerRow {
  id: string
  name: string
  image: string
  /** running | exited | created | paused | stopping | … */
  state: string
  /** texto do motor: "Up 2 hours (healthy)", "Exited (0) 3 hours ago" */
  status: string
  health?: 'healthy' | 'unhealthy' | 'starting'
  /** "8080→8080/tcp" */
  ports: string[]
  created: string
  labels: Record<string, string>
  exitCode?: number
  command?: string
  networks: string[]
}

export interface StatsRow {
  id: string
  name: string
  cpu: string
  mem: string
  memPerc: string
  net: string
  block: string
  pids: string
}

export interface ImageRow {
  id: string
  repoTags: string[]
  /** bytes */
  size: number
  /** epoch s */
  created: number
  containers: number
  dangling: boolean
}

export interface ImageLayer {
  id: string
  created: number
  createdBy: string
  size: number
  comment: string
}

export interface VolumeRow {
  name: string
  driver: string
  mountpoint: string
  created?: string
}

export interface NetworkRow {
  id: string
  name: string
  driver: string
  subnets: string[]
  dns: boolean
}

export interface MachineRow {
  name: string
  running: boolean
  cpus?: number
  memory?: string
  disk?: string
  lastUp?: string
  default?: boolean
}

export interface EngineInfo {
  command: string
  ok: boolean
  error?: string
  clientVersion?: string
  serverVersion?: string
  /** só podman */
  machines: MachineRow[]
  /** podman machine ou docker desktop */
  isPodman: boolean
}

export interface ExecResult {
  command: string
  stdout: string
  stderr: string
  code: number
  ms: number
}

export interface InspectSummary {
  id: string
  name: string
  image: string
  created: string
  state: string
  exitCode?: number
  startedAt?: string
  finishedAt?: string
  env: string[]
  mounts: Array<{ src: string; dst: string; ro: boolean; type: string }>
  ports: string[]
  networks: Array<{ name: string; ip: string; gateway: string }>
  cmd: string[]
  entrypoint: string[]
  workdir: string
  user: string
  restartPolicy: string
  health?: { status: string; failingStreak: number; log: Array<{ start: string; exitCode: number; output: string }> }
  labels: Record<string, string>
  raw: unknown
}

/** Formulário "novo container"; o comando `run` é gerado em shared/run.ts (UI e servidor usam o mesmo). */
export interface RunSpec {
  image: string
  name?: string
  detach: boolean
  rm: boolean
  restart?: string
  network?: string
  ports: Array<{ host: string; container: string; proto: 'tcp' | 'udp' }>
  env: Array<{ key: string; value: string }>
  volumes: Array<{ src: string; dst: string; ro: boolean }>
  labels: Array<{ key: string; value: string }>
  healthCmd?: string
  memory?: string
  cpus?: string
  extraArgs?: string
  command?: string
}

export interface CmdLogEntry {
  ts: number
  text: string
  kind: 'cmd' | 'ok' | 'err'
}

export interface StreamLine {
  id: string
  stream: 'stdout' | 'stderr' | 'system'
  text: string
  ts: number
}

export interface StreamEnd {
  id: string
  code: number | null
}

export interface ContainerEvent {
  ts: number
  type: string
  status: string
  name: string
  image?: string
  id?: string
}

export interface AppSettings {
  /** podman (omissão) ou docker */
  containerCommand: string
  httpProxy?: string
  httpsProxy?: string
  noProxy?: string
  /** auto-refresh das listas (ms); 0 = desligado */
  refreshMs: number
  /** tail inicial dos logs */
  logsTail: number
  /** imagens sugeridas no formulário */
  templates: Array<{ name: string; spec: RunSpec }>
}
