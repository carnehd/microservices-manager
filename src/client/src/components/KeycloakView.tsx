import { useCallback, useEffect, useState } from 'react'
import type { AppSettings, JarInfo, KeycloakInfo, ProcState, ScanResult } from '../../../shared/types'
import { api, FRESH, POLL, type ReqOpts } from '../api'
import type { LogsApi } from '../hooks'
import { KcAdminPanel } from './KcAdminPanel'
import { LogView } from './LogView'
import { Badge, ContainerHeader, isActive } from './common'

type Tab = 'logs' | 'providers' | 'admin'
const KC_ID = 'keycloak'

export function KeycloakView({
  settings, scan, states, logs, onSaveSettings, notify, fail
}: {
  settings: AppSettings
  scan: ScanResult | null
  states: Record<string, ProcState>
  logs: LogsApi
  onSaveSettings: (patch: Partial<AppSettings>) => Promise<AppSettings | null>
  notify: (text: string, kind?: 'error' | 'info' | 'success') => void
  fail: (e: unknown) => void
}) {
  const [tab, setTab] = useState<Tab>('logs')
  const [info, setInfo] = useState<KeycloakInfo | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  // Links de teste definidos pelo utilizador (nome + URL), guardados no browser. Nada é hardcoded:
  // cada projeto/cópia define os seus (ex. páginas de login dos seus portais/clients).
  const [links, setLinks] = useState<Array<{ name: string; url: string }>>(() => {
    try { return JSON.parse(localStorage.getItem('msm.kcLinks') || '[]') } catch { return [] }
  })
  const [editLinks, setEditLinks] = useState(false)
  const saveLinks = (next: Array<{ name: string; url: string }>): void => {
    setLinks(next)
    try { localStorage.setItem('msm.kcLinks', JSON.stringify(next)) } catch { /* ignore */ }
  }
  const state = states[KC_ID]
  const kc = settings.keycloak
  // o estado é o do container (o processo "keycloak" da app é só o podman logs -f)
  const running = !!info?.container?.running
  const active = running || isActive(state)
  const adminUrl = `http://localhost:${kc.httpPort}/admin/`

  // Sem opções lê a cache do servidor (entrar na página é instantâneo); FRESH/POLL re-correm os comandos.
  const refreshInfo = useCallback((o?: ReqOpts) => api.kcInfo(o).then(setInfo).catch(fail), [fail])
  const loadLogs = logs.load
  useEffect(() => {
    void refreshInfo()
    void loadLogs(KC_ID)
  }, [kc.containerName, kc.image, refreshInfo, loadLogs])
  useEffect(() => {
    if (!active) void refreshInfo() // depois de build/deploy a lista de providers pode ter mudado
  }, [active, refreshInfo])
  useEffect(() => {
    let running = false // não acumular pedidos quando o motor está lento
    const t = setInterval(() => {
      if (running) return
      running = true
      void Promise.resolve(refreshInfo(POLL)).finally(() => { running = false })
    }, 5000)
    return () => clearInterval(t)
  }, [refreshInfo])

  const run = async (label: string, fn: () => Promise<unknown>, after?: () => void): Promise<void> => {
    setBusy(label)
    try {
      await fn()
      after?.()
    } catch (e) {
      fail(e)
    } finally {
      setBusy(null)
    }
  }

  const spis = scan?.services.filter((s) => s.kind === 'keycloak-spi') ?? []
  const [installMode, setInstallMode] = useState<'build' | 'existing'>('build')
  const [restartAfter, setRestartAfter] = useState(true)
  const [jars, setJars] = useState<Record<string, JarInfo>>({})
  const [chosenJar, setChosenJar] = useState<Record<string, string>>({})
  const [loadedIds, setLoadedIds] = useState<Set<string> | null>(null)

  const refreshJars = useCallback(async () => {
    const out: Record<string, JarInfo> = {}
    await Promise.all(spis.map(async (s) => { out[s.id] = await api.jarInfo(s.id).catch(() => ({ candidates: [], installed: [] })) }))
    setJars(out)
    // ids de providers efetivamente carregados no Keycloak (serverinfo); null se não der para consultar
    try {
      const provs = await api.kcAdmin.providers()
      setLoadedIds(new Set(provs.flatMap((p) => p.providers)))
    } catch {
      setLoadedIds(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scan])
  useEffect(() => {
    if (tab === 'providers') void refreshJars()
  }, [tab, refreshJars])

  const install = (id: string, name: string): Promise<void> => run(`deploy:${id}`, async () => {
    const r = await api.kcDeploySpi(id, { build: installMode === 'build', restart: restartAfter, jar: installMode === 'existing' ? chosenJar[id] : undefined })
    notify(`${r.dest.split(/[\\/]/).pop()} installed${r.removed.length ? ` (replaced ${r.removed.join(', ')})` : ''}${r.restarted ? '; Keycloak restarted' : ' — restart Keycloak to load it'}`, 'success')
  }, () => {
    void refreshInfo()
    void refreshJars()
  })

  const installAll = (): Promise<void> => run('deploy-all', async () => {
    for (const s of spis) await api.kcDeploySpi(s.id, { build: installMode === 'build', restart: false })
    if (restartAfter) await api.kcRestart()
  }, () => {
    void refreshInfo()
    void refreshJars()
    notify(`${spis.length} SPI(s) installed${restartAfter ? '; Keycloak restarted' : ''}`, 'success')
  })

  const fmtDate = (ms: number): string => new Date(ms).toLocaleString()

  return (
    <main className="service">
      <ContainerHeader
        title="Keycloak"
        onRefresh={() => refreshInfo(FRESH)} refreshTitle="Refresh — re-run the commands that check the Keycloak container"
        container={kc.containerName} image={kc.image}
        state={!info?.container || info.engineError ? 'unknown' : info.container.running ? 'running' : info.container.exists ? 'stopped' : 'missing'}
        stateLabel={info?.container?.exists && !info.container.running && info.container.status ? `stopped (${info.container.status})` : undefined}
        port={kc.httpPort}
        error={info?.engineError}
      />

      <div className="actions">
        {!running && (
          <button className="btn btn-primary" disabled={!info?.valid || !!busy} onClick={() => run('start', api.kcStart, () => void refreshInfo())} title={`${kc.image} start-dev (first run pulls the image)`}>
            {busy === 'start' ? 'Starting…' : '▶ Start'}
          </button>
        )}
        {running && <button className="btn btn-danger" disabled={!!busy || state?.status === 'stopping'} onClick={() => run('stop', api.kcStop, () => void refreshInfo())}>{busy === 'stop' ? 'Stopping…' : '■ Stop'}</button>}
        <button className="btn" disabled={!info?.valid || !!busy || state?.status === 'stopping'} onClick={() => run('restart', api.kcRestart, () => void refreshInfo())}>⟳ Restart</button>        <button className="btn" disabled={!info?.valid || !!busy} title="Deletes and recreates the container with the current image/folders/port from Settings (data stays on disk)"
          onClick={() => { if (confirm(`Recreate the container ${kc.containerName}? Data (H2) and providers stay on disk.`)) void run('recreate', api.kcRecreate, () => void refreshInfo()) }}>Recreate container</button>
        <span className="grow" />
        {links.map((l, i) => l.url && <button key={i} className="btn" onClick={() => api.openExternal(l.url)} title={l.url}>↗ {l.name || l.url}</button>)}
        <button className="btn" onClick={() => setEditLinks((v) => !v)} title="Add/edit test login links (per browser)">{editLinks ? 'Done' : '＋ Links'}</button>
        <button className="btn" onClick={() => api.openExternal(adminUrl)} title={adminUrl}>Admin console</button>
      </div>

      {editLinks && (
        <div className="config">
          <section>
            <div className="row"><span className="muted small">Test login links — name + URL (saved in this browser). Each project defines its own.</span></div>
            {links.map((l, i) => (
              <div className="row" key={i}>
                <input className="input" style={{ width: 160 }} placeholder="name (e.g. My portal)" value={l.name} onChange={(e) => saveLinks(links.map((x, j) => j === i ? { ...x, name: e.target.value } : x))} />
                <input className="input mono grow" placeholder="https://localhost:3001/login" value={l.url} onChange={(e) => saveLinks(links.map((x, j) => j === i ? { ...x, url: e.target.value } : x))} spellCheck={false} />
                <button className="btn btn-sm btn-ghost" title="remove" onClick={() => saveLinks(links.filter((_, j) => j !== i))}>✕</button>
              </div>
            ))}
            <div className="row"><button className="btn btn-sm" onClick={() => saveLinks([...links, { name: '', url: '' }])}>＋ Add link</button></div>
          </section>
        </div>
      )}
      {info && info.keycloakContainers.filter((c) => c.name !== kc.containerName).length > 0 && (
        <div className="actions">
          <span className="muted small">Other Keycloak containers found:</span>
          {info.keycloakContainers.filter((c) => c.name !== kc.containerName).map((c) => (
            <span key={c.name} className="row" style={{ gap: 6 }}>
              <span className="mono small">{c.name} <span className="muted">({c.image}, {c.state})</span></span>
              <button className="btn btn-sm" disabled={!!busy} onClick={() => onSaveSettings({ keycloak: { ...kc, containerName: c.name } })} title="Manage this container instead (providers/data are its own)">Use this</button>
            </span>
          ))}
        </div>
      )}

      <div className="tabs">
        <button className={tab === 'logs' ? 'active' : ''} onClick={() => setTab('logs')}>Logs</button>
        <button className={tab === 'providers' ? 'active' : ''} onClick={() => setTab('providers')}>
          Providers / SPIs {info?.providers.length ? <span className="count">{info.providers.length}</span> : null}
        </button>
        <button className={tab === 'admin' ? 'active' : ''} onClick={() => setTab('admin')}>Administration</button>
      </div>

      <div className="tab-body">
        {tab === 'logs' && <LogView lines={logs.get(KC_ID)} version={logs.version} onClear={() => logs.clear(KC_ID)} />}

        {tab === 'providers' && (
          <div className="config">
            <section>
              <h3 title={info?.providersDir}>mounted at <span className="mono">/opt/keycloak/providers</span></h3>
              {!info?.providers.length && <p className="muted">No providers installed.</p>}
              {info?.providers.map((p) => (
                <div className="row" key={p}>
                  <span className="mono grow">{p}</span>
                  <button
                    className="btn btn-sm btn-danger"
                    disabled={!!busy}
                    onClick={() => {
                      if (confirm(`Remove ${p} from providers/?`)) void run('remove', () => api.kcRemoveProvider(p), () => void refreshInfo())
                    }}
                  >
                    Remove
                  </button>
                </div>
              ))}
              {active && <p className="muted small">Changes in providers/ are only loaded after restarting Keycloak.</p>}
            </section>
            <section>
              <div className="row" style={{ flexWrap: 'wrap' }}>
                <h3 className="grow">SPI projects found in the scan</h3>
                <label className="inline">Install
                  <select className="input" value={installMode} onChange={(e) => setInstallMode(e.target.value as 'build' | 'existing')} title="Build: the app runs mvn package before copying. Existing jar: uses the jar already in target/ (e.g. compiled in IntelliJ)">
                    <option value="build">with build (mvn package)</option>
                    <option value="existing">pre-compiled jar (IntelliJ)</option>
                  </select>
                </label>
                <label className={`switch${restartAfter ? ' on' : ''}`} title="After copying the jar, restart Keycloak to load the provider">
                  <input type="checkbox" checked={restartAfter} onChange={(e) => setRestartAfter(e.target.checked)} />
                  <span className="switch-track"><span className="switch-knob" /></span>
                  <span className="switch-label">restart Keycloak afterwards</span>
                </label>
                <button className="btn btn-sm" disabled={!!busy} onClick={() => refreshJars()} title="re-read the jars in target/">⟳</button>
                {spis.length > 1 && <button className="btn btn-sm btn-primary" disabled={!info?.valid || !!busy} onClick={installAll}>{busy === 'deploy-all' ? 'Installing…' : `⇪ Install all (${spis.length})`}</button>}
              </div>
              {!spis.length && <p className="muted">No project with org.keycloak dependencies found.</p>}
              {spis.length > 0 && (
                <table className="grid spi-table">
                  <thead>
                    <tr><th>SPI</th><th>Version</th><th>State</th><th>Modified</th><th>Jar</th><th></th></tr>
                  </thead>
                  <tbody>
                    {spis.map((s) => {
                      const j = jars[s.id] ?? { candidates: [], installed: [] }
                      const selected = j.candidates.find((c) => c.name === chosenJar[s.id]) ?? j.candidates[0]
                      const inst = j.installed[0]
                      const ref = inst ?? selected // jar a mostrar nas colunas (instalado tem prioridade)
                      const ids = s.providerIds ?? []
                      const loaded = loadedIds ? ids.filter((id) => loadedIds.has(id)) : []
                      const state = loadedIds === null
                        ? <Badge tone="muted" title="connect in Administration to check">unknown</Badge>
                        : loaded.length ? <Badge tone="green" title={`loaded in Keycloak: ${loaded.join(', ')}`}>✓ loaded</Badge>
                        : j.installed.length ? <Badge tone="amber" title={`jar in providers/ but ${ids.join(', ') || 'provider'} not in serverinfo — restart Keycloak`}>installed, not loaded</Badge>
                        : <Badge tone="muted">not installed</Badge>
                      return (
                        <tr key={s.id}>
                          <td>
                            {s.name}
                            {ids.length > 0 && <div className="muted small mono">id: {ids.join(', ')}</div>}
                          </td>
                          <td className="mono small">{inst?.version ?? selected?.version ?? s.version ?? '—'}</td>
                          <td>{state}</td>
                          <td className="small muted">{ref ? fmtDate(ref.mtime) : '—'}</td>
                          <td className="mono small">
                            {inst ? (
                              <span title={`${inst.name} · ${fmtDate(inst.mtime)}`}>{inst.name}
                                <a className="link small" title="remove from providers/" onClick={() => { if (confirm(`Remove ${inst.name} from providers/?`)) void run('remove', () => api.kcRemoveProvider(inst.name), () => { void refreshInfo(); void refreshJars() }) }}> ✕</a>
                              </span>
                            ) : j.candidates.length > 1 ? (
                              <select className="input" value={selected?.name ?? ''} onChange={(e) => setChosenJar({ ...chosenJar, [s.id]: e.target.value })} title="several jars in target/ — choose the one to install">
                                {j.candidates.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
                              </select>
                            ) : j.candidates.length === 1 ? (
                              <span className="muted" title={`${fmtDate(j.candidates[0].mtime)} · ${Math.round(j.candidates[0].size / 1024)} KB`}>{j.candidates[0].name} <span className="muted">(target/)</span></span>
                            ) : <span className="text-error">no jar (build or compile)</span>}
                          </td>
                          <td className="cell-actions">
                            <button className="btn btn-sm btn-primary"
                              disabled={!info?.valid || !!busy || isActive(states[s.id]) || (installMode === 'existing' && !selected)}
                              onClick={() => install(s.id, s.name)}
                              title={installMode === 'build' ? 'mvn package + copy the newest jar to providers' : `copy ${selected?.name ?? ''} to providers`}>
                              {busy === `deploy:${s.id}` ? 'Installing…' : installMode === 'build' ? '⇪ Build & install' : '⇪ Install'}
                            </button>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              )}
            </section>
          </div>
        )}

        {tab === 'admin' && <KcAdminPanel running={running} fail={fail} notify={notify} />}
      </div>
    </main>
  )
}
