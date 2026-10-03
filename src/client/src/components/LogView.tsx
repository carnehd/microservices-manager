import { useEffect, useMemo, useRef, useState } from 'react'
import type { LogLine } from '../../../shared/types'

const RENDER_MAX = 2500
type Level = 'error' | 'warn' | 'info' | 'debug' | 'system'
const LEVELS: Array<{ key: Level; label: string }> = [
  { key: 'error', label: 'ERROR' },
  { key: 'warn', label: 'WARN' },
  { key: 'info', label: 'INFO' },
  { key: 'debug', label: 'DEBUG' },
  { key: 'system', label: 'system' }
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

/** Formata/indenta JSON numa linha de log (linha só-JSON ou prefixo + objeto JSON). */
/** Formata/indenta o JSON de uma linha. Devolve null quando a linha NÃO tem JSON (fica como está). */
function tryFormatJson(text: string): string | null {
  const s = text.trim()
  if (/^[[{]/.test(s)) {
    try {
      return JSON.stringify(JSON.parse(s), null, 2)
    } catch {
      /* não é JSON */
    }
  }
  const i = text.indexOf('{')
  if (i >= 0) {
    try {
      return text.slice(0, i) + JSON.stringify(JSON.parse(text.slice(i)), null, 2)
    } catch {
      /* o resto da linha não é JSON */
    }
  }
  return null
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
  const [json, setJson] = useState(false)
  const [picked, setPicked] = useState<Set<Level>>(new Set())
  const box = useRef<HTMLDivElement>(null)

  // Filtro por inclusão: clicar liga aquele nível (mostra só os ligados); clicar de novo desliga.
  // Sem nenhum ligado = mostra tudo.
  const toggleLevel = (k: Level): void =>
    setPicked((prev) => {
      const next = new Set(prev)
      if (next.has(k)) next.delete(k)
      else next.add(k)
      return next
    })

  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase()
    const arr = lines.filter((l) => {
      if (picked.size && !picked.has(level(l))) return false
      return !f || l.text.toLowerCase().includes(f)
    })
    return arr.length > RENDER_MAX ? arr.slice(arr.length - RENDER_MAX) : arr
    // `version` força recomputar: o array é mutado in-place pelo useLogs
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lines, filter, version, picked])

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
        <input className="input" placeholder="filter…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <span className="log-levels">
          {LEVELS.map((lv) => (
            <button key={lv.key} className={`chip chip-${lv.key}${picked.has(lv.key) ? ' active' : picked.size ? ' off' : ''}`} onClick={() => toggleLevel(lv.key)} title={picked.has(lv.key) ? `stop showing only ${lv.label}` : `show only ${lv.label}`}>
              {lv.label}
            </button>
          ))}
        </span>
        <span className="grow" />
        <label className="check"><input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> follow</label>
        <label className="check"><input type="checkbox" checked={wrap} onChange={(e) => setWrap(e.target.checked)} /> wrap</label>
        <label className="check"><input type="checkbox" checked={json} onChange={(e) => setJson(e.target.checked)} /> JSON</label>
        <button className="btn btn-sm" onClick={onClear}>Clear</button>
      </div>
      <div ref={box} className={`log-box${wrap ? ' wrap' : ''}`} onScroll={onScroll}>
        {shown.map((l, i) => {
          const fmt = json ? tryFormatJson(l.text) : null
          return <div key={i} className={`log-line ${classify(l, level(l))}${fmt !== null ? ' log-json' : ''}`}>{(fmt ?? l.text) || ' '}</div>
        })}
        {shown.length === 0 && <div className="muted pad">{lines.length ? 'No line matches the filter.' : 'No output.'}</div>}
      </div>
    </div>
  )
}
