import { execFile, spawn } from 'child_process'
import { promisify } from 'util'
import type { DbInfo, DbServiceInfo, ServiceInfo } from '../shared/types'
import { ensureContainer, listContainers } from './containers'
import { getSettings } from './settings'
import { dataDir } from './settings'
import { join } from 'path'
import { mkdirSync } from 'fs'

const execFileP = promisify(execFile)
const ID_RE = /^[A-Za-z_][\w$]*$/ // identificadores simples (base de dados / role)

function cmd(): string {
  return getSettings().containerCommand?.trim() || 'podman'
}

async function run(args: string[], timeoutMs = 60_000): Promise<string> {
  try {
    const { stdout } = await execFileP(cmd(), args, { timeout: timeoutMs, windowsHide: true })
    return stdout
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { stderr?: string; stdout?: string }
    if (err.code === 'ENOENT') throw new Error(`"${cmd()}" não encontrado no PATH`)
    throw new Error((err.stderr || err.stdout || err.message || '').trim().split('\n').filter(Boolean).pop() ?? 'erro')
  }
}

/** psql dentro do container como superutilizador (socket local = trust), devolve stdout (-tA). */
function execArgs(extra: string[]): string[] {
  const { containerName, superPassword } = getSettings().postgres
  // -e PGPASSWORD cobre imagens que exigem password; em trust (socket local) é ignorado
  return ['exec', ...(superPassword ? ['-e', `PGPASSWORD=${superPassword}`] : []), containerName, ...extra]
}
async function psql(sql: string, db = 'postgres'): Promise<string> {
  const { superUser } = getSettings().postgres
  return (await run(execArgs(['psql', '-U', superUser, '-d', db, '-v', 'ON_ERROR_STOP=1', '-tAc', sql]))).trim()
}

/** jdbc:postgresql://host:port/db?params → partes. */
function parseJdbc(url: string): { host: string; port: number; db: string } | null {
  const m = /jdbc:postgresql:\/\/([^:/]+)(?::(\d+))?\/([^?;]+)/.exec(url)
  if (!m) return null
  return { host: m[1], port: m[2] ? Number(m[2]) : 5432, db: m[3] }
}

function isPostgres(svc: ServiceInfo): boolean {
  const ds = svc.datasource
  return !!ds && (/postgresql/i.test(ds.url ?? '') || /postgresql/i.test(ds.driver ?? ''))
}

/** Serviços que usam Postgres, com a base/utilizador a que apontam. */
export function dbServices(services: ServiceInfo[]): DbServiceInfo[] {
  const pg = getSettings().postgres
  const out: DbServiceInfo[] = []
  for (const svc of services) {
    if (!isPostgres(svc)) continue
    const parsed = parseJdbc(svc.datasource!.url ?? '')
    if (!parsed) continue
    const local = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|::1)$/i.test(parsed.host)
    out.push({
      id: svc.id,
      name: svc.name,
      url: svc.datasource!.url ?? '',
      host: parsed.host,
      port: parsed.port,
      db: parsed.db,
      user: svc.datasource!.username || pg.superUser,
      hasPassword: !!svc.datasource!.password,
      managed: local && parsed.port === pg.port
    })
  }
  return out
}

async function ready(): Promise<boolean> {
  const { superUser } = getSettings().postgres
  try {
    await run(execArgs(['pg_isready', '-U', superUser]), 8000)
    return true
  } catch {
    return false
  }
}

export async function dbInfo(services: ServiceInfo[]): Promise<DbInfo> {
  const pg = getSettings().postgres
  const info: DbInfo = {
    container: { name: pg.containerName, image: pg.image, exists: false, running: false },
    ready: false,
    services: dbServices(services),
    candidates: []
  }
  try {
    const cs = await listContainers(cmd())
    const mine = cs.find((c) => c.name === pg.containerName)
    info.container.exists = !!mine
    info.container.running = mine?.state === 'running'
    info.candidates = cs.filter((c) => /postgres/i.test(c.image) || /postgres|pg\b/i.test(c.name)).map((c) => ({ name: c.name, image: c.image, running: c.state === 'running' }))
  } catch (e) {
    info.engineError = e instanceof Error ? e.message : String(e)
    return info
  }
  if (info.container.running) info.ready = await ready()
  if (info.ready) {
    const dbs = new Set((await psql("SELECT datname FROM pg_database")).split('\n').filter(Boolean))
    const roles = new Set((await psql("SELECT rolname FROM pg_roles")).split('\n').filter(Boolean))
    for (const s of info.services) {
      if (!s.managed) continue
      s.dbExists = dbs.has(s.db)
      s.roleExists = roles.has(s.user)
    }
  }
  return info
}

export async function startPostgres(): Promise<string> {
  const pg = getSettings().postgres
  const data = pg.dataDir?.trim() || join(dataDir(), 'postgres-data')
  mkdirSync(data, { recursive: true })
  const msg = await ensureContainer(cmd(), {
    name: pg.containerName,
    image: pg.image,
    ports: [`${pg.port}:5432`],
    volumes: [`${data}:/var/lib/postgresql/data`],
    env: { POSTGRES_USER: pg.superUser, POSTGRES_PASSWORD: pg.superPassword, POSTGRES_DB: pg.superUser, PGDATA: '/var/lib/postgresql/data/pgdata' }
  })
  return msg
}

/** Cria role + base de dados de um serviço (idempotente). */
async function createFor(s: DbServiceInfo): Promise<string> {
  const pg = getSettings().postgres
  if (!s.managed) throw new Error(`${s.name}: datasource aponta para ${s.host}:${s.port}, não o container gerido (${pg.port})`)
  if (!ID_RE.test(s.db)) throw new Error(`${s.name}: nome de base inválido "${s.db}"`)
  const actions: string[] = []
  if (s.user !== pg.superUser) {
    if (!ID_RE.test(s.user)) throw new Error(`${s.name}: nome de utilizador inválido "${s.user}"`)
    const exists = (await psql(`SELECT 1 FROM pg_roles WHERE rolname='${s.user}'`)) === '1'
    if (!exists) {
      const pw = (s.hasPassword ? servicePassword(s.id) : '') || s.user
      await psql(`CREATE ROLE "${s.user}" LOGIN PASSWORD '${pw.replace(/'/g, "''")}'`)
      actions.push(`role ${s.user} criada`)
    }
  }
  const dbExists = (await psql(`SELECT 1 FROM pg_database WHERE datname='${s.db}'`)) === '1'
  if (!dbExists) {
    await psql(`CREATE DATABASE "${s.db}" OWNER "${s.user}"`)
    actions.push(`base ${s.db} criada`)
  }
  return actions.length ? `${s.name}: ${actions.join(', ')}` : `${s.name}: já existia`
}

/** Password do datasource, lida do scan (evita expor no DbServiceInfo). */
let passwordLookup: (id: string) => string | undefined = () => undefined
export function setPasswordLookup(fn: (id: string) => string | undefined): void {
  passwordLookup = fn
}
function servicePassword(id: string): string {
  return passwordLookup(id) ?? ''
}

export async function createDatabases(services: ServiceInfo[], only?: string): Promise<string[]> {
  if (!(await ready())) throw new Error('O Postgres não está pronto — arranca o container primeiro')
  const list = dbServices(services).filter((s) => s.managed && (!only || s.id === only))
  if (!list.length) throw new Error('Nenhum serviço Postgres gerido para criar')
  const results: string[] = []
  for (const s of list) results.push(await createFor(s))
  return results
}

export async function listDatabases(): Promise<string[]> {
  if (!(await ready())) return []
  return (await psql("SELECT datname FROM pg_database WHERE datistemplate=false ORDER BY datname")).split('\n').filter(Boolean)
}

/** Cria uma base de dados nova (e, opcionalmente, o utilizador/dono) a partir do formulário. */
export async function createDatabaseManual(o: { db: string; user?: string; password?: string; createUser?: boolean }): Promise<string[]> {
  if (!(await ready())) throw new Error('O Postgres não está pronto — arranca o container primeiro')
  const pg = getSettings().postgres
  const db = o.db.trim()
  if (!ID_RE.test(db)) throw new Error(`Nome de base inválido: "${db}" (letras, dígitos e _)`)
  const user = (o.user || '').trim() || pg.superUser
  if (user !== pg.superUser && !ID_RE.test(user)) throw new Error(`Nome de utilizador inválido: "${user}"`)
  const actions: string[] = []
  if (o.createUser && user !== pg.superUser) {
    const exists = (await psql(`SELECT 1 FROM pg_roles WHERE rolname='${user}'`)) === '1'
    const pw = (o.password ?? '').replace(/'/g, "''")
    if (!exists) {
      await psql(`CREATE ROLE "${user}" LOGIN PASSWORD '${pw}'`)
      actions.push(`utilizador ${user} criado`)
    } else if (o.password) {
      await psql(`ALTER ROLE "${user}" WITH LOGIN PASSWORD '${pw}'`)
      actions.push(`password de ${user} atualizada`)
    }
  }
  const dbExists = (await psql(`SELECT 1 FROM pg_database WHERE datname='${db}'`)) === '1'
  if (dbExists) throw new Error(`A base "${db}" já existe`)
  await psql(`CREATE DATABASE "${db}" OWNER "${user}"`)
  actions.push(`base ${db} criada (dono ${user})`)
  return actions
}

/** Executa SQL arbitrário numa base (criar tabelas, consultas…). Devolve o output do psql. */
export async function runSql(db: string, sql: string): Promise<{ output: string; error: boolean }> {
  if (!(await ready())) throw new Error('O Postgres não está pronto')
  const { containerName, superUser } = getSettings().postgres
  if (!ID_RE.test(db)) throw new Error(`Base inválida: "${db}"`)
  if (!sql.trim()) throw new Error('SQL vazio')
  return new Promise((resolve) => {
    const { superPassword } = getSettings().postgres
    const pre = superPassword ? ['-e', `PGPASSWORD=${superPassword}`] : []
    const child = spawn(cmd(), ['exec', '-i', ...pre, containerName, 'psql', '-U', superUser, '-d', db, '-v', 'ON_ERROR_STOP=1'], { windowsHide: true })
    let out = ''
    const timer = setTimeout(() => child.kill(), 60_000)
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (out += d))
    child.on('error', (e) => { clearTimeout(timer); resolve({ output: e.message, error: true }) })
    child.on('close', (code) => { clearTimeout(timer); resolve({ output: out.trim() || '(sem output)', error: code !== 0 }) })
    child.stdin.end(sql)
  })
}
