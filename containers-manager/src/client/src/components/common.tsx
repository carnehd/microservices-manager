import type { ReactNode } from 'react'
import type { ExecResult } from '../../../shared/types'

export type Notify = (text: string, kind?: 'error' | 'info' | 'success') => void

export function Dot({ state }: { state: string }) {
  const cls = state === 'running' ? 'dot dot-running' : state === 'paused' ? 'dot dot-paused' : /exited|dead/.test(state) ? 'dot dot-stopped' : 'dot'
  return <span className={cls} title={state} />
}

export function Pill({ tone = 'muted', children, title }: { tone?: 'muted' | 'green' | 'amber' | 'red' | 'blue'; children: ReactNode; title?: string }) {
  return <span className={`pill pill-${tone}`} title={title}>{children}</span>
}

/** Ícone ⟳ verde à esquerda do título: volta a correr os comandos de entrar na página. */
export function RefreshIcon({ onRefresh, spinning, title }: { onRefresh: () => void; spinning?: boolean; title?: string }) {
  return <button type="button" className={`refresh-icon${spinning ? ' spinning' : ''}`} onClick={onRefresh} title={title ?? 'Refresh'} aria-label="Refresh">⟳</button>
}

export function PageHeader({ title, count, onRefresh, loading, children }: { title: string; count?: ReactNode; onRefresh: () => void; loading?: boolean; children?: ReactNode }) {
  return (
    <div className="page-head">
      <RefreshIcon onRefresh={onRefresh} spinning={loading} />
      <h1>{title}</h1>
      {count !== undefined && <Pill>{count}</Pill>}
      <span className="grow" />
      {children}
    </div>
  )
}

/** Saída de consola: "$ …" a verde, "✗" a vermelho. */
export function ConsoleOut({ text, placeholder, className = '', style }: { text: string; placeholder?: string; className?: string; style?: React.CSSProperties }) {
  return (
    <pre className={`console-out ${className}`} style={style}>
      {text ? text.split('\n').map((line, i) => {
        const cls = line.startsWith('$ ') ? 'con-cmd' : line.startsWith('✗') ? 'con-err' : line.startsWith('→ ') || line.startsWith('▶') || line.startsWith('■') ? 'con-head' : undefined
        return <span key={i} className={cls}>{line}{'\n'}</span>
      }) : <span className="muted">{placeholder ?? ''}</span>}
    </pre>
  )
}

/** Texto para a consola a partir de um ExecResult. */
export function execText(r: ExecResult): string {
  const out = [r.stdout.trimEnd(), r.stderr.trimEnd()].filter(Boolean).join('\n')
  return `${out || '(no output)'}${r.code ? `\n✗ exit ${r.code}` : ''} — ${r.ms} ms`
}

export function Modal({ title, onClose, children, width = 560 }: { title: string; onClose: () => void; children: ReactNode; width?: number }) {
  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal" style={{ width }} onClick={(e) => e.stopPropagation()} role="dialog" aria-label={title}>
        <div className="modal-head"><h3>{title}</h3><button className="btn btn-sm btn-ghost" onClick={onClose} aria-label="close">✕</button></div>
        {children}
      </div>
    </div>
  )
}

export const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))
