import { useMemo, useState } from 'react'
import type { GitSummary, ProcState, ScanResult, ServiceInfo, ServiceKind } from '../../../shared/types'
import { StatusDot } from './common'

const GROUPS: Array<{ kind: ServiceKind; title: string }> = [
  { kind: 'spring-boot', title: 'Microserviços' },
  { kind: 'keycloak-spi', title: 'Keycloak SPIs' },
  { kind: 'maven-lib', title: 'Outros projetos Maven' }
]

export function Sidebar({
  scan, states, gitSummary, selectedId, onSelect
}: { scan: ScanResult | null; states: Record<string, ProcState>; gitSummary: GitSummary; selectedId: string | null; onSelect: (id: string) => void }) {
  const [query, setQuery] = useState('')
  const [asc, setAsc] = useState(true)

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    const list = (scan?.services ?? []).filter((s) => !q || `${s.name} ${s.relativePath}`.toLowerCase().includes(q))
    return [...list].sort((a, b) => (asc ? 1 : -1) * a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
  }, [scan, query, asc])

  return (
    <aside className="sidebar">
      <div className="sidebar-toolbar">
        <input className="input" placeholder="procurar serviço…" value={query} onChange={(e) => setQuery(e.target.value)} />
        <button className="btn btn-sm" onClick={() => setAsc((v) => !v)} title={`ordenar por nome (${asc ? 'A→Z' : 'Z→A'})`}>{asc ? 'A→Z' : 'Z→A'}</button>
      </div>
      {GROUPS.map(({ kind, title }) => {
        const items = filtered.filter((s) => s.kind === kind)
        if (!items.length) return null
        return (
          <section key={kind}>
            <h3>{title} <span className="muted">{items.length}</span></h3>
            {items.map((s) => <Row key={s.id} svc={s} state={states[s.id]} git={gitSummary[s.id]} selected={s.id === selectedId} onClick={() => onSelect(s.id)} />)}
          </section>
        )
      })}
      {scan && !scan.services.length && <div className="muted pad small">Nada encontrado.</div>}
      {scan && scan.services.length > 0 && !filtered.length && <div className="muted pad small">Nenhum serviço corresponde a "{query}".</div>}
    </aside>
  )
}

function Row({ svc, state, git, selected, onClick }: { svc: ServiceInfo; state?: ProcState; git?: GitSummary[string]; selected: boolean; onClick: () => void }) {
  const n = git?.changes ?? 0
  return (
    <button className={`svc-row${selected ? ' selected' : ''}`} onClick={onClick} title={svc.relativePath}>
      <StatusDot status={state?.status} />
      <span className="svc-text">
        <span className="svc-name ellipsis">{svc.name}</span>
        {git && (
          <span className="svc-sub ellipsis">
            <span className="svc-branch" title={`branch atual: ${git.branch ?? '?'}`}>⎇ {git.branch ?? '?'}</span>
            {n > 0 ? <span className="svc-changes" title={`${n} alteração(ões) por commitar`}> · {n} {n === 1 ? 'alteração' : 'alterações'}</span> : <span className="svc-clean"> · sem alterações</span>}
          </span>
        )}
      </span>
    </button>
  )
}
