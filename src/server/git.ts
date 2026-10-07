import { execFile } from 'child_process'
import { promises as fs } from 'fs'
import { join, relative, sep } from 'path'
import { promisify } from 'util'
import type { GitBranch, GitChange, GitCommit, GitInfo, GitStash, ServiceInfo } from '../shared/types'
import { logCmd } from './cmdlog'

const execFileP = promisify(execFile)
const US = '\x1f'

async function git(cwd: string, args: string[], opts: { okCodes?: number[]; timeoutMs?: number } = {}): Promise<string> {
  logCmd(`git ${args.join(' ')}   # in ${cwd}`, 'cmd') // Terminal comum (o poller de resumo corre em silêncio)
  const t0 = Date.now()
  try {
    const { stdout } = await execFileP('git', args, { cwd, timeout: opts.timeoutMs ?? 60_000, maxBuffer: 32 * 1024 * 1024, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' } })
    logCmd(`exit 0 · ${Date.now() - t0} ms`, 'ok')
    return stdout
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { stderr?: string; stdout?: string; code?: number | string }
    if (err.code === 'ENOENT') { logCmd('"git" not found in PATH', 'err'); throw new Error('"git" not found in PATH — install Git (https://git-scm.com)') }
    if (typeof err.code === 'number' && opts.okCodes?.includes(err.code)) { logCmd(`exit ${err.code} · ${Date.now() - t0} ms`, 'ok'); return err.stdout ?? '' }
    logCmd((err.stderr || err.message || 'git failed').trim().split('\n').pop() ?? 'git failed', 'err')
    const msg = (err.stderr || err.stdout || err.message || '').trim().split('\n').filter((l) => l && !l.startsWith('hint:')).join(' · ')
    throw new Error(msg || 'unknown git error')
  }
}

/** Raiz do repositório e prefixo da pasta do serviço dentro dele; null se não for um repo. */
async function repoOf(svc: ServiceInfo): Promise<{ root: string; prefix: string } | null> {
  try {
    const root = (await git(svc.path, ['rev-parse', '--show-toplevel'])).trim()
    const prefix = relative(root, svc.path).split(sep).join('/')
    return { root, prefix }
  } catch (e) {
    if (e instanceof Error && e.message.includes('not found')) throw e
    return null
  }
}

function scope(prefix: string): string[] {
  return prefix ? ['--', prefix] : []
}

function toServicePath(repoPath: string, prefix: string): string {
  return prefix && repoPath.startsWith(prefix + '/') ? repoPath.slice(prefix.length + 1) : repoPath
}

/** Parse de `git status --porcelain=v2 -z -b` (cabeçalhos de branch + entradas). */
function parseStatus(out: string, prefix: string): Omit<GitInfo, 'isRepo' | 'root' | 'prefix' | 'lastCommit' | 'remote'> {
  const tokens = out.split('\0')
  const info: ReturnType<typeof parseStatus> = { changes: [] }
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (!t) continue
    if (t.startsWith('# branch.head ')) {
      const head = t.slice(14)
      if (head === '(detached)') info.detached = true
      else info.branch = head
    } else if (t.startsWith('# branch.upstream ')) info.upstream = t.slice(18)
    else if (t.startsWith('# branch.ab ')) {
      const m = /\+(\d+) -(\d+)/.exec(t)
      if (m) {
        info.ahead = Number(m[1])
        info.behind = Number(m[2])
      }
    } else if (t.startsWith('# branch.oid ')) {
      if (info.detached) info.branch = t.slice(13, 20)
    } else if (t.startsWith('#')) continue
    else if (t.startsWith('1 ') || t.startsWith('2 ') || t.startsWith('u ')) {
      const parts = t.split(' ')
      const xy = parts[1]
      const nFixed = t.startsWith('1 ') ? 8 : t.startsWith('2 ') ? 9 : 10
      const repoPath = parts.slice(nFixed).join(' ')
      let origPath: string | undefined
      if (t.startsWith('2 ')) origPath = tokens[++i] // renomeado/copiado: o caminho original vem no token seguinte
      const staged = xy[0] !== '.'
      const unstaged = xy[1] !== '.'
      info.changes.push({
        path: toServicePath(repoPath, prefix),
        repoPath,
        origPath: origPath ? toServicePath(origPath, prefix) : undefined,
        code: t.startsWith('u ') ? 'U' : staged ? xy[0] : xy[1],
        staged,
        unstaged,
        untracked: false
      })
    } else if (t.startsWith('? ')) {
      const repoPath = t.slice(2)
      info.changes.push({ path: toServicePath(repoPath, prefix), repoPath, code: '?', staged: false, unstaged: true, untracked: true })
    }
  }
  return info
}

export async function gitInfo(svc: ServiceInfo): Promise<GitInfo> {
  const repo = await repoOf(svc)
  if (!repo) return { isRepo: false, changes: [] }
  const { root, prefix } = repo
  const status = parseStatus(await git(root, ['status', '--porcelain=v2', '-b', '-z', '--untracked-files=all', ...scope(prefix)]), prefix)
  let lastCommit: GitInfo['lastCommit']
  try {
    const [hash, author, when, subject] = (await git(root, ['log', '-1', `--format=%h${US}%an${US}%ar${US}%s`])).trim().split(US)
    if (hash) lastCommit = { hash, author, when, subject }
  } catch {
    /* repositório sem commits */
  }
  let remote: string | undefined
  try {
    remote = (await git(root, ['remote', 'get-url', 'origin'])).trim() || undefined
  } catch {
    /* sem origin */
  }
  return { isRepo: true, root, prefix, ...status, lastCommit, remote }
}

export async function branches(svc: ServiceInfo): Promise<GitBranch[]> {
  const repo = await repoOf(svc)
  if (!repo) throw new Error('Not a git repository')
  const fmt = `%(refname)${US}%(refname:short)${US}%(HEAD)${US}%(upstream:short)${US}%(committerdate:relative)${US}%(subject)`
  const out = await git(repo.root, ['for-each-ref', `--format=${fmt}`, '--sort=-committerdate', 'refs/heads', 'refs/remotes'])
  const list: GitBranch[] = []
  for (const line of out.split('\n').filter(Boolean)) {
    const [ref, name, head, upstream, when, subject] = line.split(US)
    if (ref.endsWith('/HEAD')) continue
    list.push({ name, current: head === '*', remote: ref.startsWith('refs/remotes/'), upstream: upstream || undefined, when, subject })
  }
  return list
}

export async function log(svc: ServiceInfo, max = 30): Promise<GitCommit[]> {
  const repo = await repoOf(svc)
  if (!repo) throw new Error('Not a git repository')
  const out = await git(repo.root, ['log', `-${max}`, `--format=%h${US}%an${US}%ar${US}%s${US}%D`, ...scope(repo.prefix)], { okCodes: [128] })
  return out.split('\n').filter(Boolean).map((l) => {
    const [hash, author, when, subject, refs] = l.split(US)
    return { hash, author, when, subject, refs: refs || undefined }
  })
}

export async function diff(svc: ServiceInfo, repoPath: string, staged: boolean, untracked: boolean): Promise<string> {
  const repo = await repoOf(svc)
  if (!repo) throw new Error('Not a git repository')
  let out: string
  if (untracked) out = await git(repo.root, ['diff', '--no-index', '--', '/dev/null', repoPath], { okCodes: [1] })
  else out = await git(repo.root, ['diff', ...(staged ? ['--cached'] : []), '--', repoPath])
  const MAX = 300_000
  return out.length > MAX ? out.slice(0, MAX) + '\n… (diff truncated)' : out
}

async function validBranch(root: string, name: string): Promise<string> {
  const n = name.trim()
  if (!n) throw new Error('Branch name required')
  await git(root, ['check-ref-format', '--branch', n]).catch(() => {
    throw new Error(`Invalid branch name: ${n}`)
  })
  return n
}

export async function createBranch(svc: ServiceInfo, name: string, from?: string): Promise<string> {
  const repo = await repoOf(svc)
  if (!repo) throw new Error('Not a git repository')
  const n = await validBranch(repo.root, name)
  const base = from?.trim() ?? ''
  if (base && !/^[\w][\w./-]*$/.test(base)) throw new Error(`Invalid base branch: ${base}`)
  // Base remota (origin/main): --no-track, senão o novo branch ficava a seguir origin/main e um `git push` iria para o main.
  const track = /^(origin|upstream)\//.test(base) ? ['--no-track'] : []
  return git(repo.root, ['checkout', '-b', ...track, n, ...(base ? [base] : [])])
}

export async function checkout(svc: ServiceInfo, name: string): Promise<string> {
  const repo = await repoOf(svc)
  if (!repo) throw new Error('Not a git repository')
  const n = name.trim()
  if (!n) throw new Error('Branch required')
  // "origin/x" → cria a branch local x a seguir a origin/x
  if (/^(origin|upstream)\//.test(n)) return git(repo.root, ['checkout', '--track', n])
  return git(repo.root, ['checkout', n])
}

export async function stage(svc: ServiceInfo, repoPaths: string[]): Promise<void> {
  const repo = await repoOf(svc)
  if (!repo) throw new Error('Not a git repository')
  if (!repoPaths.length) return
  await git(repo.root, ['add', '-A', '--', ...repoPaths])
}

export async function unstage(svc: ServiceInfo, repoPaths: string[]): Promise<void> {
  const repo = await repoOf(svc)
  if (!repo) throw new Error('Not a git repository')
  if (!repoPaths.length) return
  await git(repo.root, ['restore', '--staged', '--', ...repoPaths])
}

/** Descarta alterações: ficheiros seguidos voltam ao HEAD, não seguidos são apagados. */
export async function discard(svc: ServiceInfo, changes: Array<{ repoPath: string; untracked: boolean }>): Promise<void> {
  const repo = await repoOf(svc)
  if (!repo) throw new Error('Not a git repository')
  const tracked = changes.filter((c) => !c.untracked).map((c) => c.repoPath)
  const untracked = changes.filter((c) => c.untracked).map((c) => c.repoPath)
  if (tracked.length) await git(repo.root, ['restore', '--staged', '--worktree', '--', ...tracked])
  if (untracked.length) await git(repo.root, ['clean', '-f', '--', ...untracked])
}

export async function commit(svc: ServiceInfo, message: string, stageAll: boolean): Promise<string> {
  const repo = await repoOf(svc)
  if (!repo) throw new Error('Not a git repository')
  if (!message.trim()) throw new Error('Commit message required')
  if (stageAll) await git(repo.root, ['add', '-A', ...scope(repo.prefix)])
  return git(repo.root, ['commit', '-m', message.trim()])
}

export async function fetch(svc: ServiceInfo): Promise<string> {
  const repo = await repoOf(svc)
  if (!repo) throw new Error('Not a git repository')
  return git(repo.root, ['fetch', '--prune'], { timeoutMs: 120_000 })
}

export async function pull(svc: ServiceInfo): Promise<string> {
  const repo = await repoOf(svc)
  if (!repo) throw new Error('Not a git repository')
  return git(repo.root, ['pull', '--ff-only'], { timeoutMs: 120_000 })
}

export async function push(svc: ServiceInfo): Promise<string> {
  const repo = await repoOf(svc)
  if (!repo) throw new Error('Not a git repository')
  const info = await gitInfo(svc)
  if (info.detached || !info.branch) throw new Error('Detached HEAD: switch to a branch before pushing')
  const args = info.upstream ? ['push'] : ['push', '-u', 'origin', info.branch]
  // O git escreve o resumo do push em stderr; com sucesso devolvemos algo legível
  const out = await git(repo.root, args, { timeoutMs: 180_000 })
  return out.trim() || `pushed ${info.branch}`
}

/** Só o essencial para a barra lateral: branch e nº de alterações (1 status por repositório). */
const STASH_RE = /^stash@\{\d+\}$/

export async function stashList(svc: ServiceInfo): Promise<GitStash[]> {
  const repo = await repoOf(svc)
  if (!repo) throw new Error('Not a git repository')
  const out = await git(repo.root, ['stash', 'list', `--format=%gd${US}%s${US}%cr`])
  return out.split('\n').filter(Boolean).map((line) => {
    const [ref, message, when] = line.split(US)
    return { ref, message, when }
  })
}

/** Guarda alterações por commitar (incluindo ficheiros novos): só `repoPaths` se dados, senão tudo na pasta do serviço. */
export async function stashSave(svc: ServiceInfo, message: string, repoPaths: string[] = []): Promise<string> {
  const repo = await repoOf(svc)
  if (!repo) throw new Error('Not a git repository')
  const msg = message.trim()
  const paths = repoPaths.map((p) => p.trim()).filter(Boolean)
  return git(repo.root, ['stash', 'push', '-u', ...(msg ? ['-m', msg] : []), ...(paths.length ? ['--', ...paths] : scope(repo.prefix))])
}

/** apply mantém a entrada no stash; pop remove-a depois de aplicar com sucesso. */
export async function stashApply(svc: ServiceInfo, ref: string, pop: boolean): Promise<string> {
  const repo = await repoOf(svc)
  if (!repo) throw new Error('Not a git repository')
  if (!STASH_RE.test(ref)) throw new Error(`Invalid stash: ${ref}`)
  return git(repo.root, ['stash', pop ? 'pop' : 'apply', ref])
}

export async function stashDrop(svc: ServiceInfo, ref: string): Promise<string> {
  const repo = await repoOf(svc)
  if (!repo) throw new Error('Not a git repository')
  if (!STASH_RE.test(ref)) throw new Error(`Invalid stash: ${ref}`)
  return git(repo.root, ['stash', 'drop', ref])
}

/**
 * Deixa de commitar estes ficheiros: acrescenta-os ao .gitignore da raiz do repo e, se já estiverem
 * tracked, `git rm --cached` (saem do índice mas ficam no disco).
 */
export async function ignore(svc: ServiceInfo, changes: Array<{ repoPath: string; untracked: boolean }>): Promise<{ added: string[]; untracked: string[] }> {
  const repo = await repoOf(svc)
  if (!repo) throw new Error('Not a git repository')
  const file = join(repo.root, '.gitignore')
  let text = ''
  try { text = await fs.readFile(file, 'utf8') } catch { /* ainda não existe */ }
  const existing = new Set(text.split(/\r?\n/).map((l) => l.trim()))
  const added: string[] = []
  for (const c of changes) {
    const line = '/' + c.repoPath.replace(/\\/g, '/') // ancorado à raiz, para não apanhar homónimos noutras pastas
    if (existing.has(line) || existing.has(c.repoPath)) continue
    added.push(line)
  }
  if (added.length) {
    const sep2 = text.length && !text.endsWith('\n') ? '\n' : ''
    await fs.writeFile(file, `${text}${sep2}${added.join('\n')}\n`)
  }
  const tracked = changes.filter((c) => !c.untracked).map((c) => c.repoPath)
  if (tracked.length) await git(repo.root, ['rm', '--cached', '-r', '--', ...tracked])
  return { added, untracked: tracked }
}

export async function gitBrief(svc: ServiceInfo): Promise<{ branch?: string; changes: number; ahead?: number; behind?: number } | null> {
  const repo = await repoOf(svc).catch(() => null)
  if (!repo) return null
  const st = parseStatus(await git(repo.root, ['status', '--porcelain=v2', '-b', '-z', '--untracked-files=all', ...scope(repo.prefix)]), repo.prefix)
  return { branch: st.branch, changes: st.changes.length, ahead: st.ahead, behind: st.behind }
}
