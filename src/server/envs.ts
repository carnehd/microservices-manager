import { existsSync, promises as fs } from 'fs'
import { basename, join, relative, sep } from 'path'
import { parseDocument } from 'yaml'
import { logCmd } from './cmdlog'
import type { EnvComposeResult, EnvKey, EnvMix, EnvsInfo, ServiceInfo } from '../shared/types'

export const MARKER = '# Gerado pela Microservices Manager'

/**
 * Separa o 1.º documento YAML do resto (ficheiros multi-documento com `---`, ex. blocos
 * spring.config.activate.on-profile). Só o 1.º é editado; o resto é devolvido tal e qual.
 */
function splitFirstDoc(text: string): { first: string; rest: string; extraDocs: number } {
  const re = /^---[ \t]*(?:\r?\n|$)/gm
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    if (m.index === 0) continue // `---` inicial pertence ao 1.º documento
    const rest = text.slice(m.index)
    return { first: text.slice(0, m.index), rest, extraDocs: (rest.match(/^---[ \t]*$/gm) ?? []).length }
  }
  return { first: text, rest: '', extraDocs: 0 }
}
/** fs.writeFile com registo no Terminal comum (caminho + erro do SO), para diagnosticar noutros PCs. */
async function writeLogged(path: string, content: string): Promise<void> {
  logCmd(`write ${path}`, 'cmd')
  try {
    await fs.writeFile(path, content)
    logCmd('ok', 'ok')
  } catch (e) {
    const err = e as NodeJS.ErrnoException
    logCmd(`${err.code ?? 'ERR'}: ${err.message}`, 'err')
    throw new Error(`Cannot write ${path}: ${err.code ?? ''} ${err.message}`.trim())
  }
}
const ORDER = ['local', 'dev', 'sit', 'uat', 'prod']
const relPosix = (from: string, to: string): string => relative(from, to).split(sep).join('/')
type Format = 'yaml' | 'properties'

interface EnvFile {
  /** id único por ficheiro (usado como chave e valor do dropdown) */
  id: string
  /** etiqueta amigável mostrada no dropdown */
  label: string
  /** nome do ambiente (sufixo de application-<ambiente> ou nome do ficheiro k8s) */
  profile: string
  file: string
  format: Format
  text: string
  generated: boolean
  /** ficheiro vindo da pasta k8s */
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

/**
 * Deteta o ambiente a partir do nome do ficheiro (forte) ou da pasta pai (fraco).
 * `fromFile` = o nome do ambiente vem do próprio ficheiro (application-<env> ou <env>.yaml),
 * e nesse caso o ficheiro aparece sempre no dropdown, mesmo sem valores de config a comparar.
 */
function k8sEnvName(file: string, parent: string): { name: string; fromFile: boolean } | undefined {
  const base = file.replace(/\.(ya?ml|properties)$/i, '')
  const m = /^application-([\w.-]+)$/i.exec(base)
  if (m) return { name: m[1], fromFile: true }
  if (!K8S_GENERIC_FILE.has(base.toLowerCase())) return { name: base, fromFile: true }
  if (parent && !K8S_SKIP_FOLDER.has(parent.toLowerCase())) return { name: parent, fromFile: false }
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
      const env = k8sEnvName(e.name, basename(dir))
      if (!env) continue
      const format: Format = e.name.endsWith('.properties') ? 'properties' : 'yaml'
      let text: string
      try {
        text = await fs.readFile(join(dir, e.name), 'utf8')
      } catch {
        continue
      }
      const values = extractK8sValues(text, format)
      // Ficheiros cujo nome é o ambiente aparecem sempre; os genéricos (ambiente vindo da pasta) só com config.
      if (!values.size && !env.fromFile) continue
      const rel = relPosix(rootPath, join(dir, e.name))
      out.push({ id: rel, label: `${env.name} · ${rel}`, profile: env.name, file: rel, format, text, generated: false, k8s: true, values })
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
    files.push({ id: m[1], label: m[1], profile: m[1], file: name, format, text, generated: text.startsWith(MARKER), values })
  }
  // Cada ficheiro de k8s é uma entrada própria no dropdown (sem fusão com os de resources).
  for (const e of await readK8sEnvFiles(svc.path)) files.push(e)
  files.sort((a, b) => {
    const ia = ORDER.indexOf(a.profile), ib = ORDER.indexOf(b.profile)
    if (ia !== ib) return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib)
    if (a.profile !== b.profile) return a.profile.localeCompare(b.profile)
    // mesmo ambiente: resources antes de k8s, depois por caminho
    if (!!a.k8s !== !!b.k8s) return a.k8s ? 1 : -1
    return a.id.localeCompare(b.id)
  })
  return files
}

/** Lê o application.(yaml|yml|properties) base (sem -<perfil>) da resourcesDir e achata-o em chave→valor (texto). */
async function readDefaultValues(svc: ServiceInfo): Promise<Record<string, string>> {
  const dir = resourcesDir(svc)
  let names: string[] = []
  try {
    names = await fs.readdir(dir)
  } catch {
    return {}
  }
  // Ficheiro base = application sem sufixo de perfil (preferir yaml/yml sobre properties)
  const name =
    names.find((n) => /^application\.ya?ml$/i.test(n)) ?? names.find((n) => /^application\.properties$/i.test(n))
  if (!name) return {}
  let text: string
  try {
    text = await fs.readFile(join(dir, name), 'utf8')
  } catch {
    return {}
  }
  const values = name.toLowerCase().endsWith('.properties') ? parseProperties(text) : yamlKeys(text)
  const out: Record<string, string> = {}
  for (const [k, entry] of values) out[k] = display(entry.value)
  return out
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
      k.values[f.id] = display(entry.value)
    }
  }
  return {
    resourcesDir: resourcesDir(svc),
    profiles: files.map((f) => f.id),
    files: Object.fromEntries(files.map((f) => [f.id, f.file])),
    labels: Object.fromEntries(files.map((f) => [f.id, f.label])),
    generated: files.filter((f) => f.generated).map((f) => f.id),
    k8s: files.filter((f) => f.k8s).map((f) => f.id),
    keys: [...keys.values()],
    defaultValues: await readDefaultValues(svc)
  }
}

/**
 * Escreve (ou remove) `spring.profiles.active: <profile>` no application.(yaml|yml|properties) base.
 * É assim que o profile definido no input fica declarado no ficheiro e é usado no arranque.
 * profile vazio/undefined → remove a propriedade.
 */
export async function setBaseActiveProfile(svc: ServiceInfo, profile?: string): Promise<{ file: string }> {
  const prof = profile?.trim()
  if (prof && !/^[\w.-]+$/.test(prof)) throw new Error(`Invalid profile name: ${prof}`)
  const dir = resourcesDir(svc)
  let names: string[] = []
  try {
    names = await fs.readdir(dir)
  } catch {
    throw new Error(`Resources folder not found: ${dir}`)
  }
  const name = names.find((n) => /^application\.ya?ml$/i.test(n)) ?? names.find((n) => /^application\.properties$/i.test(n))
  if (!name) throw new Error('No base application.(yaml|yml|properties) to set the profile in')
  const full = join(dir, name)
  let text = await fs.readFile(full, 'utf8')
  if (name.toLowerCase().endsWith('.properties')) {
    const lines = text.split(/\r?\n/)
    const i = lines.findIndex((l) => /^\s*spring\.profiles\.active\s*[=:]/.test(l))
    if (prof) {
      const line = `spring.profiles.active=${prof}`
      if (i >= 0) lines[i] = line
      else lines.push(line)
    } else if (i >= 0) lines.splice(i, 1)
    text = lines.join('\n')
  } else {
    // Só o 1.º documento é editado; blocos `---` seguintes (on-profile) ficam intactos.
    const { first, rest } = splitFirstDoc(text)
    const doc = parseDocument(first)
    if (doc.errors.length) throw new Error(`${name}: YAML error — ${doc.errors[0].message.split('\n')[0]}`)
    if (prof) {
      doc.setIn(['spring', 'profiles', 'active'], prof)
    } else {
      doc.deleteIn(['spring', 'profiles', 'active'])
      const profiles = doc.getIn(['spring', 'profiles']) as { items?: unknown[] } | undefined
      if (profiles && Array.isArray(profiles.items) && profiles.items.length === 0) doc.deleteIn(['spring', 'profiles'])
    }
    text = doc.toString() + rest
  }
  await writeLogged(full, text)
  return { file: full }
}

/** Converte "8080"/"true" nos tipos certos para o YAML; o resto fica string. */
function coerce(v: string): unknown {
  if (/^-?\d+$/.test(v)) return Number(v)
  if (v === 'true' || v === 'false') return v === 'true'
  return v
}

/** Nome da variável de ambiente que o Spring associa a uma chave (relaxed binding): spring.datasource.url → SPRING_DATASOURCE_URL. */
export function envNameFor(key: string): string {
  return key.replace(/\[(\d+)\]/g, '_$1').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').toUpperCase()
}
// Chaves de controlo do Spring que não devem ficar condicionadas a variáveis de ambiente.
const NO_PLACEHOLDER = /^spring\.(profiles|config)\./
/** `${NOME_ENV:valor}` para uma folha; undefined = deixar como está (objeto/lista, já é placeholder, chave de controlo). */
function withPlaceholder(key: string, v: unknown): string | undefined {
  if (v == null || typeof v === 'object' || NO_PLACEHOLDER.test(key)) return undefined
  const s = String(v)
  if (s.includes('${')) return undefined
  return `\${${envNameFor(key)}:${s}}`
}

export async function composeEnv(svc: ServiceInfo, mix: EnvMix, force: boolean): Promise<EnvComposeResult> {
  const placeholders = mix.envPlaceholders !== false
  if (!/^[\w.-]+$/.test(mix.target)) throw new Error(`Invalid profile name: ${mix.target}`)
  const files = await readEnvFiles(svc)
  const base = files.find((f) => f.id === mix.base)
  if (!base) throw new Error(`Profile file "${mix.base}" does not exist`)
  if (mix.target === mix.base || mix.target === base.profile) throw new Error('The generated profile must be different from the source profile')
  const ext = base.file.slice(base.file.lastIndexOf('.'))
  const targetName = `application-${mix.target}${ext}`
  const targetPath = join(resourcesDir(svc), targetName)
  if (existsSync(targetPath) && !force) {
    const existing = await fs.readFile(targetPath, 'utf8')
    if (!existing.startsWith(MARKER)) throw new Error(`${targetName} already exists and was not generated by the app — confirm to replace it`)
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
    const src = files.find((f) => f.id === env)
    if (!src) {
      warnings.push(`${key}: environment "${env}" does not exist — kept the value from ${mix.base}`)
      continue
    }
    const entry = src.values.get(key)
    if (!entry) {
      warnings.push(`${key}: does not exist in ${src.file} — kept the value from ${mix.base}`)
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
    `# Source profile: ${base.file}${applied.length ? ' · copied values: ' + applied.join(', ') : ''}`,
    '# Do not edit by hand — regenerate in the Environments tab of the app.',
    ...(placeholders ? ['# Values are ${ENV_VAR:default}: an environment variable with that name overrides the default (Spring relaxed binding).'] : [])
  ]
  let content: string
  if (base.format === 'yaml') {
    // Multi-documento (`---`): só o 1.º documento é copiado; os outros são blocos de outros perfis.
    const { first, extraDocs } = splitFirstDoc(base.text)
    if (extraDocs) warnings.push(`${base.file} has ${extraDocs} more YAML document(s) (---) — only the first was copied`)
    const doc = parseDocument(first)
    if (doc.errors.length) throw new Error(`${base.file}: YAML error — ${doc.errors[0].message.split('\n')[0]}`)
    for (const o of overrides) doc.setIn(o.path, o.value)
    // Remove o comentário de topo do ficheiro de partida (ex. "# Ambiente: local"): o gerado tem cabeçalho próprio
    doc.commentBefore = null
    const top = doc.contents as { commentBefore?: string | null; items?: Array<{ key?: { commentBefore?: string | null } }> } | null
    if (top) {
      top.commentBefore = null
      if (top.items?.[0]?.key) top.items[0].key.commentBefore = null
    }
    if (placeholders) {
      // Cada folha passa a ${NOME_ENV:valor} — a variável de ambiente, se existir, sobrepõe-se; senão vale o default.
      for (const [key, e] of yamlKeys(doc.toString())) {
        const w = withPlaceholder(key, doc.getIn(e.path))
        if (w !== undefined) doc.setIn(e.path, w)
      }
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
    if (placeholders) {
      for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(/^(\s*)([^#!\s][^=:]*?)\s*([=:])\s*(.*)$/)
        if (!m) continue
        const w = withPlaceholder(m[2].trim(), m[4])
        if (w !== undefined) lines[i] = `${m[1]}${m[2].trim()}${m[3]}${w}`
      }
    }
    content = header.join('\n') + '\n' + lines.join('\n')
  }
  await writeLogged(targetPath, content)
  return { file: targetPath, content, warnings }
}
