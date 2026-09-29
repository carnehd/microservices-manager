import { useEffect, useMemo, useRef, useState } from 'react'
import type { LogLine } from '../../../shared/types'

const RENDER_MAX = 2500
type Level = 'error' | 'warn' | 'info' | 'debug' | 'system'
const LEVELS: Array<{ key: Level; label: string }> = [
  { key: 'error', label: 'ERROR' },
  { key: 'warn', label: 'WARN' },
  { key: 'info', label: 'INFO' },
  { key: 'debug', label: 'DEBUG' },
  { key: 'system', label: 'sistema' }
]

/** Nível de uma linha (para filtrar e colorir). */
function level(l: LogLine): Level {
  if (l.stream === 'system') return 'system'
  const t = l.text
  if (/\bERROR\b|Exception|Caused by:|BUILD FAILURE/.test(t)) return 'error'
  if (/\bWARN(?:ING)?\b/.test(t)) return 'warn'
  if (/\bDEBUG\b|\bTRACE\b/.test(t)) return 'debug'
  return 'info'
}

function classify(l: LogLine, lvl: Level): string {
  if (lvl === 'system') return 'log-system'
  if (lvl === 'error') return 'log-error'
  if (lvl === 'warn') return 'log-warn'
  if (lvl === 'debug') return 'log-debug'
  if (/BUILD SUCCESS|Started \S+ in [\d.]+ seconds|Listening on:/.test(l.text)) return 'log-success'
  return l.stream === 'stderr' ? 'log-stderr' : ''
}

export function LogView({ lines, version, onClear }: { lines: LogLine[]; version: number; onClear: () => void }) {
  const [filter, setFilter] = useState('')
  const [follow, setFollow] = useState(true)
  const [wrap, setWrap] = useState(false)
  const [hidden, setHidden] = useState<Set<Level>>(new Set())
  const box = useRef<HTMLDivElement>(null)

  const toggleLevel = (k: Level): void =>
    setHidden((prev) => {
      const next = new Set(prev)
      if (next.has(k)) next.delete(k)
      else next.add(k)
      return next
    })

  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase()
    const arr = lines.filter((l) => {
      if (hidden.size && hidden.has(level(l))) return false
      return !f || l.text.toLowerCase().includes(f)
    })
    return arr.length > RENDER_MAX ? arr.slice(arr.length - RENDER_MAX) : arr
    // `version` força recomputar: o array é mutado in-place pelo useLogs
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lines, filter, version, hidden])

  useEffect(() => {
    if (follow && box.current) box.current.scrollTop = box.current.scrollHeight
  }, [shown, follow])

  const onScroll = (): void => {
    const el = box.current
    if (!el) return
    setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 24)
  }

  return (
    <div className="logview">
      <div className="toolbar">
        <input className="input" placeholder="filtrar…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <span className="log-levels">
          {LEVELS.map((lv) => (
            <button key={lv.key} className={`chip chip-${lv.key}${hidden.has(lv.key) ? ' off' : ''}`} onClick={() => toggleLevel(lv.key)} title={hidden.has(lv.key) ? `mostrar ${lv.label}` : `esconder ${lv.label}`}>
              {lv.label}
            </button>
          ))}
        </span>
        <label className="check"><input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> seguir</label>
        <label className="check"><input type="checkbox" checked={wrap} onChange={(e) => setWrap(e.target.checked)} /> quebrar</label>
        <span className="muted small">{shown.length}{shown.length < lines.length ? ` / ${lines.length}` : ''} linhas</span>
        <span className="grow" />
        <button className="btn btn-sm" onClick={onClear}>Limpar</button>
      </div>
      <div ref={box} className={`log-box${wrap ? ' wrap' : ''}`} onScroll={onScroll}>
        {shown.map((l, i) => (
          <div key={i} className={`log-line ${classify(l, level(l))}`}>{l.text || ' '}</div>
        ))}
        {shown.length === 0 && <div className="muted pad">{lines.length ? 'Nenhuma linha corresponde ao filtro.' : 'Sem output.'}</div>}
      </div>
    </div>
  )
}
