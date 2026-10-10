import { useCallback, useEffect, useRef, useState } from 'react'
import type { StreamLine } from '../../shared/types'
import { onStreamEnd, onStreamLine } from './api'

/** Linhas de um stream do servidor (logs -f, pull, build, events), com limite. */
export function useStream(id: string | null, max = 5000): { lines: StreamLine[]; ended: number | null | undefined; clear: () => void } {
  const [lines, setLines] = useState<StreamLine[]>([])
  const [ended, setEnded] = useState<number | null | undefined>(undefined)
  useEffect(() => {
    setLines([])
    setEnded(undefined)
    if (!id) return
    const offLine = onStreamLine((l) => { if (l.id === id) setLines((prev) => (prev.length >= max ? [...prev.slice(prev.length - max + 1), l] : [...prev, l])) })
    const offEnd = onStreamEnd((e) => { if (e.id === id) setEnded(e.code) })
    return () => { offLine(); offEnd() }
  }, [id, max])
  return { lines, ended, clear: useCallback(() => setLines([]), []) }
}

/** Carrega e repete a cada `ms` (0 = só uma vez); pedidos repetidos são "quiet" (não aparecem no Terminal). */
export function usePoll<T>(fn: (quiet: boolean) => Promise<T>, ms: number, deps: unknown[] = []): { data: T | null; error: string | null; refresh: () => Promise<void>; loading: boolean } {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const busy = useRef(false)
  const load = useCallback(async (quiet: boolean) => {
    if (busy.current) return
    busy.current = true
    if (!quiet) setLoading(true)
    try { setData(await fn(quiet)); setError(null) } catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { busy.current = false; setLoading(false) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
  useEffect(() => {
    void load(false)
    if (!ms) return
    const t = setInterval(() => { if (document.visibilityState === 'visible') void load(true) }, ms)
    return () => clearInterval(t)
  }, [load, ms])
  return { data, error, refresh: () => load(false), loading }
}

export function fmtBytes(n: number): string {
  if (!n) return '0 B'
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++ }
  return `${n < 10 ? n.toFixed(1) : Math.round(n)} ${u[i]}`
}

export function fmtAgo(epochSec: number): string {
  if (!epochSec) return ''
  const s = Math.max(0, Date.now() / 1000 - epochSec)
  if (s < 60) return 'agora'
  if (s < 3600) return `há ${Math.round(s / 60)} min`
  if (s < 86400) return `há ${Math.round(s / 3600)} h`
  if (s < 86400 * 30) return `há ${Math.round(s / 86400)} d`
  return `há ${Math.round(s / (86400 * 30))} meses`
}
