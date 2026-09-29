import { Router, type Request, type Response } from 'express'
import { promises as fs, readdirSync, statSync } from 'fs'
import { basename, delimiter, join } from 'path'
import { BUILD_MODES, type AppSettings, type DeployResult, type EnvMix, type HttpRequest, type HttpResponse, type JarFile, type JarInfo, type KcExportResult, type KcNewRealm, type KeycloakInfo, type ProcState, type ScanResult, type ServiceInfo, type ServiceSettings, type StartMode } from '../shared/types'
import { addSseClient, broadcast } from './events'
import { listDirs, openPath, openTerminal } from './fsapi'
import { containerAction, containerState, engineInfo, ensureContainer, listContainers, listImages, machineAction, removeImage, waitForState, type ContainerAction } from './containers'
import * as redisOps from './redis'
import { depsCommandArgs, listDeps } from './deps'
import { parse as parseYaml } from 'yaml'
import { runDiagnostics } from './diagnostics'
import { composeEnv, listEnvs } from './envs'
import * as gitOps from './git'
import { listCollections } from './bruno'
import { createDatabaseManual, createDatabases, dbInfo, listDatabases, runSql, setPasswordLookup, startPostgres } from './db'
import { KcAdmin, prepareRealmImport } from './keycloak'
import { ProcessManager } from './processManager'
import { findJar, scanFolder } from './scanner'
import { dataDir, getSettings, saveSettings } from './settings'

const pm = new ProcessManager()
const isWin = process.platform === 'win32'
const KC_ID = 'keycloak'
let lastScan: ScanResult | null = null

pm.on('log', (id: string, line) => broadcast('proc:log', { id, line }))
pm.on('state', (st) => broadcast('proc:state', st))

const quote = (s: string): string => (/\s/.test(s) ? `"${s}"` : s)

function buildEnv(settings: AppSettings, extra?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {}
  if (settings.javaHome) {
    env.JAVA_HOME = settings.javaHome
    const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH'
    env[pathKey] = `${join(settings.javaHome, 'bin')}${delimiter}${process.env[pathKey] ?? ''}`
  }
  if (isWin) {
    // Sem isto a consola do Windows (cp1252/cp850) estraga acentos nos logs
    env.JAVA_TOOL_OPTIONS = ['-Dfile.encoding=UTF-8', '-Dstdout.encoding=UTF-8', '-Dstderr.encoding=UTF-8', process.env.JAVA_TOOL_OPTIONS ?? '']
      .join(' ')
      .trim()
  }
  return { ...env, ...extra }
}

function findService(id: string): ServiceInfo {
  const s = lastScan?.services.find((x) => x.id === id)
  if (!s) throw new Error('Serviço não encontrado — faz um novo scan')
  return s
}

function mavenCommand(svc: ServiceInfo, settings: AppSettings): string {
  if (settings.preferWrapper && svc.wrapperDir) return join(svc.wrapperDir, isWin ? 'mvnw.cmd' : 'mvnw')
  return settings.mavenCommand || 'mvn'
}

/** Argumentos comuns a todas as invocações do Maven: settings.xml e repositório local (por serviço ou global). */
function mavenGlobalArgs(settings: AppSettings, ss?: ServiceSettings): string[] {
  const args: string[] = []
  const settingsFile = settings.mavenSettingsFile?.trim()
  if (settingsFile) args.push('-s', quote(settingsFile))
  const repo = ss?.mavenRepoLocal?.trim() || settings.mavenRepoLocal?.trim()
  if (repo) args.push(quote(`-Dmaven.repo.local=${repo}`))
  return args
}

function defaultDebugPort(svcId: string, settings: AppSettings): number {
  const boots = lastScan?.services.filter((s) => s.kind === 'spring-boot') ?? []
  return settings.baseDebugPort + Math.max(0, boots.findIndex((s) => s.id === svcId))
}

function startService(id: string, mode: StartMode): ProcState {
  const svc = findService(id)
  const settings = getSettings()
  const ss: ServiceSettings = settings.services[id] ?? {}
  const args: string[] = []
  let debugPort: number | undefined

  const skip = ss.skipTests !== false ? ['-DskipTests'] : []
  if (mode === 'build') args.push(...skip, 'package')
  else if (mode === 'clean-build') args.push('clean', ...skip, 'package')
  else if (mode === 'clean-install') args.push('clean', ...skip, 'install')
  else if (mode === 'spotless') args.push('spotless:apply')
  else if (mode === 'run' || mode === 'debug') {
    if (svc.kind !== 'spring-boot') throw new Error('Só projetos Spring Boot podem ser arrancados')
    args.push('spring-boot:run')
    if (ss.profile?.trim()) args.push(`-Dspring-boot.run.profiles=${ss.profile.trim()}`)
    if (ss.port) args.push(`-Dspring-boot.run.arguments=--server.port=${ss.port}`)
    const jvm: string[] = []
    if (mode === 'debug') {
      debugPort = ss.debugPort || defaultDebugPort(id, settings)
      jvm.push(`-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=*:${debugPort}`)
    }
    if (ss.jvmArgs?.trim()) jvm.push(ss.jvmArgs.trim())
    if (jvm.length) args.push(`-Dspring-boot.run.jvmArguments="${jvm.join(' ')}"`)
  } else throw new Error(`Modo inválido: ${String(mode)}`)
  if (ss.extraArgs?.trim()) args.push(ss.extraArgs.trim())

  const mvn = [quote(mavenCommand(svc, settings)), ...mavenGlobalArgs(settings, ss)].join(' ')
  let commandLine = [mvn, ...args].join(' ')
  if ((mode === 'run' || mode === 'debug') && svc.runModule) {
    // Multi-módulo: instala os módulos de que o executável depende e corre só esse (spring-boot:run não aceita -am)
    const install = [mvn, '-q', '-DskipTests', '-pl', quote(svc.runModule), '-am', 'install', ...(ss.extraArgs?.trim() ? [ss.extraArgs.trim()] : [])].join(' ')
    commandLine = `${install} && ${[mvn, '-pl', quote(svc.runModule), ...args].join(' ')}`
  }
  const state = pm.start({
    id,
    commandLine,
    cwd: svc.path,
    env: buildEnv(settings, ss.env),
    mode,
    debugPort
  })
  if (BUILD_MODES.has(mode)) void pm.waitForExit(id).then(() => rescanQuiet())
  return state
}

async function rescanQuiet(): Promise<void> {
  if (!lastScan) return
  try {
    lastScan = await scanFolder(lastScan.root)
    broadcast('scan:updated', lastScan)
  } catch {
    /* mantém o scan anterior */
  }
}

const containerCmd = (): string => getSettings().containerCommand?.trim() || 'podman'

/** Pastas do disco montadas no container (providers e dados H2). */
function kcDirs(): { providersDir: string; dataDir: string } {
  const s = getSettings()
  const base = s.rootFolder ? join(s.rootFolder, 'keycloak-container') : join(dataDir(), 'keycloak-container')
  return {
    providersDir: s.keycloak.providersDir?.trim() || join(base, 'providers'),
    dataDir: s.keycloak.dataDir?.trim() || join(base, 'data')
  }
}

const kcContainers = async (): Promise<Awaited<ReturnType<typeof listContainers>>> =>
  (await listContainers(containerCmd())).filter((c) => /keycloak/i.test(c.image) || /keycloak/i.test(c.name))

async function kcInfoFull(): Promise<KeycloakInfo> {
  const kc = getSettings().keycloak
  const { providersDir, dataDir: dDir } = kcDirs()
  let providers: string[] = []
  try {
    providers = (await fs.readdir(providersDir)).filter((f) => f.endsWith('.jar')).sort()
  } catch {
    /* pasta ainda não existe */
  }
  const info: KeycloakInfo = {
    valid: true, image: kc.image, providers, providersDir, dataDir: dDir,
    container: { name: kc.containerName, image: kc.image, exists: false, running: false },
    keycloakContainers: []
  }
  try {
    const all = await kcContainers()
    const mine = all.find((c) => c.name === kc.containerName)
    if (mine) info.container = { name: mine.name, image: mine.image, exists: true, running: mine.state === 'running', status: mine.status }
    info.keycloakContainers = all.map((c) => ({ name: c.name, image: c.image, state: c.state, status: c.status, ports: c.ports }))
  } catch (e) {
    info.valid = false
    info.engineError = e instanceof Error ? e.message : String(e)
  }
  return info
}

/** O processo "keycloak" da app é o `podman logs -f` (os logs e o estado seguem o container). */
function followKeycloakLogs(): ProcState {
  if (pm.isActive(KC_ID)) return pm.getState(KC_ID)
  const kc = getSettings().keycloak
  return pm.start({ id: KC_ID, commandLine: `${containerCmd()} logs -f --tail 300 ${kc.containerName}`, cwd: process.cwd(), mode: 'run' })
}

async function startKeycloak(recreate = false): Promise<ProcState> {
  const kc = getSettings().keycloak
  const { providersDir, dataDir: dDir } = kcDirs()
  await fs.mkdir(providersDir, { recursive: true })
  await fs.mkdir(dDir, { recursive: true })
  const msg = await ensureContainer(containerCmd(), {
    name: kc.containerName,
    image: kc.image,
    ports: [`${kc.httpPort}:${kc.httpPort}`],
    volumes: [`${providersDir}:/opt/keycloak/providers`, `${dDir}:/opt/keycloak/data`],
    env: {
      KC_HTTP_PORT: String(kc.httpPort),
      // KEYCLOAK_ADMIN* (≤ 25) e KC_BOOTSTRAP_ADMIN_* (≥ 26): usados só no primeiro arranque para criar o admin
      KEYCLOAK_ADMIN: kc.adminUser, KEYCLOAK_ADMIN_PASSWORD: kc.adminPassword,
      KC_BOOTSTRAP_ADMIN_USERNAME: kc.adminUser, KC_BOOTSTRAP_ADMIN_PASSWORD: kc.adminPassword
    },
    // keep-id: o utilizador keycloak (uid 1000) dentro do container é o teu utilizador no disco → escreve na H2 montada
    runArgs: ['--userns=keep-id:uid=1000,gid=1000'],
    args: ['start-dev', ...(kc.extraArgs?.trim() ? kc.extraArgs.trim().split(/\s+/) : [])],
    recreate
  })
  pm.clearLogs(KC_ID)
  const st = followKeycloakLogs()
  pm.log(KC_ID, 'system', `🐳 ${msg} · providers ${providersDir} · data ${dDir}`)
  return st
}

async function stopKeycloak(): Promise<void> {
  const kc = getSettings().keycloak
  const c = (await kcContainers()).find((x) => x.name === kc.containerName)
  if (c?.state === 'running') {
    pm.log(KC_ID, 'system', `⏹ ${containerCmd()} stop ${kc.containerName}`)
    await containerAction(containerCmd(), 'stop', kc.containerName)
    await waitForState(containerCmd(), kc.containerName, ['exited', 'stopped', 'created'])
  }
  if (pm.isActive(KC_ID)) {
    await pm.stop(KC_ID)
    await pm.waitForExit(KC_ID)
  }
}

async function restartKeycloak(): Promise<ProcState> {
  await stopKeycloak()
  return startKeycloak()
}

/** Todos os jars "instaláveis" de uma pasta (sem sources/javadoc/tests nem original-*), do mais recente para o mais antigo. */
function listJars(dir: string, artifactId?: string): JarFile[] {
  let names: string[] = []
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  return names
    .filter((f) => f.endsWith('.jar') && !f.startsWith('original-') && !/-(sources|javadoc|tests)\.jar$/.test(f))
    .filter((f) => !artifactId || f === `${artifactId}.jar` || f.startsWith(`${artifactId}-`))
    .map((f) => {
      const st = statSync(join(dir, f))
      const version = artifactId && f.startsWith(`${artifactId}-`) ? f.slice(artifactId.length + 1, -4) : undefined
      return { name: f, path: join(dir, f), version, mtime: st.mtimeMs, size: st.size }
    })
    .sort((a, b) => b.mtime - a.mtime)
}

function jarInfo(svc: ServiceInfo): JarInfo {
  const moduleDir = svc.moduleDir ?? svc.path
  const artifactId = svc.modules ? basename(moduleDir) : svc.artifactId
  return {
    candidates: listJars(join(moduleDir, 'target'), artifactId),
    installed: listJars(kcDirs().providersDir, artifactId)
  }
}

/**
 * Instala um SPI: com build=true compila com Maven primeiro; com build=false usa um jar já em target/
 * (ex.: compilado no IntelliJ) — `jar` escolhe qual, senão o mais recente. Copia para a pasta de providers,
 * remove outras versões do mesmo artefacto (dois jars do mesmo SPI dão conflito) e, se restart, reinicia.
 */
async function deploySpi(id: string, opts: { build: boolean; restart: boolean; jar?: string; replaceOthers: boolean }): Promise<DeployResult> {
  const svc = findService(id)
  const { providersDir } = kcDirs()
  if (opts.build) {
    startService(id, 'build')
    const code = await pm.waitForExit(id)
    if (code !== 0) throw new Error(`Build de ${svc.name} falhou (exit ${code}) — vê os logs do serviço`)
  }
  const info = jarInfo(svc)
  const chosen = opts.jar && !opts.build ? info.candidates.find((j) => j.name === opts.jar) : info.candidates[0]
  if (!chosen) throw new Error(opts.jar ? `Jar ${opts.jar} já não existe em target/` : `Não encontrei nenhum .jar em ${join(svc.moduleDir ?? svc.path, 'target')} — compila primeiro (IntelliJ ou "Build & instalar")`)
  await fs.mkdir(providersDir, { recursive: true })
  const dest = join(providersDir, chosen.name)
  const removed: string[] = []
  if (opts.replaceOthers) {
    for (const old of info.installed) {
      if (old.name === chosen.name) continue
      await fs.rm(old.path)
      removed.push(old.name)
    }
  }
  await fs.copyFile(chosen.path, dest)
  pm.log(KC_ID, 'system', `📦 provider instalado: ${dest}${opts.build ? '' : ' (jar já compilado)'}${removed.length ? ` · removido: ${removed.join(', ')}` : ''}`)
  pm.log(id, 'system', `📦 ${chosen.name} copiado para ${providersDir}`)
  await rescanQuiet()
  let restarted = false
  if (opts.restart) {
    await restartKeycloak()
    restarted = true
  }
  const kcInfo = await kcInfoFull()
  return { jar: chosen.path, dest, keycloakRunning: kcInfo.container.running, built: opts.build, restarted, removed }
}

async function removeProviderJar(name: string): Promise<void> {
  if (name.includes('/') || name.includes('\\') || !name.endsWith('.jar')) throw new Error('Nome de provider inválido')
  await fs.rm(join(kcDirs().providersDir, name))
}

let adminCache: { key: string; client: KcAdmin } | null = null
function admin(): KcAdmin {
  const kc = getSettings().keycloak
  const key = `${kc.httpPort}|${kc.adminUser}|${kc.adminPassword}`
  if (adminCache?.key !== key) adminCache = { key, client: new KcAdmin(`http://localhost:${kc.httpPort}`, kc.adminUser, kc.adminPassword) }
  return adminCache.client
}

/** Pasta onde ficam as exportações de realms (dentro da pasta raiz dos microserviços, para ir para o git). */
function realmsDir(): string {
  const root = getSettings().rootFolder
  if (!root) throw new Error('Pasta raiz não definida')
  return join(root, 'keycloak-realms')
}

const safeName = (name: string): string => {
  if (!/^[\w.-]+$/.test(name)) throw new Error(`Nome inválido: ${name}`)
  return name
}

async function realmFiles(): Promise<string[]> {
  try {
    return (await fs.readdir(realmsDir())).filter((f) => f.endsWith('.json')).sort()
  } catch {
    return []
  }
}

async function exportRealmToFile(realm: string): Promise<KcExportResult> {
  const rep = await admin().exportRealm(realm)
  await fs.mkdir(realmsDir(), { recursive: true })
  const file = join(realmsDir(), `${safeName(realm)}-realm.json`)
  await fs.writeFile(file, JSON.stringify(rep, null, 2))
  return { file }
}

async function createRealm(r: KcNewRealm): Promise<void> {
  const target = safeName(r.realm.trim())
  let rep: Record<string, unknown>
  if (r.source?.kind === 'realm') rep = prepareRealmImport(await admin().exportRealm(r.source.name), target, r.displayName)
  else if (r.source?.kind === 'file') {
    const raw = JSON.parse(await fs.readFile(join(realmsDir(), safeName(r.source.name)), 'utf8')) as Record<string, unknown>
    rep = prepareRealmImport(raw, target, r.displayName)
  } else rep = { realm: target, displayName: r.displayName || undefined, enabled: true }
  await admin().createRealm(rep)
}

type Handler = (req: Request, res: Response) => unknown
/** Handlers devolvem o valor a enviar como JSON; erros viram 400 {error}. */
const h = (fn: Handler) => async (req: Request, res: Response): Promise<void> => {
  try {
    const out = await fn(req, res)
    if (!res.headersSent) res.json(out ?? null)
  } catch (e) {
    if (!res.headersSent) res.status(400).json({ error: e instanceof Error ? e.message : String(e) })
  }
}
const str = (v: unknown): string => (typeof v === 'string' ? v : '')
// Express 5 tipa params como string | string[]
const param = (req: Request, name: string): string => str(req.params[name])

export const apiRouter = Router()

apiRouter.get('/events', (_req, res) => addSseClient(res))

apiRouter.get('/settings', h(() => getSettings()))
apiRouter.put('/settings', h(async (req) => {
  adminCache = null
  await redisOps.reset()
  return saveSettings(req.body as Partial<AppSettings>)
}))

apiRouter.get('/fs/dirs', h((req) => listDirs(str(req.query.path) || undefined)))
apiRouter.post('/shell/open-path', h((req) => openPath(str(req.body?.path))))
apiRouter.post('/shell/open-terminal', h((req) => openTerminal(str(req.body?.path))))

apiRouter.get('/scan', h(() => lastScan))
apiRouter.post('/scan', h(async (req) => {
  const root = str(req.body?.root) || undefined
  const s = getSettings()
  const dir = root ?? s.rootFolder
  if (!dir) throw new Error('Pasta raiz não definida')
  if (root && root !== s.rootFolder) saveSettings({ rootFolder: root })
  lastScan = await scanFolder(dir)
  return lastScan
}))

apiRouter.get('/procs', h(() => pm.getStates()))
apiRouter.get('/procs/:id/logs', h((req) => pm.getLogs(param(req, 'id'))))
apiRouter.delete('/procs/:id/logs', h((req) => pm.clearLogs(param(req, 'id'))))
apiRouter.post('/procs/:id/stop', h((req) => pm.stop(param(req, 'id'))))

/** Resolve um token (id ou nome) para um id de serviço spring-boot existente. */
function resolveDep(token: string): string | undefined {
  const t = token.trim()
  const s = lastScan?.services.find((x) => x.id === t || x.name === t || x.artifactId === t)
  return s && s.kind === 'spring-boot' ? s.id : undefined
}

/** Dependências efetivas de um serviço: as declaradas (Configuração) ou, se vazias, as inferidas do scan. */
function effectiveDeps(id: string): string[] {
  const declared = getSettings().services[id]?.dependsOn
  const tokens = declared && declared.length ? declared : (lastScan?.services.find((s) => s.id === id)?.dependsOn ?? [])
  return [...new Set(tokens.map(resolveDep).filter((x): x is string => !!x && x !== id))]
}

/** Ordem topológica das dependências (deps antes de quem as usa), à prova de ciclos. */
function depOrder(rootId: string): string[] {
  const order: string[] = []
  const state = new Map<string, 'visiting' | 'done'>()
  const visit = (id: string): void => {
    if (state.get(id)) return // já visitado ou em ciclo
    state.set(id, 'visiting')
    for (const d of effectiveDeps(id)) visit(d)
    state.set(id, 'done')
    if (id !== rootId) order.push(id)
  }
  visit(rootId)
  return order
}

function waitRunning(id: string, timeoutMs = 180_000): Promise<'running' | 'crashed' | 'timeout'> {
  return new Promise((resolve) => {
    const end = Date.now() + timeoutMs
    const tick = (): void => {
      const st = pm.getState(id).status
      if (st === 'running') return resolve('running')
      if (st === 'crashed' || st === 'stopped') return resolve('crashed')
      if (Date.now() > end) return resolve('timeout')
      setTimeout(tick, 500)
    }
    tick()
  })
}

async function startWithDeps(id: string, mode: StartMode): Promise<{ order: string[]; started: string[]; skipped: string[]; failed: string[] }> {
  findService(id)
  const started: string[] = []
  const skipped: string[] = []
  const failed: string[] = []
  for (const depId of depOrder(id)) {
    if (pm.isActive(depId)) {
      skipped.push(depId)
      continue
    }
    const ss = getSettings().services[depId] ?? {}
    startService(depId, ss.debug ? 'debug' : 'run') // cada dependência arranca conforme o seu toggle de debug
    started.push(depId)
    const r = await waitRunning(depId)
    if (r !== 'running') {
      failed.push(depId)
      pm.log(id, 'system', `⚠ dependência ${depId} ${r === 'timeout' ? 'não ficou pronta a tempo' : 'falhou ao arrancar'} — a continuar`)
    }
  }
  if (!pm.isActive(id)) startService(id, mode)
  else skipped.push(id)
  return { order: depOrder(id), started, skipped, failed }
}

apiRouter.post('/services/:id/start', h((req) => startService(param(req, 'id'), req.body?.mode as StartMode)))
apiRouter.get('/services/:id/dep-order', h((req) => ({ effective: effectiveDeps(param(req, 'id')), order: depOrder(param(req, 'id')) })))
apiRouter.post('/services/:id/start-with-deps', h((req) => startWithDeps(param(req, 'id'), req.body?.mode as StartMode)))
// ---- Postgres (bases de dados por serviço) ----
setPasswordLookup((id) => lastScan?.services.find((s) => s.id === id)?.datasource?.password)
apiRouter.get('/db/info', h(() => dbInfo(lastScan?.services ?? [])))
apiRouter.post('/db/start', h(() => startPostgres()))
apiRouter.post('/db/create', h(() => createDatabases(lastScan?.services ?? [])))
apiRouter.post('/db/create/:id', h((req) => createDatabases(lastScan?.services ?? [], param(req, 'id'))))
apiRouter.get('/db/databases', h(() => listDatabases()))
apiRouter.post('/db/create-manual', h((req) => createDatabaseManual((req.body ?? {}) as { db: string; user?: string; password?: string; createUser?: boolean })))
apiRouter.post('/db/sql', h((req) => runSql(str(req.body?.db), str(req.body?.sql))))

apiRouter.get('/deps-graph', h(() => {
  const nodes = (lastScan?.services ?? []).map((s) => ({ id: s.id, name: s.name, kind: s.kind }))
  const edges: Array<{ from: string; to: string }> = []
  for (const s of lastScan?.services ?? []) for (const to of effectiveDeps(s.id)) edges.push({ from: s.id, to })
  return { nodes, edges }
}))
apiRouter.get('/services/:id/debug-port', h((req) => defaultDebugPort(param(req, 'id'), getSettings())))
apiRouter.get('/services/:id/envs', h(async (req) => {
  const svc = findService(param(req, 'id'))
  const info = await listEnvs(svc)
  info.mix = getSettings().services[svc.id]?.envMix
  return info
}))
apiRouter.post('/services/:id/envs/compose', h(async (req) => {
  const svc = findService(param(req, 'id'))
  const body = (req.body ?? {}) as Partial<EnvMix> & { force?: boolean; setProfile?: boolean }
  const mix: EnvMix = { base: str(body.base), target: str(body.target), choices: body.choices ?? {}, values: body.values ?? {} }
  const result = await composeEnv(svc, mix, !!body.force)
  const s = getSettings()
  const ss = { ...(s.services[svc.id] ?? {}), envMix: mix, ...(body.setProfile ? { profile: mix.target } : {}) }
  saveSettings({ services: { ...s.services, [svc.id]: ss } })
  void rescanQuiet() // o perfil novo passa a aparecer na lista de perfis do serviço
  return result
}))

apiRouter.get('/kc/info', h(() => kcInfoFull()))
apiRouter.post('/kc/start', h(() => startKeycloak()))
apiRouter.post('/kc/stop', h(() => stopKeycloak()))
apiRouter.post('/kc/restart', h(() => restartKeycloak()))
apiRouter.post('/kc/recreate', h(async () => {
  await stopKeycloak()
  return startKeycloak(true)
}))
apiRouter.post('/kc/deploy/:id', h((req) => deploySpi(param(req, 'id'), { build: req.body?.build !== false, restart: req.body?.restart !== false, jar: str(req.body?.jar) || undefined, replaceOthers: req.body?.replaceOthers !== false })))
apiRouter.get('/services/:id/jar', h((req) => jarInfo(findService(param(req, 'id')))))
apiRouter.get('/services/:id/bruno', h((req) => listCollections(findService(param(req, 'id')).path)))
apiRouter.get('/services/:id/openapi', h(async (req) => {
  const svc = findService(param(req, 'id'))
  const rel = str(req.query.path)
  if (!(svc.openApiFiles ?? []).includes(rel)) throw new Error('Ficheiro OpenAPI não reconhecido para este serviço')
  const full = join(svc.path, rel)
  const text = await fs.readFile(full, 'utf8')
  // devolve sempre JSON, mesmo que o contrato esteja em YAML
  return rel.endsWith('.json') ? JSON.parse(text) : parseYaml(text)
}))
apiRouter.delete('/kc/providers/:name', h((req) => removeProviderJar(param(req, 'name'))))
apiRouter.post('/kc/admin', h((req) => {
  const a = admin()
  const op = str(req.body?.op)
  const [p0, p1, p2] = (Array.isArray(req.body?.args) ? req.body.args : []) as [string, never, never]
  switch (op) {
    case 'realms': return a.realms()
    case 'createRealm': return createRealm(p0 as unknown as KcNewRealm)
    case 'updateRealm': return a.updateRealm(p0, p1)
    case 'deleteRealm': return a.deleteRealm(p0)
    case 'exportRealm': return exportRealmToFile(p0)
    case 'realmFiles': return realmFiles()
    case 'clients': return a.clients(p0)
    case 'createClient': return a.createClient(p0, p1)
    case 'deleteClient': return a.deleteClient(p0, p1)
    case 'users': return a.users(p0, p1)
    case 'createUser': return a.createUser(p0, p1)
    case 'setUserEnabled': return a.setUserEnabled(p0, p1, p2)
    case 'resetPassword': return a.resetPassword(p0, p1, p2)
    case 'deleteUser': return a.deleteUser(p0, p1)
    case 'providers': return a.providers()
    default: throw new Error(`Operação desconhecida: ${op}`)
  }
}))

// ---- Dependências Maven ----
apiRouter.get('/services/:id/deps', h((req) => listDeps(findService(param(req, 'id')))))
apiRouter.post('/services/:id/deps/tree', h((req) => {
  const svc = findService(param(req, 'id'))
  const settings = getSettings()
  const procId = `deps:${svc.id}`
  if (pm.isActive(procId)) return pm.getState(procId)
  pm.clearLogs(procId)
  return pm.start({ id: procId, commandLine: [quote(mavenCommand(svc, settings)), ...mavenGlobalArgs(settings, settings.services[svc.id]), ...depsCommandArgs()].join(' '), cwd: svc.path, env: buildEnv(settings), mode: 'build' })
}))

// ---- Git por serviço ----
apiRouter.get('/git/summary', h(async () => {
  const out: Record<string, { branch?: string; changes: number; ahead?: number; behind?: number }> = {}
  await Promise.all((lastScan?.services ?? []).map(async (svc) => {
    const b = await gitOps.gitBrief(svc).catch(() => null)
    if (b) out[svc.id] = b
  }))
  return out
}))
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
apiRouter.get('/services/:id/git', h((req) => gitOps.gitInfo(findService(param(req, 'id')))))
apiRouter.get('/services/:id/git/branches', h((req) => gitOps.branches(findService(param(req, 'id')))))
apiRouter.get('/services/:id/git/log', h((req) => gitOps.log(findService(param(req, 'id')))))
apiRouter.get('/services/:id/git/diff', h((req) => gitOps.diff(findService(param(req, 'id')), str(req.query.path), req.query.staged === '1', req.query.untracked === '1')))
apiRouter.post('/services/:id/git/branch', h((req) => gitOps.createBranch(findService(param(req, 'id')), str(req.body?.name), str(req.body?.from) || undefined)))
apiRouter.post('/services/:id/git/checkout', h((req) => gitOps.checkout(findService(param(req, 'id')), str(req.body?.branch))))
apiRouter.post('/services/:id/git/stage', h((req) => gitOps.stage(findService(param(req, 'id')), strs(req.body?.paths))))
apiRouter.post('/services/:id/git/unstage', h((req) => gitOps.unstage(findService(param(req, 'id')), strs(req.body?.paths))))
apiRouter.post('/services/:id/git/discard', h((req) => gitOps.discard(findService(param(req, 'id')), (Array.isArray(req.body?.changes) ? req.body.changes : []) as Array<{ repoPath: string; untracked: boolean }>)))
apiRouter.post('/services/:id/git/commit', h((req) => gitOps.commit(findService(param(req, 'id')), str(req.body?.message), !!req.body?.stageAll)))
apiRouter.post('/services/:id/git/fetch', h((req) => gitOps.fetch(findService(param(req, 'id')))))
apiRouter.post('/services/:id/git/pull', h((req) => gitOps.pull(findService(param(req, 'id')))))
apiRouter.post('/services/:id/git/push', h((req) => gitOps.push(findService(param(req, 'id')))))

// ---- Containers (Podman/Docker) ----
const CONTAINER_ACTIONS = new Set<ContainerAction>(['start', 'stop', 'restart', 'remove', 'pause', 'unpause'])

apiRouter.get('/containers/engine', h(() => engineInfo(containerCmd())))
apiRouter.get('/containers', h(() => listContainers(containerCmd())))
apiRouter.get('/containers/images', h(() => listImages(containerCmd())))
apiRouter.delete('/containers/images/:id', h((req) => removeImage(containerCmd(), param(req, 'id'), req.query.force === '1')))
apiRouter.post('/containers/machine/:name/:action', h((req) => {
  const action = param(req, 'action')
  if (action !== 'start' && action !== 'stop') throw new Error('Ação inválida')
  return machineAction(containerCmd(), action, param(req, 'name') === '_default' ? '' : param(req, 'name'))
}))
apiRouter.post('/containers/:id/logs', h((req) => {
  const id = param(req, 'id')
  if (!/^[\w.-]+$/.test(id)) throw new Error('Identificador inválido')
  const procId = `container:${id}`
  if (pm.isActive(procId)) return pm.getState(procId)
  pm.clearLogs(procId)
  return pm.start({ id: procId, commandLine: `${containerCmd()} logs -f --tail 300 ${id}`, cwd: process.cwd(), mode: 'run' })
}))
apiRouter.post('/containers/:id/:action', h((req) => {
  const action = param(req, 'action') as ContainerAction
  if (!CONTAINER_ACTIONS.has(action)) throw new Error(`Ação inválida: ${action}`)
  return containerAction(containerCmd(), action, param(req, 'id'), !!req.body?.force)
}))

apiRouter.get('/diagnostics', h(() => runDiagnostics({ settings: getSettings(), scan: lastScan, procs: pm.getStates(), port: Number(process.env.MSM_PORT) || 3210 })))

// ---- Redis ----
const redisCfg = () => getSettings().redis
apiRouter.get('/redis/info', h(async () => {
  const info = await redisOps.info(redisCfg())
  try {
    info.container = { name: redisCfg().containerName, ...(await containerState(containerCmd(), redisCfg().containerName)) }
  } catch {
    /* motor de containers indisponível */
  }
  return info
}))
apiRouter.get('/redis/keys', h((req) => redisOps.scan(redisCfg(), str(req.query.pattern) || '*', str(req.query.cursor) || '0', Number(req.query.count) || 200)))
apiRouter.get('/redis/key', h((req) => redisOps.getKey(redisCfg(), str(req.query.key))))
apiRouter.put('/redis/key', h((req) => redisOps.setString(redisCfg(), str(req.body?.key), str(req.body?.value), Number(req.body?.ttl) || undefined)))
apiRouter.post('/redis/delete', h((req) => redisOps.del(redisCfg(), strs(req.body?.keys))))
apiRouter.post('/redis/expire', h((req) => redisOps.expire(redisCfg(), str(req.body?.key), Number(req.body?.ttl) || 0)))
apiRouter.post('/redis/flush', h(() => redisOps.flush(redisCfg())))
apiRouter.post('/redis/command', h((req) => redisOps.command(redisCfg(), str(req.body?.line))))
apiRouter.post('/redis/container/start', h(async () => {
  const r = redisCfg()
  const msg = await ensureContainer(containerCmd(), {
    name: r.containerName, image: r.image, ports: [`${r.port}:6379`],
    args: r.password ? ['redis-server', '--requirepass', r.password] : []
  })
  await redisOps.reset()
  return msg
}))

/** Cliente REST da UI: o browser não pode chamar os serviços diretamente (CORS), por isso o servidor faz o pedido. */
apiRouter.post('/http', h(async (req): Promise<HttpResponse> => {
  const { method = 'GET', url, headers = {}, body } = (req.body ?? {}) as HttpRequest
  if (!/^https?:\/\//i.test(url ?? '')) throw new Error('URL inválido: tem de começar por http:// ou https://')
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 60_000)
  const started = Date.now()
  try {
    const res = await fetch(url, {
      method: method.toUpperCase(),
      headers,
      body: body && !['GET', 'HEAD'].includes(method.toUpperCase()) ? body : undefined,
      redirect: 'manual',
      signal: ctrl.signal
    })
    const text = await res.text()
    const hdrs: Record<string, string> = {}
    res.headers.forEach((v, k) => (hdrs[k] = v))
    return { status: res.status, statusText: res.statusText, headers: hdrs, body: text, timeMs: Date.now() - started }
  } catch (e) {
    const cause = (e as { cause?: { message?: string } }).cause?.message
    const msg = e instanceof Error ? (e.name === 'AbortError' ? 'timeout (60 s)' : cause ?? e.message) : String(e)
    return { status: 0, statusText: '', headers: {}, body: '', timeMs: Date.now() - started, error: msg }
  } finally {
    clearTimeout(timer)
  }
}))

export function shutdown(): Promise<void> {
  return pm.stopAll()
}
