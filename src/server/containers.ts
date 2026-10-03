import { execFile } from 'child_process'
import { promisify } from 'util'
import type { ContainerInfo, EngineInfo, ImageInfo, MachineInfo } from '../shared/types'

const execFileP = promisify(execFile)

/** Corre o comando e devolve stdout; erros trazem o stderr do podman/docker (mensagens úteis). */
async function run(cmd: string, args: string[], timeoutMs = 30_000): Promise<string> {
  try {
    const { stdout } = await execFileP(cmd, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true })
    return stdout
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { stderr?: string; stdout?: string }
    if (err.code === 'ENOENT') throw new Error(`"${cmd}" not found in PATH — install Podman (or set another command in Settings)`)
    const msg = (err.stderr || err.stdout || err.message || '').trim().split('\n').filter(Boolean).pop() ?? 'unknown error'
    throw new Error(msg)
  }
}

/** Aceita array JSON (podman --format json) ou uma linha JSON por objeto (docker --format '{{json .}}'). */
function parseJson(out: string): Record<string, unknown>[] {
  const text = out.trim()
  if (!text) return []
  try {
    const v = JSON.parse(text)
    return Array.isArray(v) ? v : [v]
  } catch {
    return text.split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>)
  }
}

const isDocker = (cmd: string): boolean => /docker/i.test(cmd)
const jsonFormat = (cmd: string): string[] => (isDocker(cmd) ? ['--format', '{{json .}}'] : ['--format', 'json'])
const str = (v: unknown): string => (v == null ? '' : typeof v === 'string' ? v : Array.isArray(v) ? v.map(String).join(' ') : String(v))

function humanSize(v: unknown): string {
  if (typeof v === 'string') return v
  let n = Number(v)
  if (!Number.isFinite(n)) return ''
  const units = ['B', 'kB', 'MB', 'GB', 'TB']
  let i = 0
  while (n >= 1000 && i < units.length - 1) {
    n /= 1000
    i++
  }
  return `${n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)} ${units[i]}`
}

function fmtDate(v: unknown): string | undefined {
  if (typeof v === 'number') return new Date(v * 1000).toISOString().replace('T', ' ').slice(0, 19)
  if (typeof v === 'string' && v) return v.replace(/\.\d+.*$/, '').replace('T', ' ').slice(0, 19)
  return undefined
}

function ports(v: unknown): string[] {
  if (Array.isArray(v)) {
    // podman: [{host_ip, host_port, container_port, protocol, range}]
    return v.map((p: Record<string, unknown>) => {
      const host = p.host_port ? `${str(p.host_ip) || '0.0.0.0'}:${str(p.host_port)}→` : ''
      return `${host}${str(p.container_port)}/${str(p.protocol) || 'tcp'}`
    })
  }
  // docker: "0.0.0.0:8080->80/tcp, :::8080->80/tcp"
  return str(v).split(',').map((s) => s.trim().replace('->', '→')).filter(Boolean)
}

export async function engineInfo(cmd: string): Promise<EngineInfo> {
  const info: EngineInfo = { command: cmd, available: false }
  try {
    const v = parseJson(await run(cmd, ['version', '--format', 'json'], 15_000))[0] as { Client?: { Version?: string }; Server?: { Version?: string; Engine?: { Version?: string } } } | undefined
    info.available = true
    info.clientVersion = v?.Client?.Version
    info.serverVersion = v?.Server?.Version ?? v?.Server?.Engine?.Version
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (msg.includes('not found')) {
      info.error = msg
      return info
    }
    // O cliente existe mas o servidor/máquina não responde: version falha com o erro de ligação
    info.available = true
    info.error = msg
  }
  if (!isDocker(cmd)) {
    try {
      info.machines = parseJson(await run(cmd, ['machine', 'list', '--format', 'json'], 15_000)).map((m): MachineInfo => ({
        name: str(m.Name).replace(/\*$/, ''),
        running: !!m.Running,
        starting: !!m.Starting,
        isDefault: !!m.Default,
        lastUp: str(m.LastUp) || undefined
      }))
    } catch {
      /* Linux (sem máquina) ou versão antiga: ignora */
    }
  }
  return info
}

export async function listContainers(cmd: string): Promise<ContainerInfo[]> {
  return parseJson(await run(cmd, ['ps', '-a', '--no-trunc', ...jsonFormat(cmd)])).map((c) => {
    const names = Array.isArray(c.Names) ? c.Names.map(String) : str(c.Names).split(',')
    let status = str(c.Status)
    // podman mostra "Exited (0) 292 years ago" quando ExitedAt é 0 (container nunca terminou "a sério")
    if (/\d{3,} years/.test(status)) status = `Exited (${str(c.ExitCode) || '?'})`
    return {
      id: str(c.Id ?? c.ID),
      name: names[0]?.replace(/^\//, '') ?? '',
      image: str(c.Image),
      state: str(c.State).toLowerCase(),
      status,
      ports: ports(c.Ports),
      // podman: Created (unix) é exato, CreatedAt é "3 months ago"; docker só tem CreatedAt (data)
      created: fmtDate(typeof c.Created === 'number' ? c.Created : c.CreatedAt ?? c.Created),
      command: str(c.Command).replace(/^"|"$/g, '')
    }
  })
}

export async function listImages(cmd: string): Promise<ImageInfo[]> {
  const byId = new Map<string, ImageInfo>()
  for (const i of parseJson(await run(cmd, ['images', ...jsonFormat(cmd)]))) {
    // podman: Names ["repo:tag", …] (RepoTags só no inspect); docker: Repository + Tag
    const tags = (Array.isArray(i.Names) ? i.Names : Array.isArray(i.RepoTags) ? i.RepoTags : i.Repository ? [`${str(i.Repository)}:${str(i.Tag)}`] : [])
      .map(String).filter((t) => t && t !== '<none>:<none>')
    const id = str(i.Id ?? i.ID).replace(/^sha256:/, '').slice(0, 12)
    const cur = byId.get(id)
    if (cur) {
      for (const t of tags) if (!cur.repoTags.includes(t)) cur.repoTags.push(t)
      continue
    }
    byId.set(id, {
      id,
      repoTags: tags,
      size: humanSize(i.Size),
      created: fmtDate(typeof i.Created === 'number' ? i.Created : i.CreatedAt ?? i.Created),
      containers: typeof i.Containers === 'number' ? i.Containers : undefined
    })
  }
  return [...byId.values()]
}

export type ContainerAction = 'start' | 'stop' | 'restart' | 'remove' | 'pause' | 'unpause'

export async function containerAction(cmd: string, action: ContainerAction, id: string, force = false): Promise<string> {
  if (!/^[\w.-]+$/.test(id)) throw new Error('Invalid identifier')
  const args = action === 'remove' ? ['rm', ...(force ? ['-f'] : []), id] : [action, id]
  return (await run(cmd, args, 120_000)).trim()
}

export async function removeImage(cmd: string, id: string, force = false): Promise<string> {
  if (!/^[\w.:/@-]+$/.test(id)) throw new Error('Invalid identifier')
  return (await run(cmd, ['rmi', ...(force ? ['-f'] : []), id], 120_000)).trim()
}

export async function machineAction(cmd: string, action: 'start' | 'stop', name: string): Promise<string> {
  if (!/^[\w.-]*$/.test(name)) throw new Error('Invalid machine name')
  return (await run(cmd, ['machine', action, ...(name ? [name] : [])], 300_000)).trim()
}

/** Garante um container com este nome a correr: arranca-o se existir parado, cria-o (run -d) se não existir. */
export interface RunOptions {
  name: string
  image: string
  ports: string[]
  /** "pasta-do-disco:/caminho/no/container" ou "volume:/caminho" */
  volumes?: string[]
  env?: Record<string, string>
  /** argumentos extra do run (ex.: --userns=keep-id) */
  runArgs?: string[]
  /** comando/args passados à imagem */
  args?: string[]
  /** apaga o container existente antes de criar (para aplicar nova configuração) */
  recreate?: boolean
}

/** Espera até o container estar num dos estados (ex.: depois de `stop`, o podman fica em "stopping" uns instantes). */
export async function waitForState(cmd: string, name: string, states: string[], timeoutMs = 20_000): Promise<string | undefined> {
  const end = Date.now() + timeoutMs
  let last: string | undefined
  while (Date.now() < end) {
    last = (await listContainers(cmd)).find((c) => c.name === name)?.state
    if (!last || states.includes(last)) return last
    await new Promise((r) => setTimeout(r, 500))
  }
  return last
}

export async function ensureContainer(cmd: string, opts: RunOptions): Promise<string> {
  if (!/^[\w.-]+$/.test(opts.name)) throw new Error('Invalid container name')
  const existing = (await listContainers(cmd)).find((c) => c.name === opts.name)
  if (existing && opts.recreate) {
    await run(cmd, ['rm', '-f', opts.name], 60_000)
    await waitForState(cmd, opts.name, [], 10_000) // até desaparecer
  } else if (existing?.state === 'running') return `${opts.name} is already running`
  else if (existing) {
    await waitForState(cmd, opts.name, ['exited', 'stopped', 'created', 'configured'])
    let lastErr: unknown
    for (let i = 0; i < 5; i++) {
      try {
        await run(cmd, ['start', opts.name], 60_000)
        return `${opts.name} started`
      } catch (e) {
        lastErr = e
        if (!/state improper|stopping/i.test(String(e))) throw e
        await new Promise((r) => setTimeout(r, 1000))
      }
    }
    throw lastErr
  }
  const args = ['run', '-d', '--name', opts.name, ...(opts.runArgs ?? [])]
  for (const p of opts.ports) args.push('-p', p)
  for (const v of opts.volumes ?? []) args.push('-v', v)
  for (const [k, v] of Object.entries(opts.env ?? {})) args.push('-e', `${k}=${v}`)
  args.push(opts.image, ...(opts.args ?? []))
  // A primeira vez faz pull da imagem (pode demorar minutos)
  const id = (await run(cmd, args, 900_000)).trim()
  return `${opts.name} created from ${opts.image} (${id.slice(0, 12)})`
}

export async function containerState(cmd: string, name: string): Promise<{ exists: boolean; running: boolean }> {
  const c = (await listContainers(cmd)).find((x) => x.name === name)
  return { exists: !!c, running: c?.state === 'running' }
}
