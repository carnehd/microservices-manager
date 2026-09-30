import { useCallback, useEffect, useState } from 'react'
import type { AppSettings, JarInfo, KeycloakInfo, ProcState, ScanResult } from '../../../shared/types'
import { api } from '../api'
import type { LogsApi } from '../hooks'
import { KcAdminPanel } from './KcAdminPanel'
import { LogView } from './LogView'
import { Badge, StatusPill, isActive } from './common'

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
  const state = states[KC_ID]
  const kc = settings.keycloak
  // o estado é o do container (o processo "keycloak" da app é só o podman logs -f)
  const running = !!info?.container?.running
  const active = running || isActive(state)
  const adminUrl = `http://localhost:${kc.httpPort}/admin/`

  const refreshInfo = useCallback(() => api.kcInfo().then(setInfo).catch(fail), [fail])
  const loadLogs = logs.load
  useEffect(() => {
    void refreshInfo()
    void loadLogs(KC_ID)
  }, [kc.containerName, kc.image, refreshInfo, loadLogs])
  useEffect(() => {
    if (!active) void refreshInfo() // depois de build/deploy a lista de providers pode ter mudado
  }, [active, refreshInfo])
  useEffect(() => {
    const t = setInterval(() => void refreshInfo(), 5000)
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
    notify(`${r.dest.split(/[\\/]/).pop()} instalado${r.removed.length ? ` (substituiu ${r.removed.join(', ')})` : ''}${r.restarted ? '; Keycloak reiniciado' : ' — reinicia o Keycloak para o carregar'}`, 'success')
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
    notify(`${spis.length} SPI(s) instalados${restartAfter ? '; Keycloak reiniciado' : ''}`, 'success')
  })

  const fmtDate = (ms: number): string => new Date(ms).toLocaleString()

  return (
    <main className="service">
      <div className="svc-header">
        <div className="grow">
          <h2>Keycloak</h2>
          <div className="muted mono small">
            🐳 container <b>{kc.containerName}</b> · {kc.image}
            {info?.container && <> · {info.container.running ? 'a correr' : info.container.exists ? `parado (${info.container.status ?? ''})` : 'ainda não criado'}</>}
            {info?.engineError && <span className="text-error"> · {info.engineError}</span>}
            {' '}· porta {kc.httpPort} · admin <b>{kc.adminUser}</b>
          </div>
        </div>
        <StatusPill state={state} port={kc.httpPort} />
      </div>

      <div className="actions">
        {!running && (
          <button className="btn btn-primary" disabled={!info?.valid || !!busy} onClick={() => run('start', api.kcStart, () => void refreshInfo())} title={`${kc.image} start-dev (a primeira vez faz pull da imagem)`}>
            {busy === 'start' ? 'A arrancar…' : '▶ Arrancar'}
          </button>
        )}
        {running && <button className="btn btn-danger" disabled={!!busy || state?.status === 'stopping'} onClick={() => run('stop', api.kcStop, () => void refreshInfo())}>{busy === 'stop' ? 'A parar…' : '■ Parar'}</button>}
        <button className="btn" disabled={!info?.valid || !!busy || state?.status === 'stopping'} onClick={() => run('restart', api.kcRestart, () => void refreshInfo())}>⟳ Reiniciar</button>
        <button className="btn" disabled={!info?.valid || !!busy} title="Apaga e cria de novo o container com a imagem/pastas/porta atuais das Definições (os dados ficam no disco)"
          onClick={() => { if (confirm(`Recriar o container ${kc.containerName}? Os dados (H2) e providers ficam no disco.`)) void run('recreate', api.kcRecreate, () => void refreshInfo()) }}>Recriar container</button>
        <span className="grow" />
        <button className="btn" onClick={() => api.openExternal(adminUrl)} title={adminUrl}>Consola de administração</button>
      </div>
      {info && info.keycloakContainers.filter((c) => c.name !== kc.containerName).length > 0 && (
        <div className="actions">
          <span className="muted small">Outros containers Keycloak encontrados:</span>
          {info.keycloakContainers.filter((c) => c.name !== kc.containerName).map((c) => (
            <span key={c.name} className="row" style={{ gap: 6 }}>
              <span className="mono small">{c.name} <span className="muted">({c.image}, {c.state})</span></span>
              <button className="btn btn-sm" disabled={!!busy} onClick={() => onSaveSettings({ keycloak: { ...kc, containerName: c.name } })} title="Passar a gerir este container (os providers/dados são os dele)">Usar este</button>
            </span>
          ))}
        </div>
      )}

      <div className="tabs">
        <button className={tab === 'logs' ? 'active' : ''} onClick={() => setTab('logs')}>Logs</button>
        <button className={tab === 'providers' ? 'active' : ''} onClick={() => setTab('providers')}>
          Providers / SPIs {info?.providers.length ? <span className="count">{info.providers.length}</span> : null}
        </button>
        <button className={tab === 'admin' ? 'active' : ''} onClick={() => setTab('admin')}>Administração</button>
      </div>

      <div className="tab-body">
        {tab === 'logs' && <LogView lines={logs.get(KC_ID)} version={logs.version} onClear={() => logs.clear(KC_ID)} />}

        {tab === 'providers' && (
          <div className="config">
            <section>
              <h3>Instalados em <span className="mono">{info?.providersDir}</span><span className="muted"> (montada em /opt/keycloak/providers)</span></h3>
              {!info?.providers.length && <p className="muted">Nenhum provider instalado.</p>}
              {info?.providers.map((p) => (
                <div className="row" key={p}>
                  <span className="mono grow">{p}</span>
                  <button
                    className="btn btn-sm btn-danger"
                    disabled={!!busy}
                    onClick={() => {
                      if (confirm(`Remover ${p} de providers/?`)) void run('remove', () => api.kcRemoveProvider(p), () => void refreshInfo())
                    }}
                  >
                    Remover
                  </button>
                </div>
              ))}
              {active && <p className="muted small">Alterações em providers/ só são carregadas depois de reiniciar o Keycloak.</p>}
            </section>
            <section>
              <div className="row" style={{ flexWrap: 'wrap' }}>
                <h3 className="grow">Projetos SPI encontrados no scan</h3>
                <label className="inline">Instalar
                  <select className="input" value={installMode} onChange={(e) => setInstallMode(e.target.value as 'build' | 'existing')} title="Build: a app corre mvn package antes de copiar. Jar existente: usa o jar que já está em target/ (ex.: compilado no IntelliJ)">
                    <option value="build">com build (mvn package)</option>
                    <option value="existing">jar já compilado (IntelliJ)</option>
                  </select>
                </label>
                <label className={`switch${restartAfter ? ' on' : ''}`} title="Depois de copiar o jar, reinicia o Keycloak para carregar o provider">
                  <input type="checkbox" checked={restartAfter} onChange={(e) => setRestartAfter(e.target.checked)} />
                  <span className="switch-track"><span className="switch-knob" /></span>
                  <span className="switch-label">reiniciar o Keycloak depois</span>
                </label>
                <button className="btn btn-sm" disabled={!!busy} onClick={() => refreshJars()} title="reler os jars em target/">⟳</button>
                {spis.length > 1 && <button className="btn btn-sm btn-primary" disabled={!info?.valid || !!busy} onClick={installAll}>{busy === 'deploy-all' ? 'A instalar…' : `⇪ Instalar todos (${spis.length})`}</button>}
              </div>
              {!spis.length && <p className="muted">Nenhum projeto com dependências org.keycloak encontrado.</p>}
              {spis.map((s) => {
                const j = jars[s.id] ?? { candidates: [], installed: [] }
                const selected = j.candidates.find((c) => c.name === chosenJar[s.id]) ?? j.candidates[0]
                return (
                  <div className="row spi-row" key={s.id}>
                    <div className="grow">
                      <div>
                        {s.name} <span className="muted small mono">{s.relativePath}</span>
                        {(() => {
                          const ids = s.providerIds ?? []
                          if (!ids.length) return null
                          if (loadedIds === null) return <span className="muted small"> · estado desconhecido (liga a Administração)</span>
                          const loaded = ids.filter((id) => loadedIds.has(id))
                          if (loaded.length) return <Badge tone="green" title={`carregado no Keycloak: ${loaded.join(', ')}`}>✓ carregado</Badge>
                          if (j.installed.length) return <Badge tone="amber" title={`jar em providers/ mas ${ids.join(', ')} não aparece no serverinfo — reinicia o Keycloak`}>instalado, não carregado</Badge>
                          return <Badge tone="muted" title={ids.join(', ')}>não instalado</Badge>
                        })()}
                      </div>
                      <div className="muted small mono">{s.spiProviders.map((p) => p.split('.').pop()).join(', ') || 'sem META-INF/services'}{s.providerIds?.length ? ` · id: ${s.providerIds.join(', ')}` : ''}</div>
                      <div className="small">
                        <span className="muted">instalado: </span>
                        {j.installed.length ? j.installed.map((i) => (
                          <span key={i.name} className="mono" title={`${i.name} · ${fmtDate(i.mtime)}`}>
                            <Badge tone="green">{i.version ?? i.name}</Badge>
                            <a className="link small" onClick={() => { if (confirm(`Remover ${i.name} de providers/?`)) void run('remove', () => api.kcRemoveProvider(i.name), () => { void refreshInfo(); void refreshJars() }) }}> ✕</a>{' '}
                          </span>
                        )) : <span className="muted">nenhuma versão</span>}
                      </div>
                      <div className="small row" style={{ padding: 0 }}>
                        <span className="muted">em target/: </span>
                        {!j.candidates.length && <span className="text-error mono">sem jar (compila no IntelliJ ou usa "com build")</span>}
                        {j.candidates.length === 1 && <span className="mono muted">{j.candidates[0].name} · {fmtDate(j.candidates[0].mtime)} · {Math.round(j.candidates[0].size / 1024)} KB</span>}
                        {j.candidates.length > 1 && (
                          <select className="input" value={selected?.name ?? ''} onChange={(e) => setChosenJar({ ...chosenJar, [s.id]: e.target.value })} title="várias versões em target/ — escolhe a que queres instalar">
                            {j.candidates.map((c) => <option key={c.name} value={c.name}>{c.version ?? c.name} · {fmtDate(c.mtime)} · {Math.round(c.size / 1024)} KB</option>)}
                          </select>
                        )}
                      </div>
                    </div>
                    <button
                      className="btn btn-sm btn-primary"
                      disabled={!info?.valid || !!busy || isActive(states[s.id]) || (installMode === 'existing' && !selected)}
                      onClick={() => install(s.id, s.name)}
                      title={installMode === 'build' ? 'mvn package + copiar o jar mais recente para providers' : `copiar ${selected?.name ?? ''} para providers`}
                    >
                      {busy === `deploy:${s.id}` ? 'A instalar…' : installMode === 'build' ? '⇪ Build & instalar' : `⇪ Instalar ${selected?.version ?? 'jar'}`}
                    </button>
                  </div>
                )
              })}
            </section>
          </div>
        )}

        {tab === 'admin' && <KcAdminPanel running={running} fail={fail} notify={notify} />}
      </div>
    </main>
  )
}
