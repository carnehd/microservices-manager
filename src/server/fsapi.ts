import { spawn } from 'child_process'
import { existsSync, readdirSync } from 'fs'
import { dirname, resolve } from 'path'
import type { DirListing } from '../shared/types'
import { logCmd } from './cmdlog'

const isWin = process.platform === 'win32'

/** Listagem de subpastas para o seletor de pastas da UI (o browser não tem diálogo nativo de pastas). */
export function listDirs(p?: string): DirListing {
  const drives = isWin ? 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((l) => `${l}:\\`).filter((d) => existsSync(d)) : []
  if (!p) {
    if (isWin) return { path: '', dirs: [], drives }
    p = '/'
  }
  const path = resolve(p)
  if (!existsSync(path)) throw new Error(`Folder does not exist: ${path}`)
  let dirs: string[]
  try {
    dirs = readdirSync(path, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('$'))
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
  } catch {
    throw new Error(`No access to ${path}`)
  }
  const parent = dirname(path)
  return { path, parent: parent === path ? (isWin ? '' : undefined) : parent, dirs, drives }
}

export function openPath(dir: string): void {
  if (!existsSync(dir)) throw new Error(`Folder does not exist: ${dir}`)
  const [cmd, args] = isWin ? ['explorer.exe', [dir]] : process.platform === 'darwin' ? ['open', [dir]] : ['xdg-open', [dir]]
  logCmd(`${cmd} ${args.join(' ')}`, 'cmd')
  spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref()
}

export function openTerminal(dir: string): void {
  if (!existsSync(dir)) throw new Error(`Folder does not exist: ${dir}`)
  if (isWin) { logCmd(`start "" cmd.exe   # in ${dir}`, 'cmd'); spawn('start "" cmd.exe', { cwd: dir, shell: true, detached: true, stdio: 'ignore' }).unref() }
  else if (process.platform === 'darwin') { logCmd(`open -a Terminal ${dir}`, 'cmd'); spawn('open', ['-a', 'Terminal', dir], { detached: true, stdio: 'ignore' }).unref() }
  else { logCmd(`x-terminal-emulator   # in ${dir}`, 'cmd'); spawn('x-terminal-emulator', [], { cwd: dir, detached: true, stdio: 'ignore' }).unref() }
}
