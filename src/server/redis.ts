import { createClient, type RedisClientType } from 'redis'
import type { RedisInfo, RedisKeyValue, RedisScan, RedisSettings } from '../shared/types'

let client: RedisClientType | null = null
let clientKey = ''
let lastError: string | undefined

function keyOf(s: RedisSettings): string {
  return `${s.host}|${s.port}|${s.db}|${s.password ?? ''}`
}

/** Fecha a ligação atual (após mudar as definições). */
export async function reset(): Promise<void> {
  const c = client
  client = null
  clientKey = ''
  if (c) await c.quit().catch(() => c.disconnect().catch(() => {}))
}

async function get(s: RedisSettings): Promise<RedisClientType> {
  const k = keyOf(s)
  if (client && clientKey === k && client.isOpen) return client
  await reset()
  const c = createClient({
    // Falha rápido; se a ligação cair, get() volta a ligar no pedido seguinte (isOpen=false)
    socket: { host: s.host, port: s.port, connectTimeout: 3000, reconnectStrategy: false },
    password: s.password || undefined,
    database: s.db
  }) as RedisClientType
  c.on('error', (e: Error) => {
    lastError = e.message
  })
  try {
    await c.connect()
  } catch (e) {
    await c.disconnect().catch(() => {})
    throw new Error(`Redis is not responding at ${s.host}:${s.port}: ${e instanceof Error ? e.message : String(e)}`)
  }
  client = c
  clientKey = k
  lastError = undefined
  return c
}

function parseInfo(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split(/\r?\n/)) {
    const i = line.indexOf(':')
    if (i > 0 && !line.startsWith('#')) out[line.slice(0, i)] = line.slice(i + 1)
  }
  return out
}

export async function info(s: RedisSettings): Promise<RedisInfo> {
  const base: RedisInfo = { connected: false, host: s.host, port: s.port, db: s.db }
  try {
    const c = await get(s)
    const i = parseInfo(await c.info())
    return {
      ...base,
      connected: true,
      version: i.redis_version,
      uptimeSec: Number(i.uptime_in_seconds) || undefined,
      usedMemory: i.used_memory_human,
      keys: await c.dbSize(),
      clients: Number(i.connected_clients) || undefined,
      hits: Number(i.keyspace_hits) || 0,
      misses: Number(i.keyspace_misses) || 0
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { ...base, error: msg.includes(s.host) ? msg : `Redis is not responding at ${s.host}:${s.port}: ${msg}` }
  }
}

export async function scan(s: RedisSettings, pattern: string, cursor: string, count: number): Promise<RedisScan> {
  const c = await get(s)
  const r = await c.scan(cursor as never, { MATCH: pattern || '*', COUNT: Math.min(Math.max(count, 10), 1000) })
  const keys = (r.keys as string[]).slice(0, 500)
  const metas = await Promise.all(keys.map(async (key) => ({ key, type: await c.type(key), ttl: await c.ttl(key) })))
  return { cursor: String(r.cursor), keys: metas }
}

export async function getKey(s: RedisSettings, key: string): Promise<RedisKeyValue> {
  if (!key) throw new Error('Key required')
  const c = await get(s)
  const type = await c.type(key)
  const ttl = await c.ttl(key)
  const memory = await c.memoryUsage(key).catch(() => null)
  const out: RedisKeyValue = { key, type, ttl, value: null, memory: memory ?? undefined }
  switch (type) {
    case 'string': out.value = await c.get(key); break
    case 'hash': out.value = await c.hGetAll(key); out.length = Object.keys(out.value as object).length; break
    case 'list': out.length = await c.lLen(key); out.value = await c.lRange(key, 0, 999); break
    case 'set': out.length = await c.sCard(key); out.value = (await c.sMembers(key)).slice(0, 1000); break
    case 'zset': out.length = await c.zCard(key); out.value = (await c.zRangeWithScores(key, 0, 999)).map((m) => ({ member: String(m.value), score: m.score })); break
    case 'stream': out.length = await c.xLen(key); out.value = await c.xRange(key, '-', '+', { COUNT: 100 }); break
    case 'none': throw new Error(`Key "${key}" does not exist`)
    default: {
      // Tipos de módulos (ReJSON-RL, TSDB-TYPE…): tenta JSON.GET; senão mostra só o tipo
      if (type.startsWith('ReJSON')) out.value = await c.sendCommand(['JSON.GET', key]).catch(() => null)
    }
  }
  return out
}

export async function setString(s: RedisSettings, key: string, value: string, ttl?: number): Promise<void> {
  if (!key) throw new Error('Key required')
  const c = await get(s)
  await c.set(key, value, ttl && ttl > 0 ? { EX: Math.floor(ttl) } : undefined)
}

export async function del(s: RedisSettings, keys: string[]): Promise<number> {
  if (!keys.length) return 0
  const c = await get(s)
  return c.del(keys)
}

export async function expire(s: RedisSettings, key: string, ttl: number): Promise<void> {
  const c = await get(s)
  if (ttl > 0) await c.expire(key, Math.floor(ttl))
  else await c.persist(key)
}

export async function flush(s: RedisSettings): Promise<void> {
  const c = await get(s)
  await c.flushDb()
}

/** Divide "SET a 'b c'" em argumentos respeitando aspas simples e duplas. */
function splitArgs(line: string): string[] {
  const args: string[] = []
  const re = /"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|(\S+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(line))) args.push((m[1] ?? m[2] ?? m[3]).replace(/\\(["'\\])/g, '$1'))
  return args
}

const BLOCKED = new Set(['SUBSCRIBE', 'PSUBSCRIBE', 'SSUBSCRIBE', 'MONITOR', 'SYNC', 'PSYNC', 'SHUTDOWN', 'DEBUG', 'QUIT', 'RESET'])

export async function command(s: RedisSettings, line: string): Promise<unknown> {
  const args = splitArgs(line.trim())
  if (!args.length) throw new Error('Empty command')
  if (BLOCKED.has(args[0].toUpperCase())) throw new Error(`Command ${args[0].toUpperCase()} not allowed from the app`)
  const c = await get(s)
  return c.sendCommand(args)
}

export function lastErrorMessage(): string | undefined {
  return lastError
}
