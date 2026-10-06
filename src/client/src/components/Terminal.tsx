import { useEffect, useRef, useState } from 'react'
import type { CmdLogEntry } from '../../../shared/types'
import { api } from '../api'

// Formata uma entrada para a linha do terminal (prefixo por tipo).
function line(e: CmdLogEntry): string {
  if (e.kind === 'cmd') return `$ ${e.text}`
  if (e.kind === 'err') return `  ✗ ${e.text}`
  return `  ↳ ${e.text}`
}

/** Consola comum a todas as páginas: mostra, em tempo real, os comandos de container (podman/docker) que a app corre. */
export function Terminal() {
  const [entries, setEntries] = useState<CmdLogEntry[]>([])
  const [open, setOpen] = useState(false)
  const bodyRef = useRef<HTMLDivElement>(null)
  const stick = useRef(true) // manter encostado ao fundo (auto-scroll) enquanto o utilizador não sobe

  useEffect(() => {
    let alive = true
    void api.consoleLog().then((e) => { if (alive) setEntries(e.slice(-400)) }).catch(() => { /* sem histórico */ })
    const off = api.onCmdLog((e) => setEntries((prev) => [...prev, e].slice(-400)))
    return () => { alive = false; off() }
  }, [])

  useEffect(() => {
    const el = bodyRef.current
    if (open && el && stick.current) el.scrollTop = el.scrollHeight
  }, [entries, open])

  const onScroll = (): void => {
    const el = bodyRef.current
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
  }

  const last = entries[entries.length - 1]
  const cmdCount = entries.filter((e) => e.kind === 'cmd').length

  return (
    <div className={`terminal ${open ? 'open' : 'closed'}`}>
      <div className="terminal-bar" onClick={() => setOpen((o) => !o)} title={open ? 'collapse' : 'expand'}>
        <span className="terminal-chevron">{open ? '▾' : '▸'}</span>
        <span className="terminal-title">Terminal</span>
        <span className="muted small">{cmdCount} comando(s)</span>
        {!open && last && <span className="terminal-peek mono small">{line(last)}</span>}
        <span className="grow" />
        <button className="btn btn-sm btn-ghost" disabled={!entries.length} onClick={(e) => { e.stopPropagation(); setEntries([]) }}>clear</button>
      </div>
      {open && (
        <div className="terminal-body mono small" ref={bodyRef} onScroll={onScroll}>
          {entries.map((e) => <div key={e.seq} className={`term-${e.kind}`}>{line(e)}</div>)}
          {!entries.length && <div className="muted">(sem comandos ainda — qualquer operação que corra podman/docker aparece aqui)</div>}
        </div>
      )}
    </div>
  )
}
