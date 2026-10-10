import { useEffect, useRef, useState } from 'react'
import type { CmdLogEntry } from '../../../shared/types'
import { api, onCmdLog } from '../api'

/** Terminal comum (em baixo): todos os comandos corridos pela app, a verde, com resultado. */
export function Terminal() {
  const [entries, setEntries] = useState<CmdLogEntry[]>([])
  const [open, setOpen] = useState(() => { try { return localStorage.getItem('cm.term.open') === '1' } catch { return false } })
  const bodyRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    void api.consoleLog().then(setEntries).catch(() => {})
    return onCmdLog((e) => setEntries((prev) => [...prev.slice(-499), e]))
  }, [])
  useEffect(() => { if (open && bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight }, [entries, open])
  const toggle = (): void => { setOpen((v) => { try { localStorage.setItem('cm.term.open', v ? '0' : '1') } catch { /* sem storage */ } return !v }) }
  const last = entries.length ? entries[entries.length - 1] : null
  const cmds = entries.filter((e) => e.kind === 'cmd').length
  return (
    <div className={`terminal${open ? ' open' : ''}`}>
      <div className="terminal-bar" onClick={toggle}>
        <span className="muted">{open ? '▾' : '▸'}</span><b>Terminal</b><span className="muted small">{cmds} comando(s)</span>
        {!open && last && <span className={`term-${last.kind} ellipsis`}>{last.kind === 'cmd' ? '$ ' : last.kind === 'ok' ? '↳ ' : '✗ '}{last.text}</span>}
        <span className="grow" />
        <button className="link small" onClick={(e) => { e.stopPropagation(); setEntries([]) }}>clear</button>
      </div>
      {open && (
        <div className="terminal-body" ref={bodyRef}>
          {entries.map((e, i) => <div key={i} className={`term-${e.kind}`}>{e.kind === 'cmd' ? '$ ' : e.kind === 'ok' ? '↳ ' : '✗ '}{e.text}</div>)}
          {!entries.length && <div className="muted">(nenhum comando ainda)</div>}
        </div>
      )}
    </div>
  )
}
