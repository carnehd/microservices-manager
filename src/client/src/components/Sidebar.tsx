import { useMemo, useState } from 'react'
import type { GitSummary, ProcState, ScanResult, ServiceInfo, ServiceKind } from '../../../shared/types'
import { icons } from '../assets/icons'
import { StatusDot } from './common'

const GROUPS: Array<{ kind: ServiceKind; title: string; short: string }> = [
  { kind: 'spring-boot', title: 'Microservices', short: 'microservices' },
  { kind: 'keycloak-spi', title: 'Keycloak SPIs', short: 'SPIs' },
  { kind: 'maven-lib', title: 'Other Maven projects', short: 'projects' }
]
// Grupos longos mostram só os primeiros N com "View all" (maquete), exceto quando há pesquisa.
const COLLAPSED_ROWS = 5

export function Sidebar({
  scan, states, gitSummary, kcProviders, favorites, selectedId, onSelect, onToggleFavorite
}: {
  scan: ScanResult | null; states: Record<string, ProcState>; gitSummary: GitSummary; kcProviders: Set<string>
  favorites: Set<string>; selectedId: string | null; onSelect: (id: string) => void; onToggleFavorite: (id: string) => void
}) {
  const [query, setQuery] = useState('')
  const [asc, setAsc] = useState(true)
  const [expanded, setExpanded] = useState<Set<ServiceKind>>(new Set())

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
      <div className="sb-search">
        <img src={icons.search} alt="" width={15} height={15} />
        <input placeholder="Find a service…" value={query} onChange={(e) => setQuery(e.target.value)} />
        <button type="button" className="sb-sort" onClick={() => setAsc((v) => !v)} title={`sort by name (${asc ? 'A→Z' : 'Z→A'})`} aria-label={`sort by name (${asc ? 'A→Z' : 'Z→A'})`}>
          <img src={icons.sortAz} alt="" width={16} height={16} style={{ transform: asc ? undefined : 'scaleY(-1)' }} />
        </button>
      </div>
      {favItems.length > 0 && (
        <section>
          <div className="sb-group"><span>Favorites</span><span className="sb-count">{favItems.length}</span></div>
          {favItems.map(row)}
        </section>
      )}
      {GROUPS.map(({ kind, title, short }) => {
        const items = filtered.filter((s) => s.kind === kind && !favorites.has(s.id))
        if (!items.length) return null
        const collapsed = !query && !expanded.has(kind) && items.length > COLLAPSED_ROWS
        const shown = collapsed ? items.slice(0, COLLAPSED_ROWS) : items
        return (
          <section key={kind}>
            <div className="sb-group"><span>{title}</span><span className="sb-count">{items.length}</span></div>
            {shown.map(row)}
            {collapsed && (
              <button type="button" className="sb-more" onClick={() => setExpanded((e) => new Set(e).add(kind))}>View all {items.length} {short}</button>
            )}
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
      <button className="svc-main" onClick={onClick} title={svc.relativePath}>
        <StatusDot status={state?.status} />
        <span className="svc-text">
          <span className="svc-name ellipsis">{svc.name}</span>
          {git && (
            <span className="svc-sub ellipsis">
              <img src={icons.gitBranch11} alt="" width={11} height={11} />
              <span className="svc-branch" title={`current branch: ${git.branch ?? '?'}`}>{git.branch ?? '?'}</span>
              {n > 0 ? <span className="svc-changes" title={`${n} change${n === 1 ? '' : 's'} to commit`}>· {n} {n === 1 ? 'change' : 'changes'}</span> : <span className="svc-clean">· no changes</span>}
            </span>
          )}
        </span>
      </button>
      {spiLoaded && <span className="svc-kc" title="loaded in Keycloak">KC</span>}
      <span
        className={`svc-star${favorite ? ' on' : ''}`}
        role="button"
        tabIndex={0}
        title={favorite ? 'Remove from favorites' : 'Add to favorites'}
        aria-label={favorite ? 'Remove from favorites' : 'Add to favorites'}
        aria-pressed={favorite}
        onClick={(e) => { e.stopPropagation(); onToggleFavorite() }}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); onToggleFavorite() } }}
      >
        <img src={favorite && selected ? icons.starSelected : icons.starFavorite} alt="" width={13} height={13} />
      </span>
    </div>
  )
}
