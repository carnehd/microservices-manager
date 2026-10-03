import { execFile, spawn } from 'child_process'
import { promisify } from 'util'
import type { DbInfo, DbServiceInfo, ServiceInfo, SrDbInfo, SrDbStatus, SrTableData } from '../shared/types'
import { ensureContainer, listContainers } from './containers'
import { getSettings } from './settings'
import { dataDir } from './settings'
import { join } from 'path'
import { mkdirSync } from 'fs'

const execFileP = promisify(execFile)
const ID_RE = /^[A-Za-z_][\w$]*$/ // identificadores simples (base de dados / role)
const SR_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]*$/ // nomes de BD/schema de serviços SR (letras/dígitos, permite '_' e '-')

function cmd(): string {
  return getSettings().containerCommand?.trim() || 'podman'
}

async function run(args: string[], timeoutMs = 60_000): Promise<string> {
  try {
    const { stdout } = await execFileP(cmd(), args, { timeout: timeoutMs, windowsHide: true })
    return stdout
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { stderr?: string; stdout?: string }
    if (err.code === 'ENOENT') throw new Error(`"${cmd()}" not found in PATH`)
    throw new Error((err.stderr || err.stdout || err.message || '').trim().split('\n').filter(Boolean).pop() ?? 'error')
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
  if (!s.managed) throw new Error(`${s.name}: datasource points to ${s.host}:${s.port}, not the managed container (${pg.port})`)
  if (!ID_RE.test(s.db)) throw new Error(`${s.name}: invalid database name "${s.db}"`)
  const actions: string[] = []
  if (s.user !== pg.superUser) {
    if (!ID_RE.test(s.user)) throw new Error(`${s.name}: invalid user name "${s.user}"`)
    const exists = (await psql(`SELECT 1 FROM pg_roles WHERE rolname='${s.user}'`)) === '1'
    if (!exists) {
      const pw = (s.hasPassword ? servicePassword(s.id) : '') || s.user
      await psql(`CREATE ROLE "${s.user}" LOGIN PASSWORD '${pw.replace(/'/g, "''")}'`)
      actions.push(`role ${s.user} created`)
    }
  }
  const dbExists = (await psql(`SELECT 1 FROM pg_database WHERE datname='${s.db}'`)) === '1'
  if (!dbExists) {
    await psql(`CREATE DATABASE "${s.db}" OWNER "${s.user}"`)
    actions.push(`database ${s.db} created`)
  }
  return actions.length ? `${s.name}: ${actions.join(', ')}` : `${s.name}: already existed`
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
  if (!(await ready())) throw new Error('Postgres is not ready — start the container first')
  const list = dbServices(services).filter((s) => s.managed && (!only || s.id === only))
  if (!list.length) throw new Error('No managed Postgres service to create')
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
  if (!(await ready())) throw new Error('Postgres is not ready — start the container first')
  const pg = getSettings().postgres
  const db = o.db.trim()
  if (!ID_RE.test(db)) throw new Error(`Invalid database name: "${db}" (letters, digits and _)`)
  const user = (o.user || '').trim() || pg.superUser
  if (user !== pg.superUser && !ID_RE.test(user)) throw new Error(`Invalid user name: "${user}"`)
  const actions: string[] = []
  if (o.createUser && user !== pg.superUser) {
    const exists = (await psql(`SELECT 1 FROM pg_roles WHERE rolname='${user}'`)) === '1'
    const pw = (o.password ?? '').replace(/'/g, "''")
    if (!exists) {
      await psql(`CREATE ROLE "${user}" LOGIN PASSWORD '${pw}'`)
      actions.push(`user ${user} created`)
    } else if (o.password) {
      await psql(`ALTER ROLE "${user}" WITH LOGIN PASSWORD '${pw}'`)
      actions.push(`password for ${user} updated`)
    }
  }
  const dbExists = (await psql(`SELECT 1 FROM pg_database WHERE datname='${db}'`)) === '1'
  if (dbExists) throw new Error(`Database "${db}" already exists`)
  await psql(`CREATE DATABASE "${db}" OWNER "${user}"`)
  actions.push(`database ${db} created (owner ${user})`)
  return actions
}

/** Estado da BD de um microserviço SR: Postgres pronto, base/schema existem, e tabelas já criadas. */
export async function srDbStatus(spec: SrDbInfo): Promise<SrDbStatus> {
  const postgresReady = await ready()
  if (!postgresReady) return { spec, postgresReady: false, databaseExists: false, schemaExists: false, tables: [] }
  if (!SR_NAME_RE.test(spec.database) || !SR_NAME_RE.test(spec.schema)) {
    return { spec, postgresReady: true, databaseExists: false, schemaExists: false, tables: [] }
  }
  const databaseExists = (await psql(`SELECT 1 FROM pg_database WHERE datname='${spec.database}'`)) === '1'
  let schemaExists = false
  let tables: string[] = []
  if (databaseExists) {
    schemaExists = (await psql(`SELECT 1 FROM information_schema.schemata WHERE schema_name='${spec.schema}'`, spec.database)) === '1'
    if (schemaExists) {
      const out = await psql(
        `SELECT table_name FROM information_schema.tables WHERE table_schema='${spec.schema}' AND table_name NOT LIKE 'databasechange%' ORDER BY 1`,
        spec.database
      )
      tables = out ? out.split('\n').map((s) => s.trim()).filter(Boolean) : []
    }
  }
  return { spec, postgresReady, databaseExists, schemaExists, tables }
}

/** Cria a BD de um serviço SR (database + schema; 1 superuser). As tabelas ficam para o Liquibase no arranque. */
export async function createSrDb(spec: SrDbInfo, reset = false): Promise<string[]> {
  if (!(await ready())) throw new Error('Postgres is not ready — start the container first')
  const db = spec.database.trim()
  const schema = spec.schema.trim()
  if (!SR_NAME_RE.test(db)) throw new Error(`Invalid database name: "${db}"`)
  if (!SR_NAME_RE.test(schema)) throw new Error(`Invalid schema name: "${schema}"`)
  const { superUser } = getSettings().postgres
  const actions: string[] = []
  const dbExists = (await psql(`SELECT 1 FROM pg_database WHERE datname='${db}'`)) === '1'
  if (dbExists && reset) {
    await psql(`DROP DATABASE "${db}"`)
    actions.push(`database ${db} dropped`)
  }
  if (!dbExists || reset) {
    await psql(`CREATE DATABASE "${db}" OWNER "${superUser}"`)
    actions.push(`database ${db} created (owner ${superUser})`)
  } else {
    actions.push(`database ${db} already existed`)
  }
  const schemaExists = (await psql(`SELECT 1 FROM information_schema.schemata WHERE schema_name='${schema}'`, db)) === '1'
  if (!schemaExists) {
    await psql(`CREATE SCHEMA "${schema}" AUTHORIZATION "${superUser}"`, db)
    actions.push(`schema ${schema} created`)
  } else {
    actions.push(`schema ${schema} already existed`)
  }
  return actions
}

/** Apaga a base de dados de um serviço SR (termina ligações ativas com WITH FORCE). */
export async function dropSrDb(spec: SrDbInfo): Promise<string[]> {
  if (!(await ready())) throw new Error('Postgres is not ready')
  const db = spec.database.trim()
  if (!SR_NAME_RE.test(db)) throw new Error(`Invalid database name: "${db}"`)
  const exists = (await psql(`SELECT 1 FROM pg_database WHERE datname='${db}'`)) === '1'
  if (!exists) return [`database ${db} does not exist`]
  await psql(`DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`)
  return [`database ${db} deleted`]
}

/** Lê (só leitura) as primeiras linhas de uma tabela do schema do serviço SR. */
export async function srTableData(spec: SrDbInfo, table: string, limit = 100): Promise<SrTableData> {
  if (!(await ready())) throw new Error('Postgres is not ready')
  if (!SR_NAME_RE.test(spec.database) || !SR_NAME_RE.test(spec.schema)) throw new Error('Invalid database configuration')
  if (!SR_NAME_RE.test(table)) throw new Error(`Invalid table: "${table}"`)
  const n = Math.min(Math.max(limit, 1), 1000)
  const exists = (await psql(`SELECT 1 FROM information_schema.tables WHERE table_schema='${spec.schema}' AND table_name='${table}'`, spec.database)) === '1'
  if (!exists) throw new Error(`Table "${table}" does not exist in ${spec.schema}`)
  const colsOut = await psql(
    `SELECT string_agg(column_name, ',' ORDER BY ordinal_position) FROM information_schema.columns WHERE table_schema='${spec.schema}' AND table_name='${table}'`,
    spec.database
  )
  const columns = colsOut ? colsOut.split(',') : []
  const jsonOut = await psql(
    `SELECT coalesce(json_agg(t), '[]') FROM (SELECT * FROM "${spec.schema}"."${table}" ORDER BY 1 LIMIT ${n + 1}) t`,
    spec.database
  )
  let rows: Array<Record<string, unknown>> = []
  try {
    rows = JSON.parse(jsonOut || '[]')
  } catch {
    rows = []
  }
  const truncated = rows.length > n
  if (truncated) rows = rows.slice(0, n)
  return { table, columns, rows, truncated, limit: n }
}

/** Executa SQL arbitrário numa base (criar tabelas, consultas…). Devolve o output do psql. */
export async function runSql(db: string, sql: string): Promise<{ output: string; error: boolean }> {
  if (!(await ready())) throw new Error('Postgres is not ready')
  const { containerName, superUser } = getSettings().postgres
  if (!ID_RE.test(db)) throw new Error(`Invalid database: "${db}"`)
  if (!sql.trim()) throw new Error('Empty SQL')
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
