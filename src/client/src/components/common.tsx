import { useEffect, useState, type ReactNode } from 'react'
import type { ProcState, ProcStatus, ServiceKind } from '../../../shared/types'

export const STATUS_LABEL: Record<ProcStatus, string> = {
  stopped: 'stopped',
  starting: 'starting',
  running: 'running',
  stopping: 'stopping',
  crashed: 'crashed'
}

export const KIND_LABEL: Record<ServiceKind, string> = {
  'spring-boot': 'Spring Boot',
  'keycloak-spi': 'Keycloak SPI',
  'maven-lib': 'Maven'
}

export function isActive(st?: ProcState): boolean {
  return !!st && (st.status === 'starting' || st.status === 'running' || st.status === 'stopping')
}

export function StatusDot({ status }: { status?: ProcStatus }) {
  const s = status ?? 'stopped'
  return <span className={`dot dot-${s}`} title={STATUS_LABEL[s]} />
}

export type NavState = 'running' | 'error' | 'none'
const NAV_LABEL: Record<NavState, string> = { running: 'a correr', error: 'com erro', none: 'parado' }
/** Bolinha de estado para a navegação: verde = a correr, vermelho = erro, sem cor = nada a correr. */
export function NavDot({ state }: { state: NavState }) {
  return <span className={`dot navdot navdot-${state}`} title={NAV_LABEL[state]} />
}

export function Badge({
  children, tone = 'muted', title
}: { children: ReactNode; tone?: 'muted' | 'blue' | 'green' | 'amber' | 'red' | 'purple'; title?: string }) {
  return <span className={`badge badge-${tone}`} title={title}>{children}</span>
}

export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(t)
  }, [intervalMs])
  return now
}

export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  return h ? `${h}h ${m}m` : m ? `${m}m ${sec}s` : `${sec}s`
}

/** Ícone ⟳ à esquerda do título da página: re-corre os comandos de entrar na página (ignora a cache). Roda enquanto decorre. */
export function RefreshIcon({ onRefresh, title = 'Refresh — re-run the commands of this page' }: { onRefresh: () => Promise<unknown> | void; title?: string }) {
  const [spinning, setSpinning] = useState(false)
  const click = async (): Promise<void> => {
    if (spinning) return
    setSpinning(true)
    try {
      await onRefresh()
    } finally {
      setSpinning(false)
    }
  }
  return <button type="button" className={`refresh-icon${spinning ? ' spinning' : ''}`} title={title} aria-label="Refresh" onClick={() => void click()}>⟳</button>
}

/** Consola (pre) que colore as linhas de comando ($ …) a verde, erros (✗) a vermelho e cabeçalhos (--- …) a cinzento. */
export function ConsoleOut({ text, placeholder, className = '', style }: { text: string; placeholder?: string; className?: string; style?: React.CSSProperties }) {
  if (!text) return <pre className={`resp-body console-out ${className}`} style={style}>{placeholder ?? ''}</pre>
  return (
    <pre className={`resp-body console-out ${className}`} style={style}>
      {text.split('\n').map((line, i) => {
        const cls = line.startsWith('$ ') ? 'con-cmd' : line.startsWith('✗') ? 'con-err' : line.startsWith('--- ') || line.startsWith('→ ') ? 'con-head' : undefined
        return <span key={i} className={cls}>{line}{'\n'}</span>
      })}
    </pre>
  )
}

export function StatusPill({ state, port }: { state?: ProcState; port?: number }) {
  const now = useNow()
  const st = state?.status ?? 'stopped'
  const active = isActive(state)
  const p = state?.detectedPort ?? port
  const title = active ? [state?.pid ? `pid ${state.pid}` : '', state?.startedAt ? `${fmtDuration(now - state.startedAt)} ago` : '', state?.mode === 'debug' ? 'debug mode' : ''].filter(Boolean).join(' · ') : undefined
  return (
    <span className={`pill pill-${st}`} title={title}>
      <StatusDot status={st} />
      {STATUS_LABEL[st]}
      {active && p ? ` · port ${p}` : ''}
      {active && state?.mode === 'debug' && state.debugPort ? ` · debug ${state.debugPort}` : ''}
      {st === 'crashed' ? ` (exit ${state?.exitCode ?? '?'})` : ''}
    </span>
  )
}
