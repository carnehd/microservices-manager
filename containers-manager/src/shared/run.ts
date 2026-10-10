import type { RunSpec } from './types'

const q = (s: string): string => (/[\s"'$&|<>;()]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s)

/** Argumentos de `run` a partir do formulário (sem o comando do motor). Usado na pré-visualização e na execução. */
export function runArgs(s: RunSpec, opts: { maskSecrets?: boolean } = {}): string[] {
  const a: string[] = ['run']
  if (s.detach) a.push('-d')
  if (s.rm) a.push('--rm')
  if (s.name?.trim()) a.push('--name', s.name.trim())
  if (s.restart && s.restart !== 'no') a.push('--restart', s.restart)
  if (s.network?.trim()) a.push('--network', s.network.trim())
  for (const p of s.ports) if (p.host.trim() && p.container.trim()) a.push('-p', `${p.host.trim()}:${p.container.trim()}${p.proto === 'udp' ? '/udp' : ''}`)
  for (const e of s.env) {
    if (!e.key.trim()) continue
    const secret = opts.maskSecrets && /pass|secret|token|key/i.test(e.key)
    a.push('-e', `${e.key.trim()}=${secret ? '******' : e.value}`)
  }
  for (const v of s.volumes) if (v.src.trim() && v.dst.trim()) a.push('-v', `${v.src.trim()}:${v.dst.trim()}${v.ro ? ':ro' : ''}`)
  for (const l of s.labels) if (l.key.trim()) a.push('--label', `${l.key.trim()}=${l.value}`)
  if (s.healthCmd?.trim()) a.push('--health-cmd', s.healthCmd.trim())
  if (s.memory?.trim()) a.push('--memory', s.memory.trim())
  if (s.cpus?.trim()) a.push('--cpus', s.cpus.trim())
  if (s.extraArgs?.trim()) a.push(...s.extraArgs.trim().split(/\s+/))
  a.push(s.image.trim())
  if (s.command?.trim()) a.push(...splitCommand(s.command.trim()))
  return a
}

/** Linha legível (com aspas onde preciso) para mostrar/copiar. */
export function runCommandLine(cmd: string, s: RunSpec, maskSecrets = true): string {
  return [cmd, ...runArgs(s, { maskSecrets }).map(q)].join(' ')
}

/** Divide um comando em argumentos respeitando aspas simples/duplas. */
export function splitCommand(text: string): string[] {
  const out: string[] = []
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) out.push(m[1] ?? m[2] ?? m[3])
  return out
}

export const EMPTY_SPEC: RunSpec = {
  image: '', name: '', detach: true, rm: false, restart: 'no', network: '',
  ports: [{ host: '', container: '', proto: 'tcp' }], env: [{ key: '', value: '' }], volumes: [], labels: [],
  healthCmd: '', memory: '', cpus: '', extraArgs: '', command: ''
}
