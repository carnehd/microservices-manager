import { existsSync, promises as fs } from 'fs'
import { basename, join, relative, sep } from 'path'
import { parseDocument } from 'yaml'
import type { EnvComposeResult, EnvKey, EnvMix, EnvsInfo, ServiceInfo } from '../shared/types'

export const MARKER = '# Gerado pela Microservices Manager'
const ORDER = ['local', 'dev', 'sit', 'uat', 'prod']
const relPosix = (from: string, to: string): string => relative(from, to).split(sep).join('/')
type Format = 'yaml' | 'properties'

interface EnvFile {
  profile: string
  file: string
  format: Format
  text: string
  generated: boolean
  /** valores (também) vindos da pasta k8s */
  k8s?: boolean
  values: Map<string, { path: string[]; value: unknown }>
}

const K8S_ROOT = /^(k8s|kubernetes|deploy|deployment|manifests|helm|kustomize|chart|charts)$/i
const K8S_SKIP_FOLDER = new Set(['k8s', 'kubernetes', 'deploy', 'deployment', 'manifests', 'helm', 'kustomize', 'chart', 'charts', 'base', 'overlays', 'overlay', 'template', 'templates', 'common', 'defaults'])
const K8S_GENERIC_FILE = new Set(['application', 'bootstrap', 'configmap', 'config', 'deployment', 'service', 'ingress', 'kustomization', 'values', 'chart', 'secret', 'namespace', 'hpa', 'pvc', 'pv', 'role', 'rolebinding', 'serviceaccount', 'cronjob', 'job', 'statefulset', 'daemonset', 'networkpolicy'])

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

function yamlKeys(text: string): Map<string, { path: string[]; value: unknown }> {
  const out = new Map<string, { path: string[]; value: unknown }>()
  try {
    flatten(parseDocument(text).toJS() ?? {}, [], out)
  } catch {
    /* yaml inválido */
  }
  return out
}

/** Deteta o ambiente a partir do nome do ficheiro ou da pasta pai. */
function k8sEnvName(file: string, parent: string): string | undefined {
  const base = file.replace(/\.(ya?ml|properties)$/i, '')
  const m = /^application-([\w.-]+)$/i.exec(base)
  if (m) return m[1]
  if (!K8S_GENERIC_FILE.has(base.toLowerCase())) return base
  if (parent && !K8S_SKIP_FOLDER.has(parent.toLowerCase())) return parent
  return undefined
}

/** Extrai pares chave→valor de um ficheiro k8s: config Spring simples, ou o data de um ConfigMap. */
function extractK8sValues(text: string, format: Format): Map<string, { path: string[]; value: unknown }> {
  if (format === 'properties') return parseProperties(text)
  let doc: unknown
  try {
    doc = parseDocument(text).toJS()
  } catch {
    return new Map()
  }
  if (!doc || typeof doc !== 'object') return new Map()
  const obj = doc as Record<string, unknown>
  const kind = typeof obj.kind === 'string' ? obj.kind : undefined
  if (kind && kind !== 'ConfigMap') return new Map() // Deployment/Service/… não são config
  if (kind === 'ConfigMap' && obj.data && typeof obj.data === 'object') {
    const out = new Map<string, { path: string[]; value: unknown }>()
    for (const [k, v] of Object.entries(obj.data as Record<string, unknown>)) {
      const sv = typeof v === 'string' ? v : ''
      if (/\.(ya?ml)$/i.test(k) && sv.includes('\n')) for (const [kk, e] of yamlKeys(sv)) out.set(kk, e)
      else if (/\.properties$/i.test(k) && sv.includes('\n')) for (const [kk, e] of parseProperties(sv)) out.set(kk, e)
      else out.set(k, { path: [k], value: v })
    }
    return out
  }
  if (obj.apiVersion) return new Map() // manifesto sem data útil
  return yamlKeys(text) // ficheiro de config "solto" dentro do k8s
}

/** Procura ficheiros de ambiente dentro de pastas k8s do projeto. */
async function readK8sEnvFiles(rootPath: string): Promise<EnvFile[]> {
  const roots: string[] = []
  try {
    for (const e of await fs.readdir(rootPath, { withFileTypes: true })) {
      if (e.isDirectory() && K8S_ROOT.test(e.name)) roots.push(join(rootPath, e.name))
    }
  } catch {
    return []
  }
  const out: EnvFile[] = []
  let budget = 800
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 4 || budget <= 0) return
    let entries: import('fs').Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (budget-- <= 0) return
      if (e.isDirectory()) {
        if (!e.name.startsWith('.')) await walk(join(dir, e.name), depth + 1)
        continue
      }
      if (!/\.(ya?ml|properties)$/i.test(e.name)) continue
      const profile = k8sEnvName(e.name, basename(dir))
      if (!profile) continue
      const format: Format = e.name.endsWith('.properties') ? 'properties' : 'yaml'
      let text: string
      try {
        text = await fs.readFile(join(dir, e.name), 'utf8')
      } catch {
        continue
      }
      const values = extractK8sValues(text, format)
      if (!values.size) continue
      out.push({ profile, file: relPosix(rootPath, join(dir, e.name)), format, text, generated: false, k8s: true, values })
    }
  }
  for (const r of roots) await walk(r, 0)
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
  // Funde os ficheiros da pasta k8s: mesmo ambiente → sem coluna duplicada (resources tem prioridade; k8s só acrescenta chaves em falta)
  for (const e of await readK8sEnvFiles(svc.path)) {
    const existing = files.find((f) => f.profile === e.profile)
    if (existing) {
      existing.k8s = true
      for (const [k, val] of e.values) if (!existing.values.has(k)) existing.values.set(k, val)
    } else {
      files.push(e)
    }
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
    k8s: files.filter((f) => f.k8s).map((f) => f.profile),
    keys: [...keys.values()]
  }
}

/** Converte "8080"/"true" nos tipos certos para o YAML; o resto fica string. */
function coerce(v: string): unknown {
  if (/^-?\d+$/.test(v)) return Number(v)
  if (v === 'true' || v === 'false') return v === 'true'
  return v
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
  const pathOf = (key: string): string[] => {
    for (const f of files) {
      const e = f.values.get(key)
      if (e) return e.path
    }
    return key.split('.')
  }
  for (const [key, env] of Object.entries(mix.choices)) {
    if (env === mix.base) continue
    if (mix.values && key in mix.values) continue // valor personalizado tem prioridade
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
  // valores escritos à mão
  for (const [key, value] of Object.entries(mix.values ?? {})) {
    overrides.push({ key, path: pathOf(key), value: coerce(value) })
    applied.push(`${key} = ${value}`)
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
