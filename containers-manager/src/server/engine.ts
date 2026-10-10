import { execFile } from 'child_process'
import { promisify } from 'util'
import type { ContainerRow, EngineInfo, ExecResult, ImageLayer, ImageRow, InspectSummary, MachineRow, NetworkRow, StatsRow, VolumeRow } from '../shared/types'
import { logCmd } from './cmdlog'
import { getSettings } from './settings'

const execFileP = promisify(execFile)
const DEFAULT_NO_PROXY = 'localhost,127.0.0.1,::1,host.containers.internal,host.docker.internal'

export const cmd = (): string => getSettings().containerCommand?.trim() || 'podman'
export const isPodman = (): boolean => /podman/i.test(cmd())

/** Proxy das Settings como env do processo podman/docker (pulls, machine). */
export function proxyEnv(): Record<string, string> {
  const s = getSettings()
  const http = s.httpProxy?.trim() || s.httpsProxy?.trim() || ''
  const https = s.httpsProxy?.trim() || http
  if (!https) return {}
  const no = s.noProxy?.trim() || DEFAULT_NO_PROXY
  return { HTTP_PROXY: http, http_proxy: http, HTTPS_PROXY: https, https_proxy: https, NO_PROXY: no, no_proxy: no }
}
export const engineEnv = (): NodeJS.ProcessEnv => ({ ...process.env, ...proxyEnv() })

const redact = (u: string): string => u.replace(/\/\/([^:@/]+):[^@/]*@/, '//$1:***@')
/** Linha como aparece no Terminal (proxy à frente, password escondida). */
export function cmdLine(args: string[]): string {
  const px = proxyEnv().HTTPS_PROXY
  return `${px ? `HTTPS_PROXY=${redact(px)} ` : ''}${cmd()} ${args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}`
}

/** Corre o motor e devolve stdout; erro = exceção com a última linha do stderr. */
export async function run(args: string[], opts: { timeoutMs?: number; quiet?: boolean } = {}): Promise<string> {
  const line = cmdLine(args)
  if (!opts.quiet) logCmd(line, 'cmd')
  const t0 = Date.now()
  try {
    const { stdout } = await execFileP(cmd(), args, { env: engineEnv(), timeout: opts.timeoutMs ?? 120_000, maxBuffer: 64 * 1024 * 1024, windowsHide: true })
    if (!opts.quiet) logCmd(`exit 0 · ${Date.now() - t0} ms`, 'ok')
    return stdout
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { stderr?: string; stdout?: string }
    if (err.code === 'ENOENT') { logCmd(`"${cmd()}" not found in PATH`, 'err'); throw new Error(`"${cmd()}" not found in PATH — install Podman/Docker or set the command in Settings`) }
    const msg = (err.stderr || err.message || 'command failed').trim().split('\n').filter(Boolean).pop() ?? 'command failed'
    logCmd(msg, 'err')
    throw new Error(msg)
  }
}

export async function runJson<T>(args: string[], quiet = false): Promise<T> {
  const out = (await run(args, { quiet })).trim()
  if (!out) return [] as unknown as T
  try { return JSON.parse(out) as T } catch { throw new Error(`unexpected output from ${cmd()} ${args[0]}: ${out.slice(0, 120)}`) }
}

/** Corre e captura tudo (consola/shell): nunca lança por exit code ≠ 0. */
export async function capture(args: string[], shown?: string): Promise<ExecResult> {
  const command = shown ?? cmdLine(args)
  logCmd(command, 'cmd')
  const t0 = Date.now()
  try {
    const { stdout, stderr } = await execFileP(cmd(), args, { env: engineEnv(), timeout: 120_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true })
    logCmd(`exit 0 · ${Date.now() - t0} ms`, 'ok')
    return { command, stdout, stderr, code: 0, ms: Date.now() - t0 }
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { stderr?: string; stdout?: string; code?: unknown }
    if (err.code === 'ENOENT') throw new Error(`"${cmd()}" not found in PATH`)
    logCmd((err.stderr || err.message || 'failed').trim().split('\n').pop() ?? 'failed', 'err')
    return { command, stdout: err.stdout ?? '', stderr: err.stderr || err.message || 'failed', code: typeof err.code === 'number' ? err.code : 1, ms: Date.now() - t0 }
  }
}

// ---------- parsing (podman JSON; docker tolerado onde possível) ----------
type Rec = Record<string, unknown>
const str = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v))
const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' && !isNaN(Number(v)) ? Number(v) : undefined)

function portText(p: Rec): string {
  const hp = str(p.host_port ?? p.PublicPort), cp = str(p.container_port ?? p.PrivatePort), proto = str(p.protocol ?? p.Type ?? 'tcp')
  const ip = str(p.host_ip ?? p.IP)
  return `${ip && ip !== '0.0.0.0' && ip !== '' ? ip + ':' : ''}${hp ? `${hp}→` : ''}${cp}${proto !== 'tcp' ? '/' + proto : ''}`
}

export async function listContainers(quiet = false): Promise<ContainerRow[]> {
  const rows = await runJson<Rec[]>(['ps', '-a', '--no-trunc', '--format', 'json'], quiet)
  return rows.map((r) => {
    const names = Array.isArray(r.Names) ? (r.Names as string[]) : [str(r.Names)]
    const status = str(r.Status)
    const h = /\((healthy|unhealthy|starting)\)/.exec(status)?.[1] as ContainerRow['health'] | undefined
    const ports = Array.isArray(r.Ports) ? (r.Ports as Rec[]).map(portText) : typeof r.Ports === 'string' ? str(r.Ports).split(',').map((s) => s.trim()).filter(Boolean) : []
    const created = typeof r.CreatedAt === 'string' ? r.CreatedAt : typeof r.Created === 'number' ? new Date(r.Created * 1000).toISOString() : str(r.Created)
    return {
      id: str(r.Id ?? r.ID),
      name: names[0]?.replace(/^\//, '') ?? '',
      image: str(r.Image),
      state: str(r.State).toLowerCase(),
      status,
      health: h,
      ports: [...new Set(ports)],
      created,
      labels: (r.Labels && typeof r.Labels === 'object' ? (r.Labels as Record<string, string>) : {}) ?? {},
      exitCode: num(r.ExitCode),
      command: Array.isArray(r.Command) ? (r.Command as string[]).join(' ') : str(r.Command),
      networks: Array.isArray(r.Networks) ? (r.Networks as string[]) : []
    }
  })
}

export async function stats(): Promise<StatsRow[]> {
  const rows = await runJson<Rec[]>(['stats', '--no-stream', '--format', 'json'], true)
  return rows.map((r) => ({
    id: str(r.ContainerID ?? r.ID ?? r.id), name: str(r.Name ?? r.name),
    cpu: str(r.CPUPerc ?? r.cpu_percent), mem: str(r.MemUsage ?? r.mem_usage), memPerc: str(r.MemPerc ?? r.mem_percent),
    net: str(r.NetIO ?? r.net_io), block: str(r.BlockIO ?? r.block_io), pids: str(r.PIDs ?? r.pids)
  }))
}

export async function inspectContainer(id: string): Promise<InspectSummary> {
  const [r] = await runJson<Rec[]>(['inspect', '--type', 'container', id])
  if (!r) throw new Error(`container ${id} not found`)
  const cfg = (r.Config ?? {}) as Rec, st = (r.State ?? {}) as Rec, hc = (r.HostConfig ?? {}) as Rec, ns = (r.NetworkSettings ?? {}) as Rec
  const portsObj = (ns.Ports ?? {}) as Record<string, Array<Rec> | null>
  const ports = Object.entries(portsObj).flatMap(([cp, binds]) => (binds ?? []).map((b) => `${str(b.HostIp) && str(b.HostIp) !== '0.0.0.0' ? str(b.HostIp) + ':' : ''}${str(b.HostPort)}→${cp}`))
  const nets = Object.entries((ns.Networks ?? {}) as Record<string, Rec>).map(([name, n]) => ({ name, ip: str(n.IPAddress), gateway: str(n.Gateway) }))
  const health = st.Health as Rec | undefined
  const rp = (hc.RestartPolicy ?? {}) as Rec
  return {
    id: str(r.Id), name: str(r.Name).replace(/^\//, ''), image: str(r.ImageName ?? cfg.Image), created: str(r.Created),
    state: str(st.Status), exitCode: num(st.ExitCode), startedAt: str(st.StartedAt), finishedAt: str(st.FinishedAt),
    env: Array.isArray(cfg.Env) ? (cfg.Env as string[]) : [],
    mounts: Array.isArray(r.Mounts) ? (r.Mounts as Rec[]).map((m) => ({ src: str(m.Source ?? m.Name), dst: str(m.Destination), ro: m.RW === false, type: str(m.Type) })) : [],
    ports, networks: nets,
    cmd: Array.isArray(cfg.Cmd) ? (cfg.Cmd as string[]) : [], entrypoint: Array.isArray(cfg.Entrypoint) ? (cfg.Entrypoint as string[]) : typeof cfg.Entrypoint === 'string' ? [cfg.Entrypoint] : [],
    workdir: str(cfg.WorkingDir), user: str(cfg.User),
    restartPolicy: str(rp.Name) ? `${str(rp.Name)}${num(rp.MaximumRetryCount) ? `:${rp.MaximumRetryCount}` : ''}` : 'no',
    health: health && str(health.Status) ? { status: str(health.Status), failingStreak: num(health.FailingStreak) ?? 0, log: (Array.isArray(health.Log) ? (health.Log as Rec[]) : []).slice(-5).map((l) => ({ start: str(l.Start), exitCode: num(l.ExitCode) ?? 0, output: str(l.Output) })) } : undefined,
    labels: (cfg.Labels && typeof cfg.Labels === 'object' ? (cfg.Labels as Record<string, string>) : {}) ?? {},
    raw: r
  }
}

export async function listImages(quiet = false): Promise<ImageRow[]> {
  const rows = await runJson<Rec[]>(['images', '--format', 'json'], quiet)
  return rows.map((r) => ({
    id: str(r.Id ?? r.ID).replace(/^sha256:/, '').slice(0, 12),
    repoTags: Array.isArray(r.RepoTags) ? (r.RepoTags as string[]) : (r.Names as string[] | undefined) ?? (typeof r.Repository === 'string' && r.Repository !== '<none>' ? [`${r.Repository}:${str(r.Tag)}`] : []),
    size: num(r.Size) ?? 0, created: num(r.Created) ?? 0, containers: num(r.Containers) ?? 0,
    dangling: r.Dangling === true || !(Array.isArray(r.RepoTags) ? (r.RepoTags as string[]).length : (r.Names as string[] | undefined)?.length)
  }))
}

export async function imageHistory(id: string): Promise<ImageLayer[]> {
  const rows = await runJson<Rec[]>(['image', 'history', '--format', 'json', '--no-trunc', id])
  return rows.map((r) => ({ id: str(r.Id ?? r.ID).replace(/^sha256:/, '').slice(0, 12), created: num(r.Created) ?? 0, createdBy: str(r.CreatedBy), size: num(r.Size) ?? 0, comment: str(r.Comment) }))
}

export async function listVolumes(quiet = false): Promise<VolumeRow[]> {
  const rows = await runJson<Rec[]>(['volume', 'ls', '--format', 'json'], quiet)
  return rows.map((r) => ({ name: str(r.Name), driver: str(r.Driver), mountpoint: str(r.Mountpoint), created: str(r.CreatedAt) || undefined }))
}

export async function listNetworks(quiet = false): Promise<NetworkRow[]> {
  const rows = await runJson<Rec[]>(['network', 'ls', '--format', 'json'], quiet)
  return rows.map((r) => ({
    id: str(r.id ?? r.ID ?? r.Id).slice(0, 12), name: str(r.name ?? r.Name), driver: str(r.driver ?? r.Driver),
    subnets: Array.isArray(r.subnets) ? (r.subnets as Rec[]).map((s) => str(s.subnet)) : [], dns: r.dns_enabled === true
  }))
}

export async function engineInfo(): Promise<EngineInfo> {
  const info: EngineInfo = { command: cmd(), ok: false, machines: [], isPodman: isPodman() }
  if (isPodman()) {
    try {
      const rows = await runJson<Rec[]>(['machine', 'list', '--format', 'json'], true)
      // Memory/DiskSize vêm em bytes (string) nas versões recentes, ou já legíveis ("2GiB") nas antigas
      const human = (v: unknown): string => { const n = num(v); if (n === undefined || n < 1024 * 1024) return str(v); const g = n / 1024 ** 3; return g >= 1 ? `${Math.round(g * 10) / 10} GiB` : `${Math.round(n / 1024 ** 2)} MiB` }
      info.machines = rows.map((r): MachineRow => ({ name: str(r.Name), running: r.Running === true, cpus: num(r.CPUs), memory: human(r.Memory), disk: human(r.DiskSize), lastUp: str(r.LastUp).slice(0, 19).replace('T', ' '), default: r.Default === true }))
    } catch { /* sem machine (Linux) */ }
  }
  try {
    const v = await runJson<Rec>(['version', '--format', 'json'], true)
    info.clientVersion = str(((v.Client ?? {}) as Rec).Version)
    info.serverVersion = str(((v.Server ?? {}) as Rec).Version)
    info.ok = !!info.serverVersion
    if (!info.ok) info.error = 'engine not responding (machine stopped?)'
  } catch (e) {
    info.error = e instanceof Error ? e.message : String(e)
  }
  return info
}

export type ContainerAction = 'start' | 'stop' | 'restart' | 'pause' | 'unpause' | 'kill' | 'remove'
export async function containerAction(action: ContainerAction, id: string, force = false): Promise<string> {
  const args = action === 'remove' ? ['rm', ...(force ? ['-f'] : []), id] : action === 'stop' ? ['stop', '-t', '10', id] : [action, id]
  return (await run(args, { timeoutMs: 60_000 })).trim()
}
