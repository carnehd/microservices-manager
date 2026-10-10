import { Router, type Request, type Response } from 'express'
import { existsSync } from 'fs'
import { join } from 'path'
import { runArgs } from '../shared/run'
import type { RunSpec } from '../shared/types'
import { logCmd, recentCmds } from './cmdlog'
import { capture, cmdLine, containerAction, engineInfo, imageHistory, inspectContainer, listContainers, listImages, listNetworks, listVolumes, run, stats, type ContainerAction } from './engine'
import { addClient } from './events'
import { dataDir, getSettings, saveSettings } from './settings'
import { activeStreams, startStream, stopAllStreams, stopStream } from './streams'

export const apiRouter = Router()

type Handler = (req: Request, res: Response) => Promise<unknown> | unknown
/** Envolve um handler: resultado em JSON, erro como { error } 500. */
const h = (fn: Handler) => async (req: Request, res: Response): Promise<void> => {
  try {
    const r = await fn(req, res)
    if (!res.headersSent) res.json(r ?? { ok: true })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (!res.headersSent) res.status(500).json({ error: msg })
  }
}
const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const param = (req: Request, k: string): string => str(req.params[k])
const NAME_RE = /^[\w][\w.-]*$/
const assertName = (s: string, what = 'name'): string => { if (!NAME_RE.test(s)) throw new Error(`Invalid ${what}: ${s}`); return s }

// ---- infra ----
apiRouter.get('/events', (_req, res) => addClient(res))
apiRouter.get('/console/log', h(() => recentCmds()))
apiRouter.get('/settings', h(() => getSettings()))
apiRouter.put('/settings', h((req) => saveSettings(req.body ?? {})))
apiRouter.get('/engine', h(() => engineInfo()))
apiRouter.post('/machine/:name/:action', h(async (req) => {
  const action = param(req, 'action')
  if (!['start', 'stop', 'restart'].includes(action)) throw new Error('invalid action')
  const name = assertName(param(req, 'name'))
  if (action === 'restart') { await run(['machine', 'stop', name], { timeoutMs: 180_000 }); return (await run(['machine', 'start', name], { timeoutMs: 300_000 })).trim() }
  return (await run(['machine', action, name], { timeoutMs: 300_000 })).trim()
}))
apiRouter.get('/system/df', h(() => capture(['system', 'df'])))
apiRouter.post('/system/prune', h((req) => capture(['system', 'prune', '-f', ...(req.body?.volumes ? ['--volumes'] : [])])))
apiRouter.get('/streams', h(() => activeStreams()))
apiRouter.post('/streams/:id/stop', h((req) => { stopStream(param(req, 'id')); return { ok: true } }))

// ---- containers ----
apiRouter.get('/containers', h((req) => listContainers(req.query.quiet === '1')))
apiRouter.get('/containers/stats', h(() => stats()))
apiRouter.post('/containers/batch', h(async (req) => {
  const ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).map((s: unknown) => assertName(str(s)))
  const action = str(req.body?.action) as ContainerAction
  const results: Record<string, string> = {}
  for (const id of ids) {
    try { results[id] = await containerAction(action, id, !!req.body?.force) } catch (e) { results[id] = `✗ ${e instanceof Error ? e.message : String(e)}` }
  }
  return results
}))
apiRouter.post('/containers/prune', h(() => capture(['container', 'prune', '-f'])))
/** Cria (e arranca) um container a partir do formulário; devolve o comando e o id. */
apiRouter.post('/containers/run', h(async (req) => {
  const spec = req.body?.spec as RunSpec
  if (!spec?.image?.trim()) throw new Error('Image is required')
  const args = runArgs(spec)
  const out = await run(args, { timeoutMs: 600_000 })
  return { command: cmdLine(runArgs(spec, { maskSecrets: true })), output: out.trim() }
}))
apiRouter.get('/containers/:id/inspect', h((req) => inspectContainer(assertName(param(req, 'id'), 'container'))))
/** Comando dentro do container: `exec [-w dir] [-u user] <c> <shell> -c "<cmd>"` — o texto é um argumento só (sem shell do host). */
apiRouter.post('/containers/:id/exec', h((req) => {
  const id = assertName(param(req, 'id'), 'container')
  const command = str(req.body?.command).trim()
  if (!command) throw new Error('No command given')
  const cwd = str(req.body?.cwd).trim(), user = str(req.body?.user).trim(), shell = str(req.body?.shell).trim() || 'sh'
  if (cwd && !/^[\w./-]+$/.test(cwd)) throw new Error('Invalid working directory')
  if (user && !/^[\w.-]+(:[\w.-]+)?$/.test(user)) throw new Error('Invalid user')
  if (!['sh', 'bash', 'ash', 'zsh'].includes(shell)) throw new Error('Invalid shell')
  const pre = ['exec', ...(cwd ? ['-w', cwd] : []), ...(user ? ['-u', user] : []), id, shell, '-c']
  return capture([...pre, command], cmdLine([...pre, JSON.stringify(command)]))
}))
/** Logs em follow: stream `logs:<id>`; corpo { tail, since } */
apiRouter.post('/containers/:id/logs', h((req) => {
  const id = assertName(param(req, 'id'), 'container')
  const tail = String(Number(req.body?.tail) || getSettings().logsTail)
  const since = str(req.body?.since).trim()
  if (since && !/^[\w:.+-]+$/.test(since)) throw new Error('Invalid since')
  startStream(`logs:${id}`, ['logs', '-f', '--tail', tail, ...(since ? ['--since', since] : []), '-t', id], { replace: true })
  return { stream: `logs:${id}` }
}))
apiRouter.post('/containers/:id/cp', h((req) => {
  const id = assertName(param(req, 'id'), 'container')
  const from = str(req.body?.from).trim(), to = str(req.body?.to).trim(), dir = str(req.body?.direction)
  if (!from || !to) throw new Error('from and to are required')
  return capture(dir === 'in' ? ['cp', from, `${id}:${to}`] : ['cp', `${id}:${from}`, to])
}))
apiRouter.post('/containers/:id/commit', h((req) => {
  const id = assertName(param(req, 'id'), 'container')
  const tag = str(req.body?.tag).trim()
  if (!tag) throw new Error('tag is required')
  return capture(['commit', id, tag])
}))
apiRouter.post('/containers/:id/export', h((req) => {
  const id = assertName(param(req, 'id'), 'container')
  const file = str(req.body?.file).trim() || join(dataDir(), 'exports', `${id}.tar`)
  return capture(['export', '-o', file, id])
}))
apiRouter.post('/containers/:id/:action', h((req) => {
  const action = param(req, 'action') as ContainerAction
  if (!['start', 'stop', 'restart', 'pause', 'unpause', 'kill', 'remove'].includes(action)) throw new Error('invalid action')
  return containerAction(action, assertName(param(req, 'id'), 'container'), !!req.body?.force).then((out) => ({ output: out }))
}))

// ---- images ----
apiRouter.get('/images', h((req) => listImages(req.query.quiet === '1')))
apiRouter.post('/images/pull', h((req) => {
  const ref = str(req.body?.ref).trim()
  if (!ref || !/^[\w.\-/:@]+$/.test(ref)) throw new Error('Invalid image reference')
  const id = `pull:${ref}`
  startStream(id, ['pull', ref], { replace: true })
  return { stream: id }
}))
apiRouter.post('/images/build', h((req) => {
  const context = str(req.body?.context).trim(), tag = str(req.body?.tag).trim(), dockerfile = str(req.body?.dockerfile).trim()
  if (!context || !existsSync(context)) throw new Error('Context folder does not exist')
  if (!tag || !/^[\w.\-/:]+$/.test(tag)) throw new Error('Invalid tag')
  const id = `build:${tag}`
  startStream(id, ['build', '-t', tag, ...(dockerfile ? ['-f', dockerfile] : []), '.'], { cwd: context, replace: true })
  return { stream: id }
}))
apiRouter.post('/images/load', h((req) => {
  const file = str(req.body?.file).trim()
  if (!file || !existsSync(file)) throw new Error('File does not exist')
  return capture(['load', '-i', file])
}))
apiRouter.post('/images/prune', h((req) => capture(['image', 'prune', '-f', ...(req.body?.all ? ['-a'] : [])])))
apiRouter.get('/images/:id/history', h((req) => imageHistory(assertName(param(req, 'id'), 'image'))))
apiRouter.post('/images/:id/tag', h((req) => {
  const tag = str(req.body?.tag).trim()
  if (!tag || !/^[\w.\-/:]+$/.test(tag)) throw new Error('Invalid tag')
  return capture(['tag', assertName(param(req, 'id'), 'image'), tag])
}))
apiRouter.post('/images/:id/save', h((req) => {
  const id = assertName(param(req, 'id'), 'image')
  const file = str(req.body?.file).trim() || join(dataDir(), 'exports', `${id}.tar`)
  return capture(['save', '-o', file, str(req.body?.ref).trim() || id])
}))
apiRouter.post('/images/:id/run', h((req) => {
  // atalho "Run…" da lista de imagens: cria com -d e nome gerado
  const id = assertName(param(req, 'id'), 'image')
  const name = str(req.body?.name).trim()
  return capture(['run', '-d', ...(name ? ['--name', assertName(name)] : []), str(req.body?.ref).trim() || id])
}))
apiRouter.delete('/images/:id', h((req) => capture(['rmi', ...(req.body?.force ? ['-f'] : []), assertName(param(req, 'id'), 'image')])))

// ---- volumes & networks ----
apiRouter.get('/volumes', h((req) => listVolumes(req.query.quiet === '1')))
apiRouter.post('/volumes', h((req) => capture(['volume', 'create', assertName(str(req.body?.name))])))
apiRouter.post('/volumes/prune', h(() => capture(['volume', 'prune', '-f'])))
apiRouter.delete('/volumes/:name', h((req) => capture(['volume', 'rm', ...(req.body?.force ? ['-f'] : []), assertName(param(req, 'name'))])))
apiRouter.get('/networks', h((req) => listNetworks(req.query.quiet === '1')))
apiRouter.post('/networks', h((req) => capture(['network', 'create', assertName(str(req.body?.name))])))
apiRouter.delete('/networks/:name', h((req) => capture(['network', 'rm', ...(req.body?.force ? ['-f'] : []), assertName(param(req, 'name'))])))
apiRouter.post('/networks/:name/connect', h((req) => capture(['network', 'connect', assertName(param(req, 'name')), assertName(str(req.body?.container), 'container')])))
apiRouter.post('/networks/:name/disconnect', h((req) => capture(['network', 'disconnect', assertName(param(req, 'name')), assertName(str(req.body?.container), 'container')])))

// ---- eventos do motor (stream "events") ----
apiRouter.post('/engine-events/start', h(() => { startStream('events', ['events', '--format', 'json', '--since', '1s']); return { stream: 'events' } }))

// ---- consola do motor (comandos de leitura) ----
const CONSOLE_ALLOWED = new Set(['machine', 'info', 'version', 'ps', 'images', 'image', 'stats', 'system', 'volume', 'network', 'port', 'top', 'inspect', 'healthcheck', 'df', 'logs', 'events', 'pod'])
apiRouter.post('/console', h((req) => {
  const args = (Array.isArray(req.body?.args) ? req.body.args : []).map((a: unknown) => str(a)).filter(Boolean)
  if (!args.length) throw new Error('No command given')
  if (!CONSOLE_ALLOWED.has(args[0])) throw new Error(`"${args[0]}" is not allowed in the console (read-only commands)`)
  for (const a of args) if (!/^[\w.@:/=+,%-]+$/.test(a)) throw new Error(`Invalid argument: ${a}`)
  return capture(args)
}))

export function shutdown(): void {
  logCmd('shutting down', 'ok')
  stopAllStreams()
}
