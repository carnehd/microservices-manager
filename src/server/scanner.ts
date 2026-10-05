import { existsSync, promises as fs, readdirSync, statSync } from 'fs'
import { basename, dirname, join, relative, sep } from 'path'
import { XMLParser } from 'fast-xml-parser'
import { parseAllDocuments } from 'yaml'
import { findCollectionDirs } from './bruno'
import type { DatasourceInfo, ScanResult, ServiceInfo, ServiceKind } from '../shared/types'

const IGNORED_DIRS = new Set([
  'node_modules', 'target', 'build', 'dist', 'out', 'src', 'logs',
  '.git', '.idea', '.vscode', '.mvn', '.settings'
])
const MAX_DEPTH = 6

const DB_ARTIFACTS = new Set([
  'spring-boot-starter-data-jpa', 'spring-boot-starter-jdbc', 'spring-boot-starter-data-r2dbc',
  'spring-boot-starter-data-mongodb', 'spring-boot-starter-data-redis', 'spring-boot-starter-jooq',
  'postgresql', 'mysql-connector-java', 'mysql-connector-j', 'mariadb-java-client',
  'ojdbc8', 'ojdbc11', 'mssql-jdbc', 'h2', 'hsqldb', 'sqlite-jdbc',
  'flyway-core', 'liquibase-core', 'hibernate-core', 'mybatis-spring-boot-starter'
])
const KC_CLIENT_ARTIFACTS = new Set([
  'spring-boot-starter-oauth2-resource-server', 'spring-boot-starter-oauth2-client',
  'keycloak-spring-boot-starter', 'keycloak-admin-client', 'keycloak-spring-security-adapter'
])

const xml = new XMLParser({ ignoreAttributes: true, parseTagValue: false, trimValues: true })

function asArray<T>(v: T | T[] | undefined | null): T[] {
  return v == null ? [] : Array.isArray(v) ? v : [v]
}

function str(v: unknown): string | undefined {
  if (v == null) return undefined
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  return undefined
}

function toInt(v?: string): number | undefined {
  const n = parseInt(v ?? '', 10)
  return Number.isFinite(n) ? n : undefined
}

/** Resolve o valor por omissão de um placeholder Spring "${VAR:default}" (o default pode ter ':', ex. jdbc url). */
function placeholderDefault(v?: string): string | undefined {
  if (v == null) return undefined
  const m = /^\$\{[^:}]+:(.*)\}$/.exec(v.trim())
  return m ? m[1] : v
}

/**
 * Deteta Pub/Sub na configuração (genérico): project id, tópicos e subscrições.
 * Usa os valores por omissão dos placeholders ${VAR:default}.
 */
function detectPubsub(config: Record<string, string>): import('../shared/types').PubsubDetected | undefined {
  const NAME = /^[A-Za-z][\w.~%+-]{2,254}$/
  const resolve = (v?: string): string | undefined => {
    const d = placeholderDefault(v)
    return d && !/\$\{/.test(d) ? d.trim() : undefined
  }
  let projectId: string | undefined
  const topics = new Set<string>()
  const subs = new Set<string>()
  for (const [k, v] of Object.entries(config)) {
    const path = k.toLowerCase()
    if (!/pubsub|gcp|pub-sub/.test(path)) continue // só secções de pub/sub
    const leaf = path.split('.').pop() ?? ''
    if (!projectId && /^project[-_]?id$/.test(leaf)) { projectId = resolve(v); continue }
    const val = resolve(v)
    if (!val || !NAME.test(val)) continue
    const isTopic = /^(topic|topico|topic[-_]?id|topicname)$/.test(leaf) || (/topico|topic/.test(path) && /^(nome|name|id)$/.test(leaf))
    const isSub = /subscri/.test(path) && /^(nome|name|id|subscription|subscricao|subscrição)$/.test(leaf)
    if (isTopic) topics.add(val)
    else if (isSub) subs.add(val)
  }
  if (!projectId && !topics.size && !subs.size) return undefined
  return { projectId, topics: [...topics], subscriptions: [...subs].map((name) => ({ name })) }
}

/**
 * Lê o docker-compose à procura da config de Pub/Sub: project id (env PUBSUB_PROJECT_ID),
 * e tópicos/subscrições criados por chamadas REST ao emulador (ex. serviço "pubsub-setup"
 * com curl PUT .../topics/<t> e .../subscriptions/<s> com {"topic": ".../topics/<t>"}).
 */
async function readComposePubsub(dir: string): Promise<import('../shared/types').PubsubDetected | null> {
  const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  for (const name of ['docker-compose.yaml', 'docker-compose.yml', 'compose.yaml', 'compose.yml']) {
    const p = join(dir, name)
    if (!existsSync(p)) continue
    try {
      const text = await fs.readFile(p, 'utf8')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const services = (parseAllDocuments(text)[0]?.toJS() as any)?.services ?? {}
      let projectId: string | undefined
      const subMap = new Map<string, string | undefined>()
      for (const k of Object.keys(services)) {
        const env = normalizeComposeEnv(services[k]?.environment)
        if (!projectId && env.PUBSUB_PROJECT_ID) projectId = env.PUBSUB_PROJECT_ID
        for (const [ek, ev] of Object.entries(env)) if (/^(subscricao|subscription|sub)[_-]/i.test(ek) && ev) subMap.set(ev, undefined)
      }
      const topics = new Set<string>()
      for (const m of text.matchAll(/\/topics\/([A-Za-z][\w.~%+-]*)/g)) topics.add(m[1])
      for (const m of text.matchAll(/\/subscriptions\/([A-Za-z][\w.~%+-]*)/g)) if (!subMap.has(m[1])) subMap.set(m[1], undefined)
      // sub → topic a partir do corpo do pedido (subscriptions/<s> … topics/<t>)
      for (const sub of subMap.keys()) {
        const mm = new RegExp(`subscriptions/${esc(sub)}[\\s\\S]{0,500}?topics/([A-Za-z][\\w.~%+-]*)`).exec(text)
        if (mm) subMap.set(sub, mm[1])
      }
      if (!projectId && !topics.size && !subMap.size) continue
      return { projectId, topics: [...topics], subscriptions: [...subMap].map(([name, topic]) => ({ name, topic })) }
    } catch {
      /* compose inválido: ignora */
    }
  }
  return null
}

/** Extrai o nome da base de uma jdbc url (…/<db>?params). */
function dbNameFromJdbc(url?: string): string | undefined {
  if (!url) return undefined
  const m = /\/([^/?;#\s]+)(?:[?;#].*)?$/.exec(url.trim())
  return m ? m[1] : undefined
}

function normalizeComposeEnv(e: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (Array.isArray(e)) {
    for (const item of e) {
      const s = String(item)
      const i = s.indexOf('=')
      if (i > 0) out[s.slice(0, i).trim()] = s.slice(i + 1).trim()
    }
  } else if (e && typeof e === 'object') {
    for (const [k, v] of Object.entries(e as Record<string, unknown>)) out[k] = String(v)
  }
  return out
}

/** Porta HTTP a partir de "8100:8100" (ignora a de debug 8000). */
function composeHttpPort(ports: unknown): number | undefined {
  const list = asArray<unknown>(ports).map(String)
  const hosts = list.map((p) => /^(\d+):/.exec(p.trim())?.[1]).filter((p): p is string => !!p)
  const http = hosts.find((p) => p !== '8000') ?? hosts[0]
  return http ? Number(http) : undefined
}

/** Lê o docker-compose do serviço e devolve o env do serviço aplicacional (o que tem DB_*) + porta. */
async function readComposeDbEnv(dir: string): Promise<{ env: Record<string, string>; httpPort?: number } | null> {
  for (const name of ['docker-compose.yaml', 'docker-compose.yml', 'compose.yaml', 'compose.yml']) {
    const p = join(dir, name)
    if (!existsSync(p)) continue
    try {
      const docs = parseAllDocuments(await fs.readFile(p, 'utf8'))
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const services = (docs[0]?.toJS() as any)?.services ?? {}
      for (const key of Object.keys(services)) {
        const env = normalizeComposeEnv(services[key]?.environment)
        if (env.DB_CONNECTION_STRING || env.DB_SCHEMA) return { env, httpPort: composeHttpPort(services[key]?.ports) }
      }
    } catch {
      /* compose inválido: ignora */
    }
  }
  return null
}

const posix = (p: string): string => p.split(sep).join('/')

/** Nó da árvore de projetos: folha (um pom com código) ou agregador (packaging pom) com filhos. */
interface Node {
  dir: string
  leaf?: ServiceInfo
  aggregator?: { artifactId: string; groupId?: string; version?: string }
  children: Node[]
}

export async function scanFolder(root: string): Promise<ScanResult> {
  async function walk(dir: string, depth: number): Promise<Node[]> {
    if (depth > MAX_DEPTH) return []
    if (existsSync(join(dir, 'pom.xml'))) {
      const project = await analyzeProject(dir, root)
      if (project?.aggregator) return [{ dir, aggregator: project.aggregator, children: await walkChildren(dir, depth) }]
      if (project?.leaf) return [{ dir, leaf: project.leaf, children: [] }, ...(await walkChildren(dir, depth))]
    }
    return walkChildren(dir, depth)
  }

  async function walkChildren(dir: string, depth: number): Promise<Node[]> {
    let entries: import('fs').Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return []
    }
    const nodes: Node[] = []
    for (const e of entries) {
      if (!e.isDirectory() || IGNORED_DIRS.has(e.name) || e.name.startsWith('.')) continue
      nodes.push(...(await walk(join(dir, e.name), depth + 1)))
    }
    return nodes
  }

  const services: ServiceInfo[] = []
  collect(await walk(root, 0), root, services)
  // Ficheiros OpenAPI (contract-first) por serviço já colapsado (num multi-módulo cobre todos os módulos)
  await Promise.all(services.map(async (svc) => {
    svc.openApiFiles = await findOpenApiFiles(svc.path)
    svc.brunoCollections = await findCollectionDirs(svc.path)
    if (svc.kind === 'keycloak-spi') svc.providerIds = await findProviderIds(svc.moduleDir ?? svc.path)
  }))
  // Inferir dependências: um endpoint referido na config que aponta para a porta/host de outro serviço
  for (const svc of services) {
    const deps = new Set<string>()
    for (const ref of svc.refEndpoints ?? []) {
      for (const other of services) {
        if (other.id === svc.id || other.kind !== 'spring-boot') continue
        const isLocal = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|::1)$/i.test(ref.host)
        if ((isLocal && other.port === ref.port) || other.name === ref.host || other.artifactId === ref.host) deps.add(other.id)
      }
    }
    if (deps.size) svc.dependsOn = [...deps].sort()
  }
  services.sort((a, b) => a.relativePath.localeCompare(b.relativePath))
  return { root, services, scannedAt: Date.now() }
}

function leavesOf(node: Node): ServiceInfo[] {
  return node.leaf ? [node.leaf] : node.children.flatMap(leavesOf)
}

/**
 * Um agregador com exatamente um módulo "principal" (Spring Boot ou SPI) é um microserviço multi-módulo
 * (ex.: hexagonal: domain + application + infrastructure + boot) e aparece como UM serviço.
 * Com vários principais (monorepo de vários serviços) lista-se cada um.
 */
function collect(nodes: Node[], root: string, out: ServiceInfo[]): void {
  for (const n of nodes) {
    if (n.leaf) {
      out.push(n.leaf)
      continue
    }
    const leaves = leavesOf(n)
    const primaries = leaves.filter((l) => l.kind !== 'maven-lib')
    if (n.aggregator && primaries.length === 1) out.push(collapse(n, primaries[0], leaves, root))
    else collect(n.children, root, out)
  }
}

function collapse(node: Node, primary: ServiceInfo, leaves: ServiceInfo[], root: string): ServiceInfo {
  const dir = node.dir
  const relativePath = posix(relative(root, dir)) || basename(dir)
  const cfgLeaf = primary.configFiles.length ? primary : leaves.find((l) => l.configFiles.length) ?? primary
  const swaggerLeaf = leaves.find((l) => l.swaggerLib)
  const svc: ServiceInfo = {
    ...primary,
    id: relativePath.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'root',
    name: node.aggregator?.artifactId ?? basename(dir),
    artifactId: node.aggregator?.artifactId ?? primary.artifactId,
    groupId: node.aggregator?.groupId ?? primary.groupId,
    version: node.aggregator?.version ?? primary.version,
    path: dir,
    relativePath,
    moduleDir: primary.path,
    runModule: posix(relative(dir, primary.path)),
    modules: leaves.map((l) => l.artifactId),
    wrapperDir: findWrapper(dir, root),
    hasDatabase: leaves.some((l) => l.hasDatabase),
    usesKeycloak: leaves.some((l) => l.usesKeycloak),
    swaggerLib: primary.swaggerLib ?? swaggerLeaf?.swaggerLib,
    swaggerPath: primary.swaggerPath ?? cfgLeaf.swaggerPath ?? swaggerLeaf?.swaggerPath,
    apiDocsPath: primary.apiDocsPath ?? cfgLeaf.apiDocsPath ?? swaggerLeaf?.apiDocsPath,
    swaggerGroups: primary.swaggerGroups?.length ? primary.swaggerGroups : cfgLeaf.swaggerGroups,
    refEndpoints: (() => {
      const all = leaves.flatMap((l) => l.refEndpoints ?? [])
      const seen = new Set<string>()
      return all.filter((r) => (seen.has(`${r.host}:${r.port}`) ? false : seen.add(`${r.host}:${r.port}`)))
    })(),
    profiles: [...new Set(leaves.flatMap((l) => l.profiles))].sort()
  }
  if (cfgLeaf !== primary) {
    svc.resourcesDir = cfgLeaf.resourcesDir
    svc.configFiles = cfgLeaf.configFiles
    svc.port = cfgLeaf.port ?? primary.port
    svc.contextPath = cfgLeaf.contextPath ?? primary.contextPath
    svc.datasource = cfgLeaf.datasource ?? primary.datasource
  }
  svc.srDatabase = leaves.map((l) => l.srDatabase).find(Boolean)
  return svc
}

async function analyzeProject(dir: string, root: string): Promise<{ leaf?: ServiceInfo; aggregator?: Node['aggregator'] } | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let project: any
  try {
    project = xml.parse(await fs.readFile(join(dir, 'pom.xml'), 'utf8')).project
  } catch {
    return null
  }
  if (!project || typeof project !== 'object') return null

  const props: Record<string, string> = {}
  if (project.properties && typeof project.properties === 'object') {
    for (const [k, v] of Object.entries(project.properties)) {
      const s = str(v)
      if (s !== undefined) props[k] = s
    }
  }
  const resolve = (v?: string): string | undefined =>
    v?.replace(/\$\{([^}]+)\}/g, (m, k: string) => props[k] ?? (k === 'project.artifactId' ? (str(project.artifactId) ?? m) : m))

  const artifactId = resolve(str(project.artifactId)) ?? basename(dir)
  const groupId = resolve(str(project.groupId) ?? str(project.parent?.groupId))
  const version = resolve(str(project.version) ?? str(project.parent?.version))
  if ((str(project.packaging) ?? 'jar') === 'pom') return { aggregator: { artifactId, groupId, version } }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const deps = asArray<any>(project.dependencies?.dependency).map((d) => ({
    g: str(d.groupId) ?? '',
    a: str(d.artifactId) ?? '',
    v: resolve(str(d.version))
  }))
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const plugins = asArray<any>(project.build?.plugins?.plugin).map((p) => str(p.artifactId) ?? '')
  const parentArtifact = str(project.parent?.artifactId)

  const resources = join(dir, 'src', 'main', 'resources')
  const spiProviders = await listDir(join(resources, 'META-INF', 'services'))

  // "Executável" = tem o spring-boot-maven-plugin ou uma classe @SpringBootApplication. Módulos que só usam
  // dependências Spring (ex.: infrastructure/adapters num hexagonal) são bibliotecas, não serviços.
  const usesSpringBoot = parentArtifact === 'spring-boot-starter-parent' || deps.some((d) => d.a.startsWith('spring-boot-starter'))
  const isSpringBoot = plugins.includes('spring-boot-maven-plugin') || (usesSpringBoot && (await hasSpringBootApplication(dir)))
  const isKcSpi =
    !isSpringBoot &&
    (spiProviders.some((p) => p.startsWith('org.keycloak.')) || deps.some((d) => d.g === 'org.keycloak'))
  const kind: ServiceKind = isSpringBoot ? 'spring-boot' : isKcSpi ? 'keycloak-spi' : 'maven-lib'

  const relativePath = posix(relative(root, dir)) || basename(dir)
  const info: ServiceInfo = {
    id: relativePath.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'root',
    name: artifactId,
    artifactId,
    groupId,
    version,
    path: dir,
    relativePath,
    kind,
    hasDatabase: false,
    usesKeycloak: false,
    wrapperDir: findWrapper(dir, root),
    profiles: [],
    spiProviders,
    jarPath: findJar(dir),
    configFiles: [],
    resourcesDir: resources
  }

  const { config, files, profiles, swaggerGroups, refs } = await readSpringConfig(resources)
  info.configFiles = files
  info.profiles = profiles
  if (refs.length) info.refEndpoints = refs
  if (swaggerGroups.length) info.swaggerGroups = swaggerGroups
  const springdoc = deps.find((d) => d.a.startsWith('springdoc-openapi'))
  const springfox = deps.find((d) => d.a.startsWith('springfox'))
  if (springdoc) {
    info.swaggerLib = 'springdoc'
    info.swaggerPath = config['springdoc.swagger-ui.path'] ?? '/swagger-ui/index.html'
    info.apiDocsPath = config['springdoc.api-docs.path'] ?? '/v3/api-docs'
  } else if (springfox) {
    info.swaggerLib = 'springfox'
    info.swaggerPath = springfox.v?.startsWith('2') ? '/swagger-ui.html' : '/swagger-ui/index.html'
    info.apiDocsPath = springfox.v?.startsWith('2') ? '/v2/api-docs' : '/v3/api-docs'
  }
  info.hasDatabase = !!config['spring.datasource.url'] || deps.some((d) => DB_ARTIFACTS.has(d.a))
  info.usesKeycloak = deps.some((d) => KC_CLIENT_ARTIFACTS.has(d.a) || d.g === 'org.keycloak')

  if (kind === 'spring-boot' || files.length) {
    info.port = toInt(config['server.port']) ?? (kind === 'spring-boot' ? 8080 : undefined)
    const ctx = config['server.servlet.context-path']
    if (ctx && ctx !== '/') info.contextPath = ctx.replace(/\/+$/, '')
    const ds: DatasourceInfo = {
      url: config['spring.datasource.url'],
      username: config['spring.datasource.username'],
      password: config['spring.datasource.password'],
      driver: config['spring.datasource.driver-class-name']
    }
    if (ds.url || ds.username || ds.driver) info.datasource = ds

    // Pub/Sub: junta o detetado na config (application.yaml) com o do docker-compose (pubsub-setup).
    const cfgPs = detectPubsub(config)
    const composePs = await readComposePubsub(dir)
    if (cfgPs || composePs) {
      const topics = new Set<string>([...(cfgPs?.topics ?? []), ...(composePs?.topics ?? [])])
      const subMap = new Map<string, string | undefined>()
      for (const s of [...(cfgPs?.subscriptions ?? []), ...(composePs?.subscriptions ?? [])]) {
        subMap.set(s.name, s.topic || subMap.get(s.name)) // o compose tem o tópico certo
      }
      for (const s of subMap.values()) if (s) topics.add(s)
      info.pubsub = {
        projectId: composePs?.projectId ?? cfgPs?.projectId,
        topics: [...topics],
        subscriptions: [...subMap].map(([name, topic]) => ({ name, topic }))
      }
    }

    // Microserviço "SR": database/schema próprios + tabelas geridas por Liquibase.
    // A config da BD vem por env vars (docker-compose) ou dos defaults dos placeholders em application.yaml.
    const compose = await readComposeDbEnv(dir)
    const liquibaseFrom =
      config['spring.liquibase.change-log'] ? `spring.liquibase.change-log = ${config['spring.liquibase.change-log']}` :
      deps.some((d) => d.a === 'liquibase-core') ? 'dependência liquibase-core (pom.xml)' :
      existsSync(join(resources, 'db', 'changelog')) ? 'pasta src/main/resources/db/changelog' : undefined
    const liquibase = !!liquibaseFrom
    const databaseFrom =
      compose?.env.DB_CONNECTION_STRING ? `docker-compose: DB_CONNECTION_STRING = ${compose.env.DB_CONNECTION_STRING}` :
      config['spring.datasource.url'] ? `application.yaml: spring.datasource.url = ${config['spring.datasource.url']}` : undefined
    const database = dbNameFromJdbc(compose?.env.DB_CONNECTION_STRING) ?? dbNameFromJdbc(placeholderDefault(config['spring.datasource.url']))
    const schemaFrom =
      compose?.env.DB_SCHEMA ? `docker-compose: DB_SCHEMA = ${compose.env.DB_SCHEMA}` :
      config['spring.liquibase.default-schema'] ? `application.yaml: spring.liquibase.default-schema = ${config['spring.liquibase.default-schema']}` :
      config['spring.jpa.properties.hibernate.default_schema'] ? `application.yaml: spring.jpa.properties.hibernate.default_schema = ${config['spring.jpa.properties.hibernate.default_schema']}` : undefined
    const schema =
      compose?.env.DB_SCHEMA ??
      placeholderDefault(config['spring.liquibase.default-schema']) ??
      placeholderDefault(config['spring.jpa.properties.hibernate.default_schema'])
    if (liquibase && database && schema) {
      const httpPort = compose?.httpPort ?? toInt(placeholderDefault(config['server.port']))
      info.srDatabase = { database, schema, httpPort, liquibase: true, source: compose ? 'docker-compose.yaml' : 'application.yaml', detected: { databaseFrom, schemaFrom, liquibaseFrom } }
      if (httpPort) info.port = httpPort
    }
  }
  return { leaf: info }
}

/** Procura uma classe anotada com @SpringBootApplication em src/main/java|kotlin (até 3000 ficheiros). */
async function hasSpringBootApplication(dir: string): Promise<boolean> {
  let budget = 3000
  async function search(d: string): Promise<boolean> {
    let entries: import('fs').Dirent[]
    try {
      entries = await fs.readdir(d, { withFileTypes: true })
    } catch {
      return false
    }
    for (const e of entries) {
      if (budget-- <= 0) return false
      const p = join(d, e.name)
      if (e.isDirectory()) {
        if (await search(p)) return true
      } else if (/\.(java|kt)$/.test(e.name)) {
        try {
          if ((await fs.readFile(p, 'utf8')).includes('@SpringBootApplication')) return true
        } catch {
          /* ignora */
        }
      }
    }
    return false
  }
  for (const src of ['java', 'kotlin']) if (await search(join(dir, 'src', 'main', src))) return true
  return false
}

/** Extrai IDs de provider do código Java do SPI: getId() a devolver literal, ou ID = "…". */
async function findProviderIds(root: string): Promise<string[]> {
  const ids = new Set<string>()
  let budget = 600
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 6 || budget <= 0) return
    let entries: import('fs').Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (budget <= 0) return
      if (e.isDirectory()) {
        if (!e.name.startsWith('.') && e.name !== 'target') await walk(join(dir, e.name), depth + 1)
        continue
      }
      if (!e.name.endsWith('.java') && !e.name.endsWith('.kt')) continue
      budget--
      let text: string
      try {
        text = await fs.readFile(join(dir, e.name), 'utf8')
      } catch {
        continue
      }
      for (const m of text.matchAll(/getId\s*\(\s*\)\s*(?::\s*String\s*)?\{?\s*(?:return|=>)\s*"([^"]+)"/g)) ids.add(m[1])
      for (const m of text.matchAll(/\bID\s*(?::\s*String)?\s*=\s*"([^"]+)"/g)) ids.add(m[1])
    }
  }
  await walk(join(root, 'src', 'main'), 0)
  return [...ids].sort()
}

const OPENAPI_SKIP = new Set(['target', 'build', 'dist', 'out', 'node_modules', '.git', '.idea', '.mvn'])
/** Procura ficheiros OpenAPI/Swagger (contract-first) no projeto: .yaml/.yml/.json com openapi:/swagger: no topo. */
async function findOpenApiFiles(root: string): Promise<string[]> {
  const out: string[] = []
  let budget = 400 // limite de ficheiros lidos, para o scan não ficar lento
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 5 || budget <= 0) return
    let entries: import('fs').Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (budget <= 0) return
      if (e.isDirectory()) {
        // NÃO ignora src/ (os contratos ficam em src/main/resources); só salta build e afins
        if (!OPENAPI_SKIP.has(e.name) && !e.name.startsWith('.')) await walk(join(dir, e.name), depth + 1)
        continue
      }
      if (!/\.(ya?ml|json)$/i.test(e.name)) continue
      if (/^application(-[\w.-]+)?\.(ya?ml|properties)$/i.test(e.name) || e.name === 'bootstrap.yml') continue
      budget--
      const full = join(dir, e.name)
      try {
        const head = (await fs.readFile(full, 'utf8')).slice(0, 4000)
        if (/(^|\n)\s*["']?(openapi|swagger)["']?\s*:/i.test(head)) out.push(posix(relative(root, full)))
      } catch {
        /* ignora ilegíveis */
      }
    }
  }
  await walk(root, 0)
  return out.sort()
}

async function listDir(dir: string): Promise<string[]> {
  try {
    return (await fs.readdir(dir)).filter((f) => !f.startsWith('.'))
  } catch {
    return []
  }
}

function findWrapper(dir: string, root: string): string | undefined {
  let cur = dir
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(cur, 'mvnw.cmd')) || existsSync(join(cur, 'mvnw'))) return cur
    if (cur === root) break
    const parent = dirname(cur)
    if (parent === cur) break
    cur = parent
  }
  return undefined
}

/** Jar mais recente em target/, ignorando sources/javadoc/tests e o "original-" do repackage do Spring Boot. */
export function findJar(dir: string): string | undefined {
  const target = join(dir, 'target')
  let best: { p: string; m: number } | undefined
  try {
    for (const f of readdirSync(target)) {
      if (!f.endsWith('.jar') || f.startsWith('original-')) continue
      if (/-(sources|javadoc|tests)\.jar$/.test(f)) continue
      const p = join(target, f)
      const m = statSync(p).mtimeMs
      if (!best || m > best.m) best = { p, m }
    }
  } catch {
    /* sem target/ */
  }
  return best?.p
}

async function readSpringConfig(resources: string): Promise<{
  config: Record<string, string>
  files: string[]
  profiles: string[]
  swaggerGroups: string[]
  refs: Array<{ host: string; port: number }>
}> {
  const config: Record<string, string> = {}
  const files: string[] = []
  const profiles = new Set<string>()
  const swaggerGroups: string[] = []
  for (const n of await listDir(resources)) {
    const m = /^application-([\w.-]+)\.(properties|ya?ml)$/.exec(n)
    if (m) profiles.add(m[1])
  }
  // Ordem = precedência do Spring: .properties ganha a .yml
  for (const n of ['application.properties', 'application.yml', 'application.yaml', 'bootstrap.properties', 'bootstrap.yml']) {
    const p = join(resources, n)
    if (!existsSync(p)) continue
    files.push(n)
    const text = await fs.readFile(p, 'utf8')
    const parsed = n.endsWith('.properties') ? parseProperties(text) : parseYaml(text, swaggerGroups)
    for (const [k, v] of Object.entries(parsed)) if (!(k in config)) config[k] = resolvePlaceholders(v)
  }
  // springdoc.group-configs[0].group=… em .properties
  for (const [k, v] of Object.entries(config)) {
    const m = /^springdoc\.group-configs\[\d+\]\.group$/.exec(k)
    if (m && !swaggerGroups.includes(v)) swaggerGroups.push(v)
  }
  const refs: Array<{ host: string; port: number }> = []
  const seen = new Set<string>()
  for (const v of Object.values(config)) {
    for (const m of v.matchAll(/https?:\/\/([\w.-]+):(\d+)/g)) {
      const key = `${m[1]}:${m[2]}`
      if (!seen.has(key)) {
        seen.add(key)
        refs.push({ host: m[1], port: Number(m[2]) })
      }
    }
  }
  return { config, files, profiles: [...profiles].sort(), swaggerGroups, refs }
}

function parseProperties(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#') || line.startsWith('!')) continue
    const eq = line.indexOf('=')
    const col = line.indexOf(':')
    let idx = eq
    if (idx < 0 || (col >= 0 && col < idx)) idx = col
    if (idx < 0) continue
    out[line.slice(0, idx).trim()] = line.slice(idx + 1).trim()
  }
  return out
}

function parseYaml(text: string, swaggerGroups: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  try {
    for (const doc of parseAllDocuments(text)) {
      const js: unknown = doc.toJS()
      if (!js || typeof js !== 'object') continue
      const flat: Record<string, string> = {}
      flatten(js as Record<string, unknown>, '', flat)
      // Documentos ativados por perfil (--- + spring.config.activate.on-profile) não são a config base
      if (flat['spring.config.activate.on-profile'] || flat['spring.profiles']) continue
      for (const [k, v] of Object.entries(flat)) if (!(k in out)) out[k] = v
      // Grupos springdoc: springdoc.group-configs: [{group: x, paths-to-match: …}]
      const groups = (js as { springdoc?: { 'group-configs'?: Array<{ group?: unknown }> } }).springdoc?.['group-configs']
      if (Array.isArray(groups)) for (const g of groups) if (typeof g?.group === 'string' && !swaggerGroups.includes(g.group)) swaggerGroups.push(g.group)
    }
  } catch {
    /* yaml inválido: ignora */
  }
  return out
}

function flatten(obj: Record<string, unknown>, prefix: string, out: Record<string, string>): void {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v as Record<string, unknown>, key, out)
    else if (Array.isArray(v)) out[key] = v.map(String).join(',')
    else if (v != null) out[key] = String(v)
  }
}

/** ${VAR:default} → default; ${VAR} sem default fica como está. */
function resolvePlaceholders(v: string): string {
  return v.replace(/\$\{([^}:]+)(?::([^}]*))?\}/g, (m, _k: string, def?: string) => def ?? m)
}
