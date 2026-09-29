import { promises as fs } from 'fs'
import { basename, dirname, join, relative, sep } from 'path'
import type { BrunoCollection, BrunoEnv, BrunoRequest } from '../shared/types'

const SKIP = new Set(['target', 'build', 'dist', 'out', 'node_modules', '.git', '.idea', '.mvn'])
const posix = (p: string): string => p.split(sep).join('/')

/** Pastas que contêm bruno.json (raiz de uma coleção Bruno), relativas a `root`. */
export async function findCollectionDirs(root: string): Promise<string[]> {
  const out: string[] = []
  let budget = 4000
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 6 || budget <= 0) return
    let entries: import('fs').Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    if (entries.some((e) => e.isFile() && e.name === 'bruno.json')) {
      out.push(posix(relative(root, dir)) || '.')
      return // uma coleção não tem coleções aninhadas
    }
    for (const e of entries) {
      if (budget-- <= 0) return
      if (e.isDirectory() && !SKIP.has(e.name) && !e.name.startsWith('.')) await walk(join(dir, e.name), depth + 1)
    }
  }
  await walk(root, 0)
  return out.sort()
}

/** Divide o texto .bru nos seus blocos de topo `nome { … }` (contagem de chavetas para apanhar JSON no corpo). */
function blocks(text: string): Array<{ name: string; content: string }> {
  const out: Array<{ name: string; content: string }> = []
  const re = /([A-Za-z][\w:-]*)\s*\{/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    let depth = 1
    let j = re.lastIndex
    for (; j < text.length && depth > 0; j++) {
      if (text[j] === '{') depth++
      else if (text[j] === '}') depth--
    }
    out.push({ name: m[1], content: text.slice(re.lastIndex, j - 1) })
    re.lastIndex = j
  }
  return out
}

/** Pares chave: valor de um bloco; ignora linhas desativadas (~chave). */
function kv(content: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const raw of content.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('~')) continue
    const i = line.indexOf(':')
    if (i < 0) continue
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim()
  }
  return out
}

/** Remove a indentação comum e as linhas em branco das pontas (para corpos json/text). */
function dedent(content: string): string {
  const lines = content.replace(/^\n+/, '').replace(/\s+$/, '').split('\n')
  const indent = Math.min(...lines.filter((l) => l.trim()).map((l) => l.match(/^ */)![0].length))
  return lines.map((l) => l.slice(indent)).join('\n')
}

const METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options'])

function parseRequest(text: string, file: string, folder: string): BrunoRequest | null {
  const bs = blocks(text)
  const meta = kv(bs.find((b) => b.name === 'meta')?.content ?? '')
  const methodBlock = bs.find((b) => METHODS.has(b.name))
  if (!methodBlock) return null
  const m = kv(methodBlock.content)
  const req: BrunoRequest = {
    file,
    folder,
    name: meta.name || basename(file, '.bru'),
    seq: meta.seq ? Number(meta.seq) : undefined,
    method: methodBlock.name.toUpperCase(),
    url: m.url ?? '',
    headers: kv(bs.find((b) => b.name === 'headers')?.content ?? ''),
    params: kv(bs.find((b) => b.name === 'query' || b.name === 'params:query')?.content ?? '')
  }
  const body = bs.find((b) => b.name.startsWith('body'))
  if (body && body.name !== 'body' && m.body !== 'none') {
    req.bodyType = body.name.slice('body:'.length) || m.body
    req.body = /json|text|xml|graphql|sparql/.test(req.bodyType) ? dedent(body.content) : JSON.stringify(kv(body.content), null, 2)
  }
  const auth = bs.find((b) => b.name.startsWith('auth:'))
  if (auth) {
    const a = kv(auth.content)
    req.auth = { type: auth.name.slice('auth:'.length), token: a.token, username: a.username, password: a.password }
  }
  return req
}

async function readEnvironments(colDir: string): Promise<BrunoEnv[]> {
  const dir = join(colDir, 'environments')
  let names: string[] = []
  try {
    names = (await fs.readdir(dir)).filter((f) => f.endsWith('.bru'))
  } catch {
    return []
  }
  const envs: BrunoEnv[] = []
  for (const n of names.sort()) {
    const text = await fs.readFile(join(dir, n), 'utf8')
    const vars = kv(blocks(text).find((b) => b.name === 'vars')?.content ?? '')
    envs.push({ name: basename(n, '.bru'), vars })
  }
  return envs
}

async function readRequests(colDir: string): Promise<BrunoRequest[]> {
  const reqs: BrunoRequest[] = []
  async function walk(dir: string): Promise<void> {
    let entries: import('fs').Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const full = join(dir, e.name)
      if (e.isDirectory()) {
        if (e.name !== 'environments' && !e.name.startsWith('.')) await walk(full)
      } else if (e.name.endsWith('.bru') && e.name !== 'folder.bru' && e.name !== 'collection.bru') {
        const text = await fs.readFile(full, 'utf8')
        const rel = posix(relative(colDir, full))
        const req = parseRequest(text, rel, posix(relative(colDir, dir)))
        if (req) reqs.push(req)
      }
    }
  }
  await walk(colDir)
  reqs.sort((a, b) => a.folder.localeCompare(b.folder) || (a.seq ?? 999) - (b.seq ?? 999) || a.name.localeCompare(b.name))
  return reqs
}

async function collectionName(colDir: string): Promise<string> {
  try {
    return (JSON.parse(await fs.readFile(join(colDir, 'bruno.json'), 'utf8')).name as string) || basename(colDir)
  } catch {
    return basename(colDir)
  }
}

export async function listCollections(servicePath: string): Promise<BrunoCollection[]> {
  const dirs = await findCollectionDirs(servicePath)
  const out: BrunoCollection[] = []
  for (const rel of dirs) {
    const colDir = join(servicePath, rel === '.' ? '' : rel)
    out.push({
      name: await collectionName(colDir),
      dir: rel,
      environments: await readEnvironments(colDir),
      requests: await readRequests(colDir)
    })
  }
  return out
}

export const dirnameOf = dirname
