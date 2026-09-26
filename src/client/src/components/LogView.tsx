import { useEffect, useMemo, useRef, useState } from 'react'
import type { LogLine } from '../../../shared/types'

const RENDER_MAX = 2500

function classify(l: LogLine): string {
  if (l.stream === 'system') return 'log-system'
  const t = l.text
  if (/\bERROR\b|Exception|Caused by:|BUILD FAILURE/.test(t)) return 'log-error'
  if (/\bWARN(?:ING)?\b/.test(t)) return 'log-warn'
  if (/BUILD SUCCESS|Started \S+ in [\d.]+ seconds|Listening on:/.test(t)) return 'log-success'
  if (/\bDEBUG\b|\bTRACE\b/.test(t)) return 'log-debug'
  return l.stream === 'stderr' ? 'log-stderr' : ''
}

export function LogView({ lines, version, onClear }: { lines: LogLine[]; version: number; onClear: () => void }) {
  const [filter, setFilter] = useState('')
  const [follow, setFollow] = useState(true)
  const [wrap, setWrap] = useState(false)
  const box = useRef<HTMLDivElement>(null)

  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase()
    const arr = f ? lines.filter((l) => l.text.toLowerCase().includes(f)) : lines
    return arr.length > RENDER_MAX ? arr.slice(arr.length - RENDER_MAX) : arr
    // `version` força recomputar: o array é mutado in-place pelo useLogs
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lines, filter, version])

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
        <label className="check"><input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> seguir</label>
        <label className="check"><input type="checkbox" checked={wrap} onChange={(e) => setWrap(e.target.checked)} /> quebrar linhas</label>
        <span className="muted small">{shown.length}{shown.length < lines.length ? ` / ${lines.length}` : ''} linhas</span>
        <span className="grow" />
        <button className="btn btn-sm" onClick={onClear}>Limpar</button>
      </div>
      <div ref={box} className={`log-box${wrap ? ' wrap' : ''}`} onScroll={onScroll}>
        {shown.map((l, i) => (
          <div key={i} className={`log-line ${classify(l)}`}>{l.text || ' '}</div>
        ))}
        {shown.length === 0 && <div className="muted pad">Sem output.</div>}
      </div>
    </div>
  )
}
