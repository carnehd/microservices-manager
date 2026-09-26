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
  return (
    <aside className="sidebar">
      {GROUPS.map(({ kind, title }) => {
        const items = scan?.services.filter((s) => s.kind === kind) ?? []
        if (!items.length) return null
        return (
          <section key={kind}>
            <h3>{title} <span className="muted">{items.length}</span></h3>
            {items.map((s) => <Row key={s.id} svc={s} state={states[s.id]} git={gitSummary[s.id]} selected={s.id === selectedId} onClick={() => onSelect(s.id)} />)}
          </section>
        )
      })}
      {scan && !scan.services.length && <div className="muted pad small">Nada encontrado.</div>}
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
