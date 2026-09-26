import { useCallback, useEffect, useMemo, useState } from 'react'
import type { DepsInfo, MavenDep, ProcState, ServiceInfo } from '../../../shared/types'
import { api } from '../api'
import type { LogsApi } from '../hooks'
import { Badge, isActive } from './common'

function tag(d: MavenDep): { text: string; tone: 'green' | 'purple' | 'blue' | 'amber' | 'muted' } | null {
  const a = d.artifactId
  if (a.startsWith('spring-boot-starter') || d.groupId.startsWith('org.springframework.boot')) return { text: 'Spring Boot', tone: 'green' }
  if (d.groupId === 'org.keycloak' || a.includes('oauth2')) return { text: 'Keycloak / OAuth2', tone: 'purple' }
  if (a.startsWith('springdoc') || a.startsWith('springfox')) return { text: 'Swagger', tone: 'blue' }
  if (/jpa|jdbc|postgres|mysql|mariadb|ojdbc|h2$|hsqldb|flyway|liquibase|mongodb|redis|r2dbc|hibernate/.test(a)) return { text: 'Base de dados / cache', tone: 'amber' }
  if (d.scope === 'test') return { text: 'teste', tone: 'muted' }
  return null
}

export function DepsView({ svc, logs, states, fail }: { svc: ServiceInfo; logs: LogsApi; states: Record<string, ProcState>; fail: (e: unknown) => void }) {
  const [info, setInfo] = useState<DepsInfo | null>(null)
  const [filter, setFilter] = useState('')
  const [view, setView] = useState<'declared' | 'tree'>('declared')
  const [treeFilter, setTreeFilter] = useState('')
  const procId = `deps:${svc.id}`
  const treeState = states[procId]
  const treeRunning = isActive(treeState)

  const load = useCallback(async () => {
    try {
      setInfo(await api.deps(svc.id))
    } catch (e) {
      fail(e)
    }
  }, [svc.id, fail])

  useEffect(() => {
    void load()
    void logs.load(procId)
  }, [load, logs, procId])

  const rows = useMemo(() => {
    if (!info) return []
    const f = filter.trim().toLowerCase()
    return info.modules.flatMap((m) => m.deps.filter((d) => !f || `${d.groupId}:${d.artifactId} ${d.version ?? ''} ${d.scope}`.toLowerCase().includes(f)).map((d) => ({ m: m.module, d })))
  }, [info, filter])

  const treeLines = useMemo(() => {
    const lines = logs.get(procId).filter((l) => l.stream === 'stdout').map((l) => l.text.replace(/^\[INFO\] ?/, ''))
    const f = treeFilter.trim().toLowerCase()
    return f ? lines.filter((l) => l.toLowerCase().includes(f)) : lines
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [logs.version, procId, treeFilter])

  const resolveTree = async (): Promise<void> => {
    try {
      await logs.clear(procId)
      await api.depsTree(svc.id)
      setView('tree')
    } catch (e) {
      fail(e)
    }
  }

  if (!info) return <div className="empty">A ler pom.xml…</div>
  const multi = info.modules.length > 1

  return (
    <div className="config">
      <section>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <span>{info.total} dependências declaradas{multi ? ` em ${info.modules.length} módulos` : ''}</span>
          {info.parent && <Badge tone="green" title="parent do pom">{info.parent.artifactId} {info.parent.version ?? ''}</Badge>}
          {info.springBootVersion && !info.parent?.artifactId.startsWith('spring-boot') && <Badge tone="green">Spring Boot {info.springBootVersion}</Badge>}
          <span className="grow" />
          <div className="tabs inline">
            <button className={view === 'declared' ? 'active' : ''} onClick={() => setView('declared')}>Declaradas (pom.xml)</button>
            <button className={view === 'tree' ? 'active' : ''} onClick={() => setView('tree')}>Árvore resolvida{treeLines.length ? ` (${treeLines.length})` : ''}</button>
          </div>
          <button className="btn btn-sm" disabled={treeRunning} onClick={resolveTree} title="mvn dependency:tree — inclui as dependências transitivas e as versões efetivas">
            {treeRunning ? 'A resolver…' : '⟳ Resolver com Maven'}
          </button>
        </div>
      </section>

      {view === 'declared' && (
        <section>
          <div className="row">
            <input className="input grow" placeholder="filtrar (artifact, grupo, versão, scope)…" value={filter} onChange={(e) => setFilter(e.target.value)} />
          </div>
          <table className="grid">
            <thead><tr>{multi && <th>Módulo</th>}<th>Dependência</th><th>Versão</th><th>Scope</th><th></th></tr></thead>
            <tbody>
              {rows.map(({ m, d }, i) => {
                const t = tag(d)
                return (
                  <tr key={`${m}:${d.groupId}:${d.artifactId}:${i}`}>
                    {multi && <td className="mono small muted">{m}</td>}
                    <td className="mono small"><span className="muted">{d.groupId}:</span>{d.artifactId}{d.optional && <span className="muted"> (optional)</span>}</td>
                    <td className="mono small">{d.version ?? <span className="muted" title="a versão vem do parent/BOM (dependencyManagement); vê a árvore resolvida">gerida</span>}{d.version && d.managed ? <span className="muted" title="versão do dependencyManagement do projeto"> ·</span> : null}</td>
                    <td className="small">{d.scope}</td>
                    <td>{t && <Badge tone={t.tone}>{t.text}</Badge>}</td>
                  </tr>
                )
              })}
              {!rows.length && <tr><td colSpan={5} className="muted">{filter ? 'Nada corresponde ao filtro.' : 'Sem dependências.'}</td></tr>}
            </tbody>
          </table>
          <p className="muted small">"gerida" = versão definida pelo parent (ex.: <span className="mono">spring-boot-starter-parent</span>) — a versão efetiva aparece na árvore resolvida.</p>
        </section>
      )}

      {view === 'tree' && (
        <section>
          <div className="row">
            <input className="input grow" placeholder="filtrar linhas da árvore…" value={treeFilter} onChange={(e) => setTreeFilter(e.target.value)} />
            <span className="muted small">{treeRunning ? 'a correr mvn dependency:tree…' : treeState ? `terminou (exit ${treeState.exitCode ?? '?'})` : 'ainda não resolvida'}</span>
          </div>
          <pre className="resp-body" style={{ maxHeight: '60vh' }}>{treeLines.length ? treeLines.join('\n') : treeRunning ? 'a aguardar output do Maven…' : 'Carrega em "Resolver com Maven" para obter a árvore completa (transitivas e versões efetivas).'}</pre>
        </section>
      )}
    </div>
  )
}
