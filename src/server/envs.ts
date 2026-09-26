import { existsSync, promises as fs } from 'fs'
import { join } from 'path'
import { parseDocument } from 'yaml'
import type { EnvComposeResult, EnvKey, EnvMix, EnvsInfo, ServiceInfo } from '../shared/types'

export const MARKER = '# Gerado pela Microservices Manager'
const ORDER = ['local', 'dev', 'sit', 'uat', 'prod']
type Format = 'yaml' | 'properties'

interface EnvFile {
  profile: string
  file: string
  format: Format
  text: string
  generated: boolean
  values: Map<string, { path: string[]; value: unknown }>
}

function resourcesDir(svc: ServiceInfo): string {
  return svc.resourcesDir || join(svc.path, 'src', 'main', 'resources')
}

function display(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

/** Achata objetos aninhados em caminhos; arrays e escalares são folhas. */
function flatten(obj: unknown, path: string[], out: Map<string, { path: string[]; value: unknown }>): void {
  if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) flatten(v, [...path, k], out)
    return
  }
  if (path.length) out.set(path.join('.'), { path, value: obj })
}

function parseProperties(text: string): Map<string, { path: string[]; value: unknown }> {
  const out = new Map<string, { path: string[]; value: unknown }>()
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#') || line.startsWith('!')) continue
    const m = /^([^=:\s]+)\s*[=:]?\s*(.*)$/.exec(line)
    if (m) out.set(m[1], { path: [m[1]], value: m[2] })
  }
  return out
}

async function readEnvFiles(svc: ServiceInfo): Promise<EnvFile[]> {
  const dir = resourcesDir(svc)
  let names: string[] = []
  try {
    names = await fs.readdir(dir)
  } catch {
    return []
  }
  const files: EnvFile[] = []
  for (const name of names) {
    const m = /^application-([\w.-]+)\.(ya?ml|properties)$/.exec(name)
    if (!m) continue
    const text = await fs.readFile(join(dir, name), 'utf8')
    const format: Format = m[2] === 'properties' ? 'properties' : 'yaml'
    let values: EnvFile['values']
    if (format === 'yaml') {
      values = new Map()
      try {
        // Só o primeiro documento: blocos "---" com spring.config.activate.on-profile ficam de fora
        flatten(parseDocument(text).toJS() ?? {}, [], values)
      } catch {
        /* yaml inválido: sem chaves */
      }
    } else values = parseProperties(text)
    files.push({ profile: m[1], file: name, format, text, generated: text.startsWith(MARKER), values })
  }
  files.sort((a, b) => {
    const ia = ORDER.indexOf(a.profile), ib = ORDER.indexOf(b.profile)
    if (ia !== ib) return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib)
    return a.profile.localeCompare(b.profile)
  })
  return files
}

export async function listEnvs(svc: ServiceInfo): Promise<EnvsInfo> {
  const files = await readEnvFiles(svc)
  const keys = new Map<string, EnvKey>()
  for (const f of files) {
    for (const [key, entry] of f.values) {
      let k = keys.get(key)
      if (!k) {
        k = { key, path: entry.path, values: {} }
        keys.set(key, k)
      }
      k.values[f.profile] = display(entry.value)
    }
  }
  return {
    resourcesDir: resourcesDir(svc),
    profiles: files.map((f) => f.profile),
    files: Object.fromEntries(files.map((f) => [f.profile, f.file])),
    generated: files.filter((f) => f.generated).map((f) => f.profile),
    keys: [...keys.values()]
  }
}

export async function composeEnv(svc: ServiceInfo, mix: EnvMix, force: boolean): Promise<EnvComposeResult> {
  if (!/^[\w.-]+$/.test(mix.target)) throw new Error(`Nome de perfil inválido: ${mix.target}`)
  const files = await readEnvFiles(svc)
  const base = files.find((f) => f.profile === mix.base)
  if (!base) throw new Error(`Ficheiro do perfil "${mix.base}" não existe`)
  if (mix.target === mix.base) throw new Error('O perfil gerado tem de ser diferente do perfil de partida')
  const ext = base.file.slice(base.file.lastIndexOf('.'))
  const targetName = `application-${mix.target}${ext}`
  const targetPath = join(resourcesDir(svc), targetName)
  if (existsSync(targetPath) && !force) {
    const existing = await fs.readFile(targetPath, 'utf8')
    if (!existing.startsWith(MARKER)) throw new Error(`${targetName} já existe e não foi gerado pela app — confirma para o substituir`)
  }

  const warnings: string[] = []
  const applied: string[] = []
  const overrides: Array<{ key: string; path: string[]; value: unknown }> = []
  for (const [key, env] of Object.entries(mix.choices)) {
    if (env === mix.base) continue
    const src = files.find((f) => f.profile === env)
    if (!src) {
      warnings.push(`${key}: ambiente "${env}" não existe — mantido o valor de ${mix.base}`)
      continue
    }
    const entry = src.values.get(key)
    if (!entry) {
      warnings.push(`${key}: não existe em ${src.file} — mantido o valor de ${mix.base}`)
      continue
    }
    overrides.push({ key, path: entry.path, value: entry.value })
    applied.push(`${key} ← ${env}`)
  }

  const header = [
    MARKER,
    `# Perfil de partida: ${base.file}${applied.length ? ' · valores copiados: ' + applied.join(', ') : ''}`,
    '# Não editar à mão — volta a gerar no separador Ambientes da app.'
  ]
  let content: string
  if (base.format === 'yaml') {
    const doc = parseDocument(base.text)
    for (const o of overrides) doc.setIn(o.path, o.value)
    // Remove o comentário de topo do ficheiro de partida (ex. "# Ambiente: local"): o gerado tem cabeçalho próprio
    doc.commentBefore = null
    const top = doc.contents as { commentBefore?: string | null; items?: Array<{ key?: { commentBefore?: string | null } }> } | null
    if (top) {
      top.commentBefore = null
      if (top.items?.[0]?.key) top.items[0].key.commentBefore = null
    }
    content = header.join('\n') + '\n' + doc.toString()
  } else {
    const lines = base.text.split(/\r?\n/)
    for (const o of overrides) {
      const re = new RegExp(`^\\s*${o.key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[=:]`)
      const i = lines.findIndex((l) => re.test(l))
      const line = `${o.key}=${display(o.value)}`
      if (i >= 0) lines[i] = line
      else lines.push(line)
    }
    content = header.join('\n') + '\n' + lines.join('\n')
  }
  await fs.writeFile(targetPath, content)
  return { file: targetPath, content, warnings }
}
