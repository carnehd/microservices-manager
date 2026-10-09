import { useEffect, useState, type ReactNode } from 'react'
import { CONTAINER_MODES, DEBUG_MODES, type ProcState, type ProcStatus, type ServiceKind } from '../../../shared/types'

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

export type ContainerState = 'running' | 'stopped' | 'missing' | 'unknown'
const CONTAINER_LABEL: Record<ContainerState, string> = { running: 'running', stopped: 'stopped', missing: 'not created', unknown: 'unknown' }

/**
 * Cabeçalho comum das páginas Keycloak / Redis / Pub/Sub: título (com ícone de refresh), por baixo o container usado
 * e a imagem; à direita o estado e o porto em tags, seguidos de ações opcionais (children).
 */
export function ContainerHeader({ title, onRefresh, refreshTitle, container, image, state, stateLabel, port, error, children }: {
  title: string; onRefresh: () => void | Promise<unknown>; refreshTitle: string
  container: string; image?: string
  state: ContainerState; stateLabel?: string; port?: number
  error?: string; children?: ReactNode
}) {
  const tone = state === 'running' ? 'green' : state === 'stopped' ? 'amber' : 'muted'
  return (
    <div className="svc-header">
      <div className="grow">
        <h2><RefreshIcon onRefresh={onRefresh} title={refreshTitle} />{title}</h2>
        <div className="ctr-line muted small">
          container <span className="mono ctr-name">{container}</span>
          {image && <><span className="ctr-sep">·</span><span className="mono" title="image">{image}</span></>}
          {error && <span className="text-error"> · {error}</span>}
        </div>
      </div>
      <div className="ctr-tags">
        {/* estado e porto na mesma tag: "● running · :8080" */}
        <span className={`tag tag-${tone}`} title="container state · port on the host">
          <StatusDot status={state === 'running' ? 'running' : 'stopped'} />{stateLabel ?? CONTAINER_LABEL[state]}
          {port ? <span className="tag-port mono">· :{port}</span> : null}
        </span>
        {children}
      </div>
    </div>
  )
}

export function StatusPill({ state, port }: { state?: ProcState; port?: number }) {
  const now = useNow()
  const st = state?.status ?? 'stopped'
  const active = isActive(state)
  const p = state?.detectedPort ?? port
  const title = active ? [state?.pid ? `pid ${state.pid}` : '', state?.startedAt ? `${fmtDuration(now - state.startedAt)} ago` : '', state?.mode && DEBUG_MODES.has(state.mode) ? 'debug mode' : '', state?.mode && CONTAINER_MODES.has(state.mode) ? 'in a container' : ''].filter(Boolean).join(' · ') : undefined
  return (
    <span className={`pill pill-${st}`} title={title}>
      <StatusDot status={st} />
      {STATUS_LABEL[st]}
      {active && p ? ` · port ${p}` : ''}
      {active && state?.mode && CONTAINER_MODES.has(state.mode) ? ' · container' : ''}
      {active && state?.mode && DEBUG_MODES.has(state.mode) && state.debugPort ? ` · debug ${state.debugPort}` : ''}
      {st === 'crashed' ? ` (exit ${state?.exitCode ?? '?'})` : ''}
    </span>
  )
}
