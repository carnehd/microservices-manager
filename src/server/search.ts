import { promises as fs } from 'fs'
import { extname, join, relative, sep } from 'path'
import type { SearchHit, SearchResult, ServiceInfo } from '../shared/types'

const SKIP_DIRS = new Set(['target', 'node_modules', '.git', '.idea', '.mvn', 'build', 'dist', 'out', '.gradle', 'bin', '.settings', 'coverage', '.vscode'])
const MAX_FILE = 2 * 1024 * 1024 // 2 MB por ficheiro
const MAX_HITS = 2000
const MAX_PER_FILE = 50
const MAX_FILES = 40000

/** Procura uma string (substring) nos ficheiros dos microserviços, filtrando por extensão. */
export async function searchInServices(services: ServiceInfo[], query: string, exts: string[], caseSensitive: boolean): Promise<SearchResult> {
  const q = (query ?? '').trim()
  if (!q) throw new Error('Empty search string')
  const extSet = new Set(exts.map((e) => e.replace(/^\./, '').toLowerCase()).filter(Boolean))
  const needle = caseSensitive ? q : q.toLowerCase()
  const hits: SearchHit[] = []
  let scanned = 0
  let truncated = false

  // dedupe serviços pela pasta (multi-módulo pode repetir a raiz)
  const seen = new Set<string>()
  const roots = services.filter((s) => s.path && !seen.has(s.path) && seen.add(s.path))

  outer: for (const svc of roots) {
    const stack = [svc.path]
    while (stack.length) {
      const dir = stack.pop() as string
      let entries: import('fs').Dirent[]
      try {
        entries = await fs.readdir(dir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const e of entries) {
        const full = join(dir, e.name)
        if (e.isDirectory()) {
          if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) stack.push(full)
          continue
        }
        if (!e.isFile()) continue
        const ext = extname(e.name).slice(1).toLowerCase()
        if (extSet.size && !extSet.has(ext)) continue
        if (++scanned > MAX_FILES) { truncated = true; break outer }
        let text: string
        try {
          const st = await fs.stat(full)
          if (st.size > MAX_FILE) continue
          text = await fs.readFile(full, 'utf8')
        } catch {
          continue
        }
        if (text.includes('\u0000')) continue // binário
        const lines = text.split(/\r?\n/)
        let perFile = 0
        for (let i = 0; i < lines.length; i++) {
          const hay = caseSensitive ? lines[i] : lines[i].toLowerCase()
          if (hay.includes(needle)) {
            hits.push({ service: svc.name, serviceId: svc.id, file: relative(svc.path, full).split(sep).join('/'), path: full, line: i + 1, text: lines[i].trim().slice(0, 300) })
            if (++perFile >= MAX_PER_FILE) break
            if (hits.length >= MAX_HITS) { truncated = true; break outer }
          }
        }
      }
    }
  }
  return { hits, scanned, truncated }
}
