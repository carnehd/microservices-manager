import { useMemo, useState } from 'react'
import type { GitSummary, ProcState, ScanResult, ServiceInfo, ServiceKind } from '../../../shared/types'
import { StatusDot } from './common'

const GROUPS: Array<{ kind: ServiceKind; title: string }> = [
  { kind: 'spring-boot', title: 'Microservices' },
  { kind: 'keycloak-spi', title: 'Keycloak SPIs' },
  { kind: 'maven-lib', title: 'Other Maven projects' }
]

export function Sidebar({
  scan, states, gitSummary, kcProviders, favorites, selectedId, onSelect, onToggleFavorite
}: {
  scan: ScanResult | null; states: Record<string, ProcState>; gitSummary: GitSummary; kcProviders: Set<string>
  favorites: Set<string>; selectedId: string | null; onSelect: (id: string) => void; onToggleFavorite: (id: string) => void
}) {
  const [query, setQuery] = useState('')
  const [asc, setAsc] = useState(true)

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    const list = (scan?.services ?? []).filter((s) => !q || `${s.name} ${s.relativePath}`.toLowerCase().includes(q))
    return [...list].sort((a, b) => (asc ? 1 : -1) * a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
  }, [scan, query, asc])

  const favItems = useMemo(() => filtered.filter((s) => favorites.has(s.id)), [filtered, favorites])

  const row = (s: ServiceInfo) => (
    <Row key={s.id} svc={s} state={states[s.id]} git={gitSummary[s.id]} kcProviders={kcProviders}
      favorite={favorites.has(s.id)} selected={s.id === selectedId} onClick={() => onSelect(s.id)} onToggleFavorite={() => onToggleFavorite(s.id)} />
  )

  return (
    <aside className="sidebar">
      <div className="sidebar-toolbar">
        <input className="input" placeholder="search service…" value={query} onChange={(e) => setQuery(e.target.value)} />
        <button className="btn btn-sm" onClick={() => setAsc((v) => !v)} title={`sort by name (${asc ? 'A→Z' : 'Z→A'})`}>{asc ? 'A→Z' : 'Z→A'}</button>
      </div>
      {favItems.length > 0 && (
        <section>
          <h3>★ Favorites <span className="muted">{favItems.length}</span></h3>
          {favItems.map(row)}
        </section>
      )}
      {GROUPS.map(({ kind, title }) => {
        const items = filtered.filter((s) => s.kind === kind && !favorites.has(s.id))
        if (!items.length) return null
        return (
          <section key={kind}>
            <h3>{title} <span className="muted">{items.length}</span></h3>
            {items.map(row)}
          </section>
        )
      })}
      {scan && !scan.services.length && <div className="muted pad small">Nothing found.</div>}
      {scan && scan.services.length > 0 && !filtered.length && <div className="muted pad small">No service matches "{query}".</div>}
    </aside>
  )
}

function Row({ svc, state, git, kcProviders, favorite, selected, onClick, onToggleFavorite }: {
  svc: ServiceInfo; state?: ProcState; git?: GitSummary[string]; kcProviders: Set<string>
  favorite: boolean; selected: boolean; onClick: () => void; onToggleFavorite: () => void
}) {
  const n = git?.changes ?? 0
  const spiLoaded = svc.kind === 'keycloak-spi' && (svc.providerIds?.length ?? 0) > 0 && svc.providerIds!.some((id) => kcProviders.has(id))
  return (
    <div className={`svc-row${selected ? ' selected' : ''}${favorite ? ' is-fav' : ''}`}>
      <span
        className={`svc-star${favorite ? ' on' : ''}`}
        role="button"
        tabIndex={0}
        title={favorite ? 'Remove from favorites' : 'Add to favorites'}
        aria-label={favorite ? 'Remove from favorites' : 'Add to favorites'}
        aria-pressed={favorite}
        onClick={(e) => { e.stopPropagation(); onToggleFavorite() }}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); onToggleFavorite() } }}
      >{favorite ? '★' : '☆'}</span>
      <button className="svc-main" onClick={onClick} title={svc.relativePath}>
        <StatusDot status={state?.status} />
        <span className="svc-text">
          <span className="svc-name ellipsis">{svc.name}{spiLoaded && <span className="svc-kc" title="loaded in Keycloak">KC</span>}</span>
          {git && (
            <span className="svc-sub ellipsis">
              <span className="svc-branch" title={`current branch: ${git.branch ?? '?'}`}>⎇ {git.branch ?? '?'}</span>
              {n > 0 ? <span className="svc-changes" title={`${n} change${n === 1 ? '' : 's'} to commit`}> · {n} {n === 1 ? 'change' : 'changes'}</span> : <span className="svc-clean"> · no changes</span>}
            </span>
          )}
        </span>
      </button>
    </div>
  )
}
